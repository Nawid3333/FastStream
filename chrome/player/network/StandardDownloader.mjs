import {DownloadStatus} from '../enums/DownloadStatus.mjs';
import {SpeedTracker} from './SpeedTracker.mjs';
import {FetchLoader} from './FetchLoader.mjs';

// The priority the playback libraries' requests have (HLSLoader, DashLoader, MP4Player).
export const PLAYBACK_PRIORITY = 1000;

export class StandardDownloader {
  constructor(manager) {
    this.speedTracker = new SpeedTracker();
    this.manager = manager;
    this.loader = null;
    this.entry = null;
    this.stats = null;
    // True while entry.onSuccess is awaited: a slow-down must not take this downloader
    // away mid-delivery, or the finished data would be discarded.
    this.delivering = false;
  }

  canHandle(details) {
    return this.loader === null;
  }

  /**
   * A server answered 429 or 503: tell the manager to slow down. It may cut this very
   * downloader; retire() then hands the entry back without notifying the watchers.
   * @param {number|null} retryAfter - The wait the server asked for, in ms.
   */
  onSlowDown(retryAfter) {
    this.manager.slowDown?.(retryAfter);
  }

  getSpeed() {
    return this.speedTracker.getSpeed();
  }

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
    // The last download's stats, its error among them, are not this one's: the manager
    // reads a 429 or 503 from them (DownloadManager.slowDown).
    this.stats = null;

    entry.downloader = this;
    entry.status = DownloadStatus.DOWNLOAD_INITIATED;

    const defaultConfig = {
      timeout: 30000,
      maxRetry: 6,
      retryDelay: 1000,
      maxRetryDelay: 64000,
      ...entry.config,
      // What playback waits for (a library's request, priority 1000: HLSLoader, DashLoader,
      // MP4Player) goes first in Firefox's queue for the host; asked at each attempt, so a
      // retry has the priority of a request that joined the download meanwhile.
      // While the player leaves the network to a watched one (DownloadManager.setYield),
      // the rest goes 'low'.
      fetchPriority: () => (entry.priority >= PLAYBACK_PRIORITY ? 'high' : (this.manager?.yielding ? 'low' : 'auto')),
    };

    entry.getRequest().then((request)=>{
      if (!shouldContinue) {
        return;
      }
      this.loader = new FetchLoader();
      this.loader.addCallbacks(this);
      this.loader.load(request, defaultConfig);
    }).catch((err) => {
      // Aborted while its request was being made: that entry is over (cleanup ran), and
      // this downloader may be running the next one, which failing `this.entry` failed.
      if (!shouldContinue) return;
      console.error('Failed to get request for entry:', err);
      this.entry.onFail(this.loader.stats, this.entry, null);
      this.cleanup();
    });
  }

  abort() {
    this.loader?.abort();
    if (this.entry) this.entry.onAbort(this.loader.stats, this.entry, this.loader.xhr);
    this.cleanup();
  }

  /**
   * Takes this downloader away from a running download after a slow-down, without telling
   * the entry's watchers (they hear nothing). If it is already delivering a finished
   * download, it finishes that instead: it is already out of manager.downloaders.
   */
  retire() {
    if (this.delivering) return;
    if (!this.entry) return;
    // Stop the loader without notifying the entry: FetchLoader.abort clears its callbacks
    // and timers, the pre-FetchLoader stub's abort/destroy stops the pending request.
    this.loader?.abort();
    this.loader = null;
    const entry = this.entry;
    this.entry = null;
    entry.downloader = null;
    this.manager.requeueEntry(entry);
  }

  cleanup() {
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

  updateSpeed(stats) {
    this.stats = stats;
    stats.lastUpdate = performance.now();
    this.speedTracker.update(stats.loaded, stats.loading.start, stats.lastUpdate);
  }

  async onSuccess(response, stats, entry, xhr) {
    this.updateSpeed(stats);
    this.delivering = true;
    try {
      await this.entry.onSuccess(response, stats, this.entry, xhr);
    } finally {
      // Whatever went wrong in there, a downloader left busy would never download again.
      this.delivering = false;
      this.cleanup();
    }
  }

  onError(stats, entry, xhr) {
    this.updateSpeed(stats);
    this.entry?.onFail(stats, this.entry, xhr);
    this.cleanup();
  }

  onProgress(stats, context, data, xhr) {
    this.updateSpeed(stats);
    this.entry?.onProgress(stats, context, data, xhr);
  }

  onTimeout(stats, entry, xhr) {
    this.updateSpeed(stats);
    this.entry?.onFail(stats, this.entry, xhr);
    this.cleanup();
  }
};
