// @ts-check
import {DownloadStatus} from '../enums/DownloadStatus.mjs';
import {BlobManager} from '../utils/BlobManager.mjs';
import {Utils} from '../utils/Utils.mjs';

const DATA_GONE = new Error('The stored download is gone');

/** @typedef {import('./FetchLoader.mjs').LoaderStats} LoaderStats */
/** @typedef {import('./FetchLoader.mjs').LoaderResponse} LoaderResponse */

/**
 * @typedef {{url: string, rangeStart?: number, rangeEnd?: number, responseType?: string,
 *   headers?: Object<string, string>}} DownloadRequest
 */

/** @typedef {Partial<import('./FetchLoader.mjs').LoaderConfig> & Object<string, *>} DownloadConfig */

/**
 * @typedef {DownloadRequest & {storeRaw?: boolean, config?: DownloadConfig|null,
 *   preProcessor?: (entry: DownloadEntry, request: DownloadRequest) => Promise<DownloadRequest>,
 *   postProcessor?: (entry: DownloadEntry, response: LoaderResponse) => Promise<LoaderResponse>}} DownloadDetails
 */

/**
 * @typedef {{onSuccess: (entry: DownloadEntry, xhr?: null) => void,
 *   onProgress?: (stats: LoaderStats, request: DownloadRequest, data: ArrayBuffer|string, xhr: null) => void,
 *   onFail?: (entry: DownloadEntry) => void, onAbort?: (entry: DownloadEntry) => void,
 *   onChunk?: (chunk: Uint8Array, offset: number, answer: import('./FetchLoader.mjs').PartialAnswer) => void}} DownloadCallbacks
 */

/**
 * @typedef {{entry: DownloadEntry, priority?: number, abort: () => void, callbacks: DownloadCallbacks}} DownloadWatcher
 */

export class DownloadEntry {
  /** @param {DownloadDetails} details */
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

    /** @type {DownloadDetails['preProcessor']|null} */
    this.preProcessor = details.preProcessor;
    /** @type {DownloadDetails['postProcessor']|null} */
    this.postProcessor = details.postProcessor;

    /** @type {string|ArrayBuffer|Uint8Array|Blob|null|(() => ReturnType<import('../modules/FSBlob.mjs').FSBlob['getBlob']>)} */
    this.data = null;
    this.dataSize = 0;
    /** @type {Object<string, string>|null} */
    this.responseHeaders = null;
    // The HTTP status of the answer (FetchLoader): 200 to a range request is the whole file.
    this.responseStatus = 0;

    /** @type {import('./StandardDownloader.mjs').StandardDownloader|null} */
    this.downloader = null;
    /** @type {DownloadWatcher[]} */
    this.watchers = [];
    /** @type {((entry: DownloadEntry) => void)|null} */
    this.transferFile = null;

    this.responseURL = null;

    // Where the store keeps its data when not under its identifier: a handed-over download (adopt).
    /** @type {?string} */
    this.blobId = null;

    /** @type {((error: *) => void)|null} */
    this.onDataLost = null;

