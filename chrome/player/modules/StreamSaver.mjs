import {Utils} from '../utils/Utils.mjs';
import {FSBlob} from './FSBlob.mjs';

/* ! streamsaver. MIT License. Jimmy Wärting <https://jimmy.warting.se/opensource> */
export const streamSaver = {
  createWriteStream,
};

// Ensures two saves started in the same millisecond never share an OPFS
// identifier - Math.random() alone left a real (if small) chance of two
// concurrent saves colliding on one file and corrupting both.
let saveCounter = 0;

function createWriteStreamBlob(filename, opts, size) {
  // Firefox extension pages have no ServiceWorker (navigator.serviceWorker
  // is undefined on moz-extension://), so the "streaming" transport is
  // unavailable there and this fallback IS the real path for every streamed
  // save (accelerated MP4, DIRECT webm, archive dumps). It used to
  // accumulate every chunk as an in-RAM Blob plus an OPFS copy, then
  // assemble a second full copy with new Blob(chunks) - a several-GB spike
  // for a several-hundred-MB video, which froze the tab and looked like the
  // save never happened. Instead: write chunks progressively into ONE OPFS
  // file (disk-backed, flat memory), then hand the download a disk-backed
  // File. mp4merger.mjs's finalize() does the same via OPFSManager.

  // Which of the two sinks below this uses can only be decided once the blob
  // store's backend has finished setting up. Reading blobManager.opfsManager
  // synchronously here used to pick OPFS in a Firefox private window - where
  // getDirectory() is present and throws - and every write() then rejected
  // instead of falling back, so saving was dead in private windows rather
  // than merely slower.
  // The blob store itself is made then too: a save that failed before its first
  // write (a direct download's bad status code) left one, with its OPFS worker
  // and heartbeat, running until the tab closed.
  let sinkPromise = null;
  const getSink = () => {
    if (!sinkPromise) {
      const blobManager = new FSBlob();
      sinkPromise = blobManager.ready().then((ready) =>
        ready && blobManager.opfsManager ?
          createOPFSSink(filename, blobManager) :
          createMemorySink(filename, blobManager));
    }
    return sinkPromise;
  };

  return new WritableStream({
    async write(chunk) {
      await (await getSink()).write(chunk);
    },
    async close() {
      await (await getSink()).close();
    },
    async abort() {
      // Nothing was written, so there is nothing to undo.
      if (sinkPromise) {
        await (await sinkPromise).abort();
      }
    },
  }, opts.writableStrategy);
}

/**
 * Revokes a save's URL and closes its blob store once its download is over. Firefox reads
 * the file from the store's OPFS session as it downloads it, and a closed session is
 * deleted by the next prune (any player or save starting, 10 s after its last heartbeat):
 * closed on a fixed two-minute timer, a longer download (a big video to a slow disk) lost
 * its file midway, with no message. Never sooner than those two minutes, which is all a
 * download without an id to follow (a link click) has.
 * @param {FSBlob} blobManager
 * @param {string} url - The blob: URL being downloaded.
 * @param {*} download - What Utils.downloadURL resolved with.
 * @return {Promise<void>} Not awaited: the save is done before its download is.
 */
async function closeWhenDownloaded(blobManager, url, download) {
  await Promise.all([
    Utils.revokeWhenDownloaded(url, download),
    Utils.asyncTimeout(120000),
  ]);
  blobManager.close();
}

/**
 * Progressive, disk-backed sink: every chunk is appended to one OPFS file and
 * the finished file goes to the download as a File, so RAM stays flat no
 * matter the video size.
 * @param {string} filename
 * @param {FSBlob} blobManager one whose OPFS backend is live
 * @return {{write: Function, close: Function, abort: Function}}
 */
