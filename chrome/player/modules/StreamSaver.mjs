import {EnvUtils} from '../utils/EnvUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {FSBlob} from './FSBlob.mjs';

/* ! streamsaver. MIT License. Jimmy Wärting <https://jimmy.warting.se/opensource> */
export const streamSaver = {
  createWriteStream,
};

const useBlobFallback = !EnvUtils.isExtension() || navigator.serviceWorker === undefined;

function getServiceWorker() {
  return navigator.serviceWorker.getRegistration('./').then((swReg) => {
    const swRegTmp = swReg.installing || swReg.waiting;

    return swReg.active || new Promise((resolve) => {
      swRegTmp.addEventListener('statechange', fn = () => {
        if (swRegTmp.state === 'activated') {
          swRegTmp.removeEventListener('statechange', fn);
          sw = swReg.active;
          resolve();
        }
      });
    });
  });
};

function makeIframe(src) {
  if (!src) throw new Error('meh');
  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  iframe.src = src;
  iframe.loaded = false;
  iframe.name = 'iframe';
  iframe.isIframe = true;
  iframe.postMessage = (...args) => iframe.contentWindow.postMessage(...args);
  iframe.addEventListener('load', () => {
    iframe.loaded = true;
  }, {once: true});
  document.body.appendChild(iframe);
  return iframe;
}

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

  const identifier = 'save-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
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
      // (not the blob URL) backs the rest of the transfer, and the session
      // is reaped by prune() once its heartbeat goes stale.
      URL.revokeObjectURL(url);
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
     * @param  {string} filename filename that should be used
     * @param  {object} options  [description]
     * @param  {number} size     deprecated
     * @return {WritableStream<Uint8Array>}
     */
function createWriteStream(filename, options, size) {
  const opts = options || {};
  if (useBlobFallback) {
    return createWriteStreamBlob(filename, opts, size);
  }

  let channel = null;
  let ts = null;

  channel = new MessageChannel();

  // Make filename RFC5987 compatible
  filename = encodeURIComponent(filename.replace(/\//g, ':'))
      .replace(/['()]/g, escape)
      .replace(/\*/g, '%2A');

  const response = {
    filename: filename,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + filename,
    },
  };

  if (opts.size) {
    response.headers['Content-Length'] = opts.size;
  }

  const args = [response, [channel.port2]];

  const transformer = undefined;
  ts = new TransformStream(
      transformer,
      opts.writableStrategy,
      opts.readableStrategy,
  );
  const readableStream = ts.readable;

  channel.port1.postMessage({readableStream}, [readableStream]);


  channel.port1.onmessage = (evt) => {
    // Service worker sent us a link that we should open.
    if (evt.data.download) {
      makeIframe(evt.data.download);
    } else if (evt.data.abort) {
      channel.port1.postMessage('abort'); // send back so controller is aborted
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
      channel = null;
    } else if (evt.data.close) {
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
      channel = null;
    }
  };

  getServiceWorker().then((sw)=>{
    sw.postMessage(...args);
  });
  return ts.writable;
}
