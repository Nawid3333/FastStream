// @ts-check
import {DownloadStatus} from '../enums/DownloadStatus.mjs';
import {BlobManager} from '../utils/BlobManager.mjs';
import {Utils} from '../utils/Utils.mjs';

// What getDataFromBlob throws when the stored data is not there at all.
const DATA_GONE = new Error('The stored download is gone');

export class DownloadEntry {
  constructor(details) {
    this.status = DownloadStatus.WAITING;
    this.priority = 0;

    this.url = details.url;
    this.rangeStart = details.rangeStart;
    this.rangeEnd = details.rangeEnd;
    this.responseType = details.responseType;

    this.headers = details.headers;
    this.storeRaw = details.storeRaw;

    this.config = details.config || {};

    this.preProcessor = details.preProcessor;
    this.postProcessor = details.postProcessor;

    this.data = null;
    this.dataSize = 0;
    this.responseHeaders = null;
    // The HTTP status of the answer (FetchLoader): 200 to a range request is the whole file.
    this.responseStatus = 0;

    this.downloader = null;
    this.watchers = [];
    this.transferFile = null;

    this.responseURL = null;

    // Told when its stored data cannot be read any more (getDataFromBlob): the download
    // manager drops the entry then, so it is downloaded again.
    /** @type {((error: *) => void)|null} */
    this.onDataLost = null;
  }

  addWatcher(watcher) {
    this.watchers.push(watcher);
  }

  removeWatcher(watcher) {
    const ind = this.watchers.indexOf(watcher);
    if (ind != -1) this.watchers.splice(ind, 1);
  }

  /**
   * A watcher gives up on the download; the last one to do so aborts it. A watcher that is no
   * longer here was already told how the download ended (the watchers go once it is over), or
   * gave up before: its abort is too late. It told it "aborted" after "done", and aborted the
   * finished entry - a stored fragment marked failed, and downloaded again.
   * @param {Object} watcher
   */
  abortWatcher(watcher) {
    if (!this.watchers.includes(watcher)) return;
    this.removeWatcher(watcher);
    if (this.watchers.length === 0) {
      if (watcher.callbacks.onAbort) watcher.callbacks.onAbort(this);
      this.abort();
    }
  }

  abort() {
    this.status = DownloadStatus.DOWNLOAD_FAILED;
    this.aborted = true;
    if (this.downloader) {
      this.downloader.abort();
    } else {
      this.onAbort();
    }
    this.cleanup();
  }

  cleanup() {
    this.postProcessor = null;
    this.preProcessor = null;
    this.downloader = null;
    this.transferFile = null;
    this.watchers.length = 0;
  }

  destroy() {
    this.abort();
  }

  async getRequest() {
    const request = {
      url: this.url,
      rangeStart: this.rangeStart,
      rangeEnd: this.rangeEnd,
      responseType: this.responseType,
      headers: this.headers,
    };
    if (this.preProcessor) {
      try {
        return await this.preProcessor(this, request);
      } catch (e) {
        console.error('Error in preProcessor:', e);
        throw e;
      }
    }
    return request;
  }

  async onSuccess(response, stats, entry, xhr) {
    if (!this.downloader) {
      console.error('DownloadEntry.onSuccess called after abort');
    }

    this.responseHeaders = response.headers;
    this.responseStatus = response.status || 0;

    try {
      if (this.postProcessor) {
        response = await this.postProcessor(this, response);
      }
    } catch (e) {
      console.error(e);
      this.status = DownloadStatus.DOWNLOAD_FAILED;
      this.notifyWatchers('onFail', this);
      this.cleanup();
      return;
    }

    if (this.status !== DownloadStatus.DOWNLOAD_INITIATED) return; // abort was called


    this.status = DownloadStatus.DOWNLOAD_COMPLETE;
    const mimeType = this.responseType === 'arraybuffer' ? 'application/octet-stream' : 'text/plain';

    const data = this.storeRaw ? response.data : BlobManager.createBlob([response.data], mimeType);
    this.dataSize = Utils.getDataByteSize(data);

    this.data = data;

    this.stats = stats;
    this.responseURL = response.url;

    this.notifyWatchers('onSuccess', this, xhr);

    if (this.transferFile) {
      this.transferFile(this);
    }
    this.cleanup();
  }

  setTransferFunction(transferFile) {
    this.transferFile = transferFile;
  }

  onFail(stats, entry, xhr) {
    this.status = DownloadStatus.DOWNLOAD_FAILED;
    this.stats = stats;

    this.notifyWatchers('onFail', this);
    this.cleanup();
  }

  onAbort(stats) {
    if (stats) this.stats = stats;
    this.status = DownloadStatus.DOWNLOAD_FAILED;

    this.notifyWatchers('onAbort', this);
    this.cleanup();
  }

  /**
   * Calls one callback of every watcher. A watcher that throws is logged, and neither
   * keeps the others from hearing nor the entry from being cleaned up: the downloader
   * would otherwise never be freed, and a save waiting on the same entry never answered.
   * @param {string} name - The callback, e.g. 'onSuccess'.
   * @param {...*} args - Its arguments.
   */
  notifyWatchers(name, ...args) {
    this.watchers.forEach((watcher) => {
      try {
        watcher.callbacks[name]?.(...args);
      } catch (e) {
        console.error(`A download watcher's ${name} threw:`, e);
      }
    });
  }

  onProgress(stats, context, data, xhr) {
    this.watchers.forEach((watcher) => {
      if (watcher.callbacks.onProgress) {
        watcher.callbacks.onProgress(stats, context, data, xhr);
      }
    });
  }

  async getData() {
    return typeof this.data === 'function' ? await this.data() : this.data;
  }

  /**
   * The stored data, as the type asked for. Data that was stored and can no longer be read
   * (an OPFS file deleted or rewritten under its File - a File from getFile() reads the
   * file as it is on disk now -, a Cache API entry that went) is reported to onDataLost,
   * which drops this entry, so the fragment is downloaded again when it is next asked for
   * instead of failing the same way every time.
   * @param {string} [type] - 'arraybuffer' or text; the response type by default.
   * @return {Promise<ArrayBuffer|string>}
   */
  async getDataFromBlob(type) {
    // Anything but arraybuffer is read as text (BlobManager), as with no type at all.
    const as = type || this.responseType || 'text';
    try {
      const data = await this.getData();
      if (data === undefined || data === null) {
        throw DATA_GONE;
      }
      return await BlobManager.getDataFromBlob(data, as);
    } catch (e) {
      // Only storage that lost it: data that is not there, or the browser refusing to read
      // it (a DOMException: NotFoundError, NotReadableError, AbortError for a File whose
      // file went). A mistake in reading it (a TypeError) would fail the same way after
      // a new download, and dropping it each time would download it over and over.
      if (this.status === DownloadStatus.DOWNLOAD_COMPLETE && (e === DATA_GONE || e instanceof DOMException)) {
        this.onDataLost?.(e);
      }
      throw e;
    }
  }

  getDataSize() {
    return this.dataSize;
  }

  // debug
  async downloadFile() {
    const data = await this.getData();

    // if it's a blob, convert it to a URL
    if (data instanceof Blob) {
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = this.url.split('/').pop() || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      const a = document.createElement('a');
      a.href = 'data:application/octet-stream;base64,' + btoa(data);
      a.download = this.url.split('/').pop() || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }
}
