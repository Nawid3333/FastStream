import {DownloadStatus} from '../enums/DownloadStatus.mjs';
import {FSBlob} from '../modules/FSBlob.mjs';
import {DownloadEntry} from './DownloadEntry.mjs';
import {StandardDownloader} from './StandardDownloader.mjs';

export class DownloadManager {
  /** How long no download may fail before a downloader dropped for a failure comes back. */
  static FailureRecoveryMs = 10000;

  // The speed test. A video started with one downloader and added one each time three
  // speed samples showed a gain: on a Vimeo video at 15 MB/s it took 3.3 s, a third of
  // the video, to reach six (2026-10-06). It starts with three now and decides after two
  // samples; a server that asks to slow down (SlowDownStatuses) halves them at once.
  /** Downloaders a video starts with, the limit allowing; one after a server throttled. */
  static StartDownloaders = 3;
  /** Speed samples averaged before the test adds a downloader. */
  static SamplesPerStep = 2;
  /** HTTP answers that ask to slow down: too many requests, overloaded. */
  static SlowDownStatuses = [429, 503];
  /** The longest a server's Retry-After holds every download back. */
  static MaxRetryAfterMs = 30000;

  constructor(client) {
    this.client = client;
    this.queue = [];

    this.storage = new Map();

    this.downloaders = [];
    this.paused = false;
    this.speedTestBuffer = [];
    this.speedTestSeen = [];
    this.speedTestCount = 0;
    this.testing = true;
    this.lastSpeed = 0;
    this.lastFailed = 0;
    // Downloaders taken away after failed downloads, and not back yet.
    this.droppedDownloaders = 0;
    // A server answered 429 or 503: this player stays careful, for the next video too.
    this.throttled = false;
    // Until when a server's Retry-After holds downloads back (Date.now() time).
    this.holdUntil = 0;

    this.failed = 0;

    this.blobStore = new FSBlob();
  }

  getCompletedEntries() {
    const entries = [];
    this.storage.forEach((entry) => {
      if (entry.status === DownloadStatus.DOWNLOAD_COMPLETE) {
        entries.push(entry);
      }
    });
    return entries;
  }

  setEntries(entries) {
    entries.forEach((entry) => {
      this.setEntry(entry);
    });
  }

  async archiveEntryData(entry) {
    if (entry.status !== DownloadStatus.DOWNLOAD_COMPLETE || entry.storeRaw || typeof entry.data === 'function') {
      return;
    }

    const identifier = this.getIdentifier(entry);
    await this.blobStore.saveBlobAsync(entry.data, identifier);

    entry.data = () => {
      return this.blobStore.getBlob(identifier);
    };
  }

  setEntry(entry) {
    const identifier = this.getIdentifier(entry);

    // A save that failed (a full disk) leaves the data in memory, as before - without an
    // unhandled rejection, which neither caller awaited.
    const archive = (done) => this.archiveEntryData(done).catch((e) => console.warn('Could not archive a download', e));
    if (entry.status === DownloadStatus.DOWNLOAD_COMPLETE) {
      archive(entry);
    } else {
      entry.setTransferFunction(archive);
    }

    this.storage.set(identifier, entry);
  }

  canGetFile(details) {
    const key = this.getIdentifier(details);
    const storedEntry = this.storage.get(key);

    if (storedEntry?.status === DownloadStatus.DOWNLOAD_COMPLETE) {
      return true;
    }

    if (this.queue.length > 0) {
      return false;
    }

    if (this.paused) return false;

    return !this.downloaders.every((downloader) => {
      return !downloader.canHandle(details);
    });
  }

  getEntry(details) {
    const key = this.getIdentifier(details);
    return this.storage.get(key);
  }

  /**
   * Drops a finished stored copy, so the next getFile fetches the file again. A manifest a
   * player loads a second time is a live one being refreshed, and its stored copy is the
   * old window. A copy still downloading is left alone.
   * @param {Object} details - The request (url, range and response type).
   */
  forgetCompletedFile(details) {
    if (this.getEntry(details)?.status === DownloadStatus.DOWNLOAD_COMPLETE) {
      this.removeFile(details);
    }
  }

  removeFile(details) {
    const key = this.getIdentifier(details);
    const storedEntry = this.storage.get(key);
    if (storedEntry) {
      storedEntry.destroy();
      this.storage.delete(key);
      this.blobStore.deleteBlob(key);
    }
  }

  destroy() {
    // queueNext's retry after a failure would find no downloaders left.
    clearTimeout(this.failCooldown);
    this.failCooldown = null;
    this.downloaders.forEach((downloader) => {
      downloader.destroy();
    });
    this.downloaders = null;
    this.storage = null;
    this.blobStore.close();
    this.blobStore = null;
  }

