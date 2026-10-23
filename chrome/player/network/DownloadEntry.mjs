// @ts-check
import {DownloadStatus} from '../enums/DownloadStatus.mjs';
import {BlobManager} from '../utils/BlobManager.mjs';
import {Utils} from '../utils/Utils.mjs';

// What getDataFromBlob throws when the stored data is not there at all.
const DATA_GONE = new Error('The stored download is gone');

/** @typedef {import('./FetchLoader.mjs').LoaderStats} LoaderStats */
/** @typedef {import('./FetchLoader.mjs').LoaderResponse} LoaderResponse */

/**
 * What a download asks FetchLoader for (getRequest), or a preProcessor's change of it: the
 * URL, the byte range (none without a rangeEnd: FetchLoader sends no Range header then), the
 * response type ('arraybuffer', or text) and the headers.
 * @typedef {{url: string, rangeStart?: number, rangeEnd?: number, responseType?: string,
 *   headers?: Object<string, string>}} DownloadRequest
 */

/**
 * A download's settings (DownloadManager.getFile's config): FetchLoader's retry and timeout
 * settings over StandardDownloader's defaults. Whatever else the caller's config holds (an
 * hls.js LoaderConfiguration's loadPolicy, a fragment request's headers) comes along unread.
 * @typedef {Partial<import('./FetchLoader.mjs').LoaderConfig> & Object<string, *>} DownloadConfig
 */

/**
 * A download as DownloadManager.getFile is asked for it: the request, whether the answer is
 * stored as it came (storeRaw: a key) or as a Blob, the settings, and what changes the
 * request before it goes out and the answer before it is stored.
 * @typedef {DownloadRequest & {storeRaw?: boolean, config?: DownloadConfig|null,
 *   preProcessor?: (entry: DownloadEntry, request: DownloadRequest) => Promise<DownloadRequest>,
 *   postProcessor?: (entry: DownloadEntry, response: LoaderResponse) => Promise<LoaderResponse>}} DownloadDetails
 */

/**
 * What a download tells each of its watchers (DownloadManager.getFile): the entry once it is
 * stored (no xhr for a copy that was stored already; FetchLoader has none either),
 * FetchLoader's progress with the request, the entry of a failed or an aborted one.
 * @typedef {{onSuccess: (entry: DownloadEntry, xhr?: null) => void,
 *   onProgress?: (stats: LoaderStats, request: DownloadRequest, data: ArrayBuffer|string, xhr: null) => void,
 *   onFail?: (entry: DownloadEntry) => void, onAbort?: (entry: DownloadEntry) => void}} DownloadCallbacks
 */

/**
 * One request's hold on a download (DownloadManager.getFile): abort() gives it up.
 * @typedef {{entry: DownloadEntry, abort: () => void, callbacks: DownloadCallbacks}} DownloadWatcher
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

    // Null once the download is over (cleanup).
    /** @type {DownloadDetails['preProcessor']|null} */
    this.preProcessor = details.preProcessor;
    /** @type {DownloadDetails['postProcessor']|null} */
    this.postProcessor = details.postProcessor;

    // The answer: as it came for storeRaw (text or an ArrayBuffer; an archive's raw bytes), else
    // a Blob, and once the download manager stored it, what gets it back (archiveEntryData).
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

    // Told when its stored data cannot be read any more (getDataFromBlob): the download
    // manager drops the entry then, so it is downloaded again.
    /** @type {((error: *) => void)|null} */
    this.onDataLost = null;
  }

  /** @param {DownloadWatcher} watcher */
  addWatcher(watcher) {
    this.watchers.push(watcher);
  }

  /** @param {DownloadWatcher} watcher */
  removeWatcher(watcher) {
    const ind = this.watchers.indexOf(watcher);
    if (ind !== -1) this.watchers.splice(ind, 1);
  }

  /**
   * A watcher gives up on the download; the last one to do so aborts it. A watcher that is no
   * longer here was already told how the download ended (the watchers go once it is over), or
   * gave up before: its abort is too late. It told it "aborted" after "done", and aborted the
   * finished entry - a stored fragment marked failed, and downloaded again.
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
  }

  destroy() {
    this.abort();
  }

  /** @return {Promise<DownloadRequest>} The request, as the preProcessor (if any) changed it. */
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
   * The download's answer, from its downloader (StandardDownloader.onSuccess).
   * @param {import('./FetchLoader.mjs').LoaderResponse} response - FetchLoader's answer.
   * @param {LoaderStats} stats
   * @param {DownloadEntry} entry - This entry.
   * @param {null} xhr - FetchLoader has none.
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

  /** @param {(entry: DownloadEntry) => void} transferFile - Told of the finished entry. */
  setTransferFunction(transferFile) {
    this.transferFile = transferFile;
  }

  /**
   * The download failed, from its downloader (StandardDownloader).
   * @param {LoaderStats|undefined} stats - FetchLoader's; undefined when the request could not be
   *   made (a preProcessor that threw), before there was a FetchLoader.
   * @param {DownloadEntry} entry - This entry.
   * @param {null} xhr - FetchLoader has none.
   */
  onFail(stats, entry, xhr) {
    this.status = DownloadStatus.DOWNLOAD_FAILED;
    this.stats = stats;

    this.notifyWatchers('onFail', this);
    this.cleanup();
  }

  /**
   * The download was stopped on purpose: abort() calls it with nothing, StandardDownloader.abort
   * with FetchLoader's stats (if it had begun), the entry and an xhr (always undefined:
   * FetchLoader has none), as onFail is called. Only the stats are read.
   * @type {(stats?: LoaderStats, entry?: DownloadEntry, xhr?: null) => void}
   */
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
   * @param {'onSuccess'|'onFail'|'onAbort'} name - The callback.
   * @param {[entry: DownloadEntry, xhr?: null]} args - Its arguments: this entry, and for
   *   onSuccess FetchLoader's xhr (null).
   */
  notifyWatchers(name, ...args) {
    // A copy: a callback that removes a watcher (abortWatcher) made forEach skip the next one,
    // which never heard how the download ended (final review, 2026-10-10).
    [...this.watchers].forEach((watcher) => {
      try {
        watcher.callbacks[name]?.(...args);
      } catch (e) {
        console.error(`A download watcher's ${name} threw:`, e);
      }
    });
  }

  /**
   * FetchLoader's progress, from the downloader (StandardDownloader.onProgress).
   * @param {LoaderStats} stats
   * @param {DownloadRequest} context - The request.
   * @param {ArrayBuffer|string} data - The answer's body: FetchLoader tells its progress
   *   once, when the whole of it has come.
   * @param {null} xhr - FetchLoader has none.
   */
  onProgress(stats, context, data, xhr) {
    // Guarded as notifyWatchers is: a progress callback that threw ended the downloader's
    // progress handling, and the entry and the downloader stayed busy for good.
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
      // A stored download's: a Blob (a raw one is read with getData).
      return await BlobManager.getDataFromBlob(/** @type {Blob} */ (data), as);
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
}