function createOPFSSink(filename, blobManager) {
  const opfs = blobManager.opfsManager;
  const identifier = 'save-' + Date.now() + '-' + (saveCounter++);
  const opfsWriterReady = opfs.saveBegin(identifier);

  return {
    async write(chunk) {
      await opfsWriterReady;
      // Copy into a fresh, transferable ArrayBuffer: chunks may be views
      // (byteOffset/byteLength != whole buffer), and saveAppend transfers
      // the underlying buffer.
      const copy = chunk.buffer.slice(
          chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
      await opfs.saveAppend(identifier, new Uint8Array(copy));
    },
    async close() {
      let url = null;
      let download;
      try {
        await opfsWriterReady;
        await opfs.saveEnd(identifier);
        const file = await opfs.getSavedFile(identifier);
        url = URL.createObjectURL(file);
        download = await Utils.downloadURL(url, filename);
      } catch (e) {
        // Nothing will read the file: it goes now, with its session, as on
        // abort(). The worker and its heartbeat ran until the tab closed.
        if (url) {
          URL.revokeObjectURL(url);
        }
        await opfs.saveAbort(identifier).catch(() => {});
        blobManager.close();
        throw e;
      }
      // chrome.downloads resolves before Firefox has read the blob URL: kept until the
      // download is over (revokeWhenDownloaded), and the OPFS file behind it too.
      closeWhenDownloaded(blobManager, url, download);
    },
    async abort() {
      await opfsWriterReady.catch(() => {});
      await opfs.saveAbort(identifier).catch(() => {});
      blobManager.close();
    },
  };
}

const MEMORY_SINK_PENDING = 8;

/**
 * Memory-fallback sink, for environments without OPFS (a Firefox private
 * window, and the web build where service workers may or may not exist).
 * Kept as close to the original upstream behavior as possible.
 * @param {string} filename
 * @param {FSBlob} blobManager
 * @return {{write: Function, close: Function, abort: Function}}
 */
function createMemorySink(filename, blobManager) {
  const blobs = [];
  // Chunks the blob store is still moving to disk. write() used to return at
  // once, so a fast producer (a direct download read as fast as the network
  // gives it) had the whole file in RAM as Blobs before the Cache backend took
  // them; it now waits once MEMORY_SINK_PENDING are on their way.
  const pending = [];
  return {
    async write(chunk) {
      const identifier = blobManager.createBlob(chunk);
      blobs.push(identifier);
      pending.push(blobManager.whenStored(identifier));
      if (pending.length >= MEMORY_SINK_PENDING) {
        await pending.shift();
      }
    },
    async close() {
      let url = null;
      let download;
      try {
        const chunks = await Promise.all(blobs.map((blob) => blobManager.getBlob(blob)));
        const blob = new Blob(chunks, {type: 'application/octet-stream'});
        url = URL.createObjectURL(blob);
        download = await Utils.downloadURL(url, filename);
      } catch (e) {
        // Nothing will read the file, as in the OPFS sink: the URL kept the whole video in
        // memory, and the store its worker, until the tab closed.
        if (url) {
          URL.revokeObjectURL(url);
        }
        await blobManager.clear().catch(() => {});
        blobManager.close();
        throw e;
      }
      closeWhenDownloaded(blobManager, url, download);
    },
    async abort() {
      blobs.length = 0;
      await blobManager.clear();
      blobManager.close();
    },
  };
}

/**
 * Creates a WritableStream that saves its input to disk.
 *
 * This used to branch on a MessageChannel/ServiceWorker "streaming"
 * transport, borrowed from streamsaver.js. That transport requires a
 * ServiceWorker in the same page, which no current build target has -
 * Firefox extension pages don't expose one (navigator.serviceWorker is
 * undefined on moz-extension://) and neither does a plain web page (no
 * `chrome.extension` for EnvUtils.isExtension() to find). It had already
 * been dead code since 9ef061b1 moved every streamed save onto the OPFS
 * blob fallback below; removed rather than fixed the ReferenceErrors
 * (`fn`/`sw` were never declared) it had picked up along the way, since
 * nothing could reach them to notice.
 *
 * @param  {string} filename filename that should be used
 * @param  {object} options  [description]
 * @param  {number} size     deprecated
 * @return {WritableStream<Uint8Array>}
 */
function createWriteStream(filename, options, size) {
  return createWriteStreamBlob(filename, options || {}, size);
}