  getFile(details, callbacks, priority) {
    priority = priority || 0;
    const key = this.getIdentifier(details);
    let storedEntry = this.storage.get(key);
    //  console.log("get file", key, storedEntry)

    if (!storedEntry || storedEntry.status === DownloadStatus.DOWNLOAD_FAILED) {
      storedEntry = new DownloadEntry(details);
      this.setEntry(storedEntry);
    }

    if (storedEntry.status === DownloadStatus.DOWNLOAD_COMPLETE) {
      callbacks.onSuccess(storedEntry);
      return {
        entry: storedEntry,
        abort: () => {
          // nothing
        },
        callbacks: callbacks,
      };
    }

    storedEntry.preProcessor = details.preProcessor;
    storedEntry.postProcessor = details.postProcessor;

    const watcher = {
      entry: storedEntry,
      abort: () => {
        watcher.entry.abortWatcher(watcher);
      },
      callbacks: callbacks,

    };

    storedEntry.addWatcher(watcher);

    if (storedEntry.status === DownloadStatus.ENQUEUED && storedEntry.priority < priority) {
      // remove from queue
      storedEntry.status = DownloadStatus.WAITING;
      const ind = this.queue.indexOf(storedEntry);
      if (ind !== -1) {
        this.queue.splice(ind, 1);
      }
    }

    if (storedEntry.status === DownloadStatus.WAITING) {
      storedEntry.priority = priority;

      // append to end of priority queue
      let ind = this.queue.length;
      while (ind > 0 && this.queue[ind - 1].priority < priority) {
        ind--;
      }
      this.queue.splice(ind, 0, storedEntry);

      storedEntry.status = DownloadStatus.ENQUEUED;
      this.queueNext();
    }

    return watcher;
  }

  getSpeed() {
    let totalSpeed = 0;
    this.downloaders.forEach((downloader) => {
      totalSpeed += downloader.getSpeed();
    });

    return totalSpeed;
  }

