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
  const blobManager = new FSBlob();
  const opfs = blobManager.opfsManager;
  if (!opfs) {
    // No OPFS available (unsupported or setup failed): keep the old
    // accumulate-in-memory behavior rather than failing outright.
    return createWriteStreamBlobMemory(filename, opts, size, blobManager);
  }

  const identifier = 'save-' + Date.now() + '-' + (saveCounter++);
  const opfsWriterReady = opfs.saveBegin(identifier);

  return new WritableStream({
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
      await opfsWriterReady;
      await opfs.saveEnd(identifier);
      const file = await opfs.getSavedFile(identifier);
      const url = URL.createObjectURL(file);
      try {
        await Utils.downloadURL(url, filename);
      } catch (e) {
        URL.revokeObjectURL(url);
        throw e;
      }
      // chrome.downloads resolves once the transfer STARTS; the OPFS file
      // (not the blob URL) backs the rest of the transfer. Defer closing
      // the worker the same way mp4merger.mjs's destroy() does, so a slow
      // transfer still has time to finish reading from the OPFS-backed
      // file before its session is torn down.
      URL.revokeObjectURL(url);
      setTimeout(() => {
        blobManager.close();
      }, 120000);
    },
    async abort() {
      await opfsWriterReady.catch(() => {});
      await opfs.saveAbort(identifier).catch(() => {});
      blobManager.close();
    },
  }, opts.writableStrategy);
}

/**
 * Memory-fallback variant of the OPFS save stream, for environments without
 * OPFS (and for the web build, where service workers may or may not exist).
 * Kept as close to the original upstream behavior as possible.
 * @param {string} filename
 * @param {object} opts
 * @param {number} size deprecated
 * @param {FSBlob} blobManager
 * @return {WritableStream<Uint8Array>}
 */
function createWriteStreamBlobMemory(filename, opts, size, blobManager) {
  const blobs = [];
  return new WritableStream({
    write(chunk) {
      blobs.push(blobManager.createBlob(chunk));
    },
    async close() {
      const chunks = await Promise.all(blobs.map((blob) => blobManager.getBlob(blob)));
      const blob = new Blob(chunks, {type: 'application/octet-stream'});
      const url = URL.createObjectURL(blob);
      await Utils.downloadURL(url, filename);
      URL.revokeObjectURL(url);

      setTimeout(() => {
        blobManager.close();
      }, 120000);
    },
    async abort() {
      blobs.length = 0;
      await blobManager.clear();
    },
  }, opts.writableStrategy);
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