    /** @type {?Array<{chunk: Uint8Array, offset: number, answer: import('./FetchLoader.mjs').PartialAnswer}>} */
    this.pieces = null;
    /** @type {?WeakSet<DownloadWatcher>} */
    this.catchingUp = null;
  }

  /**
   * One that comes in on the way gets the pieces so far a task later, in order.
   * @param {DownloadWatcher} watcher
   */
  addWatcher(watcher) {
    this.watchers.push(watcher);
    if (this.pieces?.length && watcher.callbacks.onChunk) {
      (this.catchingUp ??= new WeakSet()).add(watcher);
      queueMicrotask(() => {
        this.catchingUp?.delete(watcher);
        for (const {chunk, offset, answer} of this.pieces || []) {
          if (!this.watchers.includes(watcher)) return;
          this.tellChunk(watcher, chunk, offset, answer);
        }
      });
    }
  }

  /**
   * Not for a download processed before it is stored: its pieces are not what the watchers get.
   * @param {Uint8Array} chunk
   * @param {number} offset - 0 starts it over (a retry).
   * @param {import('./FetchLoader.mjs').PartialAnswer} answer
   */
  onChunk(chunk, offset, answer) {
    if (this.postProcessor || this.storeRaw || this.status !== DownloadStatus.DOWNLOAD_INITIATED) return;
    if (offset === 0 || !this.pieces) this.pieces = [];
    this.pieces.push({chunk, offset, answer});
    [...this.watchers].forEach((watcher) => {
      if (!this.catchingUp?.has(watcher)) this.tellChunk(watcher, chunk, offset, answer);
    });
  }

  /**
   * @param {DownloadWatcher} watcher
   * @param {Uint8Array} chunk
   * @param {number} offset
   * @param {import('./FetchLoader.mjs').PartialAnswer} answer
   */
  tellChunk(watcher, chunk, offset, answer) {
    try {
      watcher.callbacks.onChunk?.(chunk, offset, answer);
    } catch (e) {
      console.error('A download watcher\'s onChunk threw:', e);
    }
  }

  /** @param {DownloadWatcher} watcher */
  removeWatcher(watcher) {
    const ind = this.watchers.indexOf(watcher);
    if (ind !== -1) this.watchers.splice(ind, 1);
  }

  /**
   * The last watcher to give up aborts it; one already gone is too late to abort.
   * @param {DownloadWatcher} watcher
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
    this.pieces = null;
  }

  destroy() {
    this.abort();
  }

  /** @return {Promise<DownloadRequest>} */
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

  /**
   * @param {import('./FetchLoader.mjs').LoaderResponse} response
   * @param {LoaderStats} stats
   * @param {DownloadEntry} entry
   * @param {null} xhr
   */
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

    if (this.status !== DownloadStatus.DOWNLOAD_INITIATED) return;


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

  /** @param {(entry: DownloadEntry) => void} transferFile */
  setTransferFunction(transferFile) {
    this.transferFile = transferFile;
  }

  /**
   * @param {LoaderStats|undefined} stats - Undefined when the request could not be made.
   * @param {DownloadEntry} entry
   * @param {null} xhr
   */
  onFail(stats, entry, xhr) {
    this.status = DownloadStatus.DOWNLOAD_FAILED;
    this.stats = stats;

    this.notifyWatchers('onFail', this);
    this.cleanup();
  }

  /** @type {(stats?: LoaderStats, entry?: DownloadEntry, xhr?: null) => void} */
  onAbort(stats) {
    if (stats) this.stats = stats;
    this.status = DownloadStatus.DOWNLOAD_FAILED;

    this.notifyWatchers('onAbort', this);
    this.cleanup();
  }

  /**
   * A watcher that throws is logged and keeps neither the others nor the cleanup from running.
   * @param {'onSuccess'|'onFail'|'onAbort'} name
   * @param {[entry: DownloadEntry, xhr?: null]} args
   */
  notifyWatchers(name, ...args) {
    // A copy: a callback may remove a watcher.
    [...this.watchers].forEach((watcher) => {
      try {
        watcher.callbacks[name]?.(...args);
      } catch (e) {
        console.error(`A download watcher's ${name} threw:`, e);
      }
    });
  }

  /**
   * @param {LoaderStats} stats
   * @param {DownloadRequest} context
   * @param {ArrayBuffer|string} data
   * @param {null} xhr
   */
  onProgress(stats, context, data, xhr) {
    [...this.watchers].forEach((watcher) => {
      try {
        watcher.callbacks.onProgress?.(stats, context, data, xhr);
      } catch (e) {
        console.error('A download watcher\'s onProgress threw:', e);
      }
    });
  }

  async getData() {
    return typeof this.data === 'function' ? await this.data() : this.data;
  }

  /**
   * Data stored but no longer readable is reported to onDataLost, which drops this entry.
   * @param {string} [type]
   * @return {Promise<ArrayBuffer|string>}
   */
  async getDataFromBlob(type) {
    const as = type || this.responseType || 'text';
    try {
      const data = await this.getData();
      if (data === undefined || data === null) {
        throw DATA_GONE;
      }
      return await BlobManager.getDataFromBlob(/** @type {Blob} */ (data), as);
    } catch (e) {
      // Only storage that lost it: a TypeError would fail the same way after a new download.
      if (this.status === DownloadStatus.DOWNLOAD_COMPLETE && (e === DATA_GONE || e instanceof DOMException)) {
        this.onDataLost?.(e);
      }
      throw e;
    }
  }

  getDataSize() {
    return this.dataSize;
  }
}