  /**
   * How many downloaders may run: the option, from 1 to 6 (a browser's limit per server).
   * 0 or no value is the default 6. The speed test read 0 as "add none", while the
   * add-downloader key read it as "no limit".
   * @return {number}
   */
  downloaderLimit() {
    const limit = this.client?.options?.maximumDownloaders;
    return Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 6) : 6;
  }

  addDownloader() {
    this.testing = false;
    this.droppedDownloaders = 0;
    this.downloaders.push(new StandardDownloader(this));
    this.client.predownloadFragments();
    this.queueNext();
  }

  /**
   * A server answered 429 or 503: half the downloaders go (one stays), the speed test
   * stops, none come back by themselves, and every download waits for the server's
   * Retry-After (up to MaxRetryAfterMs), or the usual second after a failure. The player
   * starts its next video with one downloader too.
   * @param {number} [retryAfter] - The wait the server asked for, in ms.
   */
  slowDown(retryAfter) {
    this.throttled = true;
    this.testing = false;
    this.droppedDownloaders = 0;
    this.lastFailed = Date.now();
    // Those taken out finish their download; queueNext gives them no other.
    this.downloaders.length = Math.max(1, Math.floor(this.downloaders.length / 2));
    if (retryAfter > 0) {
      this.holdUntil = Math.max(this.holdUntil, Date.now() + Math.min(retryAfter, DownloadManager.MaxRetryAfterMs));
    }
    this.client?.resetFailed?.();
    console.log('The server asked to slow down: ' + this.downloaders.length + ' downloader(s) now');
  }

  removeDownloader() {
    this.testing = false;
    this.droppedDownloaders = 0;
    const downloader = this.downloaders.pop();
    // The Minus key once more with none left threw
    if (!downloader) {
      return;
    }
    downloader.abort();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.downloaders.forEach((downloader) => {
      downloader.abort();
    });
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.client.predownloadFragments();
    for (let i = 0; i < this.downloaders.length; i++) {
      this.queueNext();
    }
  }

  removeAllDownloaders() {
    this.testing = false;
    this.droppedDownloaders = 0;
    this.downloaders.forEach((downloader) => {
      downloader.abort();
    });
    this.downloaders.length = 0;
  }

  onDownloaderFinished(downloader, entry) {
    if (this.paused) return;

    const slowDown = entry.status === DownloadStatus.DOWNLOAD_FAILED && !entry.aborted &&
      DownloadManager.SlowDownStatuses.includes(downloader.stats?.error?.code);
    if (slowDown) {
      this.slowDown(downloader.stats.error.retryAfter);
    } else if (navigator.onLine && entry.status === DownloadStatus.DOWNLOAD_FAILED && !entry.aborted) {
      this.lastFailed = Date.now();

      if (this.downloaders.length > 1) {
        const ind = this.downloaders.indexOf(downloader);
        if (ind !== -1) {
          this.downloaders.splice(ind, 1);
          this.droppedDownloaders++;
          this.client.resetFailed();
          console.log('Downloader failed, removing downloader and trying again');
        }
      }
    } else if (entry.status === DownloadStatus.DOWNLOAD_COMPLETE && this.droppedDownloaders > 0 &&
        Date.now() - this.lastFailed > DownloadManager.FailureRecoveryMs) {
      // A failure takes a downloader away, easing off a server that is struggling, and it
      // never came back: three failures in a long video left three downloaders of six for
      // the rest of it. Once downloads succeed again, each success brings one back.
      this.droppedDownloaders--;
      this.downloaders.push(new StandardDownloader(this));
    }

    if (this.testing) {
      const ind = this.downloaders.indexOf(downloader);
      if (ind !== -1) {
        if (entry.status === DownloadStatus.DOWNLOAD_FAILED && !entry.aborted) {
          this.failed++;
          if (this.failed >= 4) {
            console.log('Speed test failed');
            this.testing = false;
          }
        } else {
          if (!this.speedTestSeen[ind] && downloader.getSpeed()) {
            this.speedTestCount++;
          }
          this.speedTestSeen[ind] = true;


          if (this.speedTestCount >= this.downloaders.length) {
            let speed = this.getSpeed();

            this.speedTestBuffer.push(speed);
            this.speedTestSeen = [];
            this.speedTestCount = 0;

            if (this.speedTestBuffer.length >= DownloadManager.SamplesPerStep) {
              speed = this.speedTestBuffer.reduce((a, b) => a + b, 0) / this.speedTestBuffer.length;
              this.speedTestBuffer = [];

              if (speed > this.lastSpeed) {
                if (this.downloaders.length < this.downloaderLimit()) {
                  console.log('Adding downloader, speed: ' + speed);
                  this.downloaders.push(new StandardDownloader(this));
                  this.lastSpeed = speed;
                } else {
                  this.testing = false;
                  console.log('Speed test finished (maxed out), speed: ' + this.getSpeed());
                }
              } else {
                console.log('Speed test finished, speed: ' + speed);
                this.testing = false;
              }
            }
          }
        }
      }
    }


    this.client.predownloadFragments();
    this.queueNext();
  }

  /**
   * Starts as many queued downloads as there are free downloaders. It started one per call,
   * so after a failure's cooldown, which calls it once, one download ran at a time until
   * something else called it.
   */
  queueNext() {
    while (!this.paused && this.queue.length > 0) {
      if (this.queue[0].status !== DownloadStatus.ENQUEUED) {
        this.queue.shift();
        continue;
      }

      const failCooldown = 1000;
      const waitUntil = Math.max(this.lastFailed + failCooldown, this.holdUntil);
      if (waitUntil > Date.now()) {
        if (this.failCooldown) clearTimeout(this.failCooldown);
        this.failCooldown = setTimeout(() => {
          this.queueNext();
        }, waitUntil - Date.now() + 100);
        return;
      }

      const downloader = this.downloaders.find((downloader) => {
        return downloader.canHandle(this.queue[0].details);
      });
      if (!downloader) return;

      const entry = this.queue.shift();
      downloader.run(entry);
    }
  }

  getIdentifier(details) {
    const url = details.url;
    const rangeStart = details.rangeStart;
    const rangeEnd = details.rangeEnd;
    const responseType = details.responseType;

    return url + '::' + rangeStart + '-' + rangeEnd + '::' + responseType;
  }

  async reset() {
    this.abortAll();

    this.testing = true;
    this.downloaders = [];
    this.droppedDownloaders = 0;
    this.speedTestBuffer = [];
    this.speedTestSeen = [];
    this.speedTestCount = 0;
    this.lastSpeed = 0;

    this.failed = 0;
    this.holdUntil = 0;

    if (!this.dontClearStorage) {
      await this.clearStorage();
    }

    const start = this.throttled ? 1 : Math.min(DownloadManager.StartDownloaders, this.downloaderLimit());
    for (let i = 0; i < start; i++) {
      this.downloaders?.push(new StandardDownloader(this));
    }
  }

  async setup() {

  }

  resetOverride(value) {
    this.dontClearStorage = value;
  }

  async clearStorage() {
    this.storage.clear();
    await this.blobStore.clear();
  }

  abortAll() {
    this.queue.forEach((entry) => {
      entry.abort();
    });
    this.queue.length = 0;

    this.downloaders.forEach((downloader) => {
      downloader.abort();
    });
  }

  getStorageByteCount() {
    let count = 0;
    this.storage.forEach((entry) => {
      count += entry.getDataSize();
    });
    return count;
  }
}
