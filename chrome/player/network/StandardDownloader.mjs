// @ts-check
import {DownloadStatus} from '../enums/DownloadStatus.mjs';
import {SpeedTracker} from './SpeedTracker.mjs';
import {FetchLoader, STALL_TIMEOUT_MS} from './FetchLoader.mjs';

export const PLAYBACK_PRIORITY = 1000;

/** @typedef {import('./DownloadEntry.mjs').DownloadEntry} DownloadEntry */
/** @typedef {import('./FetchLoader.mjs').LoaderStats} LoaderStats */
/** @typedef {import('./FetchLoader.mjs').LoaderRequest} LoaderRequest */

/**
 * @param {string} url
 * @return {string}
 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return '';
  }
}

export class StandardDownloader {
  /** @param {import('./DownloadManager.mjs').DownloadManager} manager */
  constructor(manager) {
    this.speedTracker = new SpeedTracker();
    this.manager = manager;
    /** @type {*} */
    this.loader = null;
    /** @type {DownloadEntry|null} */
    this.entry = null;
    /** @type {(LoaderStats & {lastUpdate?: number})|null} */
    this.stats = null;
    // While entry.onSuccess is awaited a slow-down must not take this downloader away.
    this.delivering = false;
  }

  /**
   * @param {import('./DownloadEntry.mjs').DownloadRequest} [details]
   * @return {boolean}
   */
  canHandle(details) {
    return this.loader === null;
  }

  /** @param {number|null} retryAfter */
  onSlowDown(retryAfter) {
    this.manager.slowDown?.(retryAfter);
  }

  /**
   * @param {number} status
   * @param {string} url
   */
  onRefused(status, url) {
    this.manager.linkRefused?.(status, url);
  }

  getSpeed() {
    return this.speedTracker.getSpeed();
  }

  /** Idle time reads as slow for 10 s (SpeedTracker), which the speed test would take for the line. */
  resetSpeed() {
    this.speedTracker = new SpeedTracker();
  }

  /** @param {DownloadEntry} entry */
  run(entry) {
    if (this.loader != null) {
      throw new Error('Downloader is busy.');
    }
    let shouldContinue = true;
    this.loader = {
      abort: () => {
        shouldContinue = false;
      },
      destroy: () => {
        shouldContinue = false;
      },
    };
    this.entry = entry;
    // The manager reads a 429 or 503 from the stats: the last download's are not this one's.
    this.stats = null;

    entry.downloader = this;
    entry.status = DownloadStatus.DOWNLOAD_INITIATED;
    if (this.manager) this.manager.lastHost = hostOf(entry.url) || this.manager.lastHost;

    const defaultConfig = {
      timeout: STALL_TIMEOUT_MS,
      maxRetry: 6,
      retryDelay: 1000,
      maxRetryDelay: 64000,
      ...entry.config,
      // Playback's requests go first in Firefox's queue for the host; asked again at each retry.
      fetchPriority: () => (entry.priority >= PLAYBACK_PRIORITY ? 'high' :
        (this.manager?.yielding || this.manager?.waiting ? 'low' : 'auto')),
    };

    entry.getRequest().then((request)=>{
      if (!shouldContinue) {
        return;
      }
      this.loader = new FetchLoader();
      this.loader.addCallbacks(this);
      this.loader.load(request, defaultConfig);
    }).catch((err) => {
      // Aborted while its request was being made: this downloader may run the next entry now.
      if (!shouldContinue) return;
      console.error('Failed to get request for entry:', err);
      /** @type {DownloadEntry} */ (this.entry).onFail(this.loader.stats, /** @type {DownloadEntry} */ (this.entry), null);
      this.cleanup();
    });
  }

  abort() {
    this.loader?.abort();
    if (this.entry) {
      // Not a failed download (DownloadManager.onDownloaderFinished): no downloader taken away.
      this.entry.aborted = true;
      this.entry.onAbort(this.loader?.stats, this.entry, this.loader?.xhr);
    }
    this.cleanup();
  }

  retire() {
    if (this.delivering) return;
    if (!this.entry) return;
    this.loader?.abort();
    this.loader = null;
    const entry = this.entry;
    this.entry = null;
    entry.downloader = null;
    this.manager.requeueEntry(entry);
  }

  cleanup() {
    this.delivering = false;
    if (this.entry) {
      this.loader.destroy();
      this.entry.downloader = null;
      this.loader = null;
      const entry = this.entry;
      this.entry = null;
      this.manager.onDownloaderFinished(this, entry);
    }
  }

  destroy() {
    this.entry = null;
    this.abort();
  }

  /** @param {LoaderStats & {lastUpdate?: number}} stats */
  updateSpeed(stats) {
    this.stats = stats;
    stats.lastUpdate = performance.now();
    this.speedTracker.update(stats.loaded, stats.loading.start, stats.lastUpdate);
  }

  /**
   * @param {import('./FetchLoader.mjs').LoaderResponse} response
   * @param {LoaderStats} stats
   * @param {LoaderRequest} entry
   * @param {null} xhr
   */
  async onSuccess(response, stats, entry, xhr) {
    this.updateSpeed(stats);
    const current = /** @type {DownloadEntry} */ (this.entry);
    this.delivering = true;
    try {
      await current.onSuccess(response, stats, current, xhr);
    } finally {
      // An abort during delivery has cleaned up already, and the next entry may be running here.
      if (this.entry === current) {
        this.cleanup();
      }
    }
  }

  /**
   * @param {LoaderStats} stats
   * @param {LoaderRequest} entry
   * @param {null} xhr
   */
  onError(stats, entry, xhr) {
    this.updateSpeed(stats);
    this.entry?.onFail(stats, this.entry, xhr);
    this.cleanup();
  }

  /**
   * @param {LoaderStats} stats
   * @param {LoaderRequest} context
   * @param {ArrayBuffer|string} data
   * @param {null} xhr
   */
  onProgress(stats, context, data, xhr) {
    this.updateSpeed(stats);
    this.entry?.onProgress(stats, context, data, xhr);
  }

  /**
   * @param {Uint8Array} chunk
   * @param {number} offset
   * @param {import('./FetchLoader.mjs').PartialAnswer} answer
   */
  onChunk(chunk, offset, answer) {
    this.entry?.onChunk(chunk, offset, answer);
  }

  /**
   * @param {LoaderStats} stats
   * @param {LoaderRequest} entry
   * @param {null} xhr
   */
  onTimeout(stats, entry, xhr) {
    this.updateSpeed(stats);
    this.entry?.onFail(stats, this.entry, xhr);
    this.cleanup();
  }
};
