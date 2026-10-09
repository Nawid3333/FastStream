import {DownloadStatus} from '../enums/DownloadStatus.mjs';
import {FSBlob} from '../modules/FSBlob.mjs';
import {DownloadEntry} from './DownloadEntry.mjs';
import {PLAYBACK_PRIORITY, StandardDownloader} from './StandardDownloader.mjs';

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
  /** Base calm period after a slow-down, before the player probes the server speed again. */
  static CalmPeriodMs = 15000;
  /** The longest calm period, even after several slow-downs in a row. */
  static MaxCalmPeriodMs = 120000;
  /** Answers within this time of the last halving belong to the same burst: they extend
   * the Retry-After hold but do not halve again. */
  static SlowDownSettleMs = 2000;

  constructor(client) {
    this.client = client;
    this.queue = [];

    this.storage = new Map();

    this.downloaders = [];
    this.paused = false;
    // The next reset() keeps the downloads (keepStorageOnce).
    this.keepStorageNext = false;
    // Leaving the network to a watched player that is short of video (setYield).
    this.yielding = false;
    // ...and holding even its own playback's requests: it is paused (setYield).
    this.holdingPlayback = false;
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
    // Slow-downs in a row, for the doubling calm period.
    this.slowDowns = 0;
    // Until when the player waits before probing the server speed again (Date.now() time).
    this.calmUntil = 0;
    // Date.now() of the last halving, to group answers from the same burst.
    this.lastSlowDown = 0;
    // True while the speed test is probing after a calm period, not an ordinary start.
    this.probing = false;
    // Downloaders a slow-down took away while they delivered a finished download: out of
    // this.downloaders, but a reset, pause or destroy must still stop them, or an old
    // video's piece reaches a player torn down meanwhile.
    this.retiring = new Set();

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
    // Its stored data cannot be read any more (DownloadEntry.getDataFromBlob): forgotten,
    // so the next request for it downloads it again.
    entry.onDataLost = (error) => {
      if (this.storage?.get(identifier) !== entry) return;
      console.warn('A stored download could not be read, it will be downloaded again', error);
      this.storage.delete(identifier);
      this.blobStore?.deleteBlob(identifier);
    };

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
    this.abortRetiring();
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
    } else if (storedEntry.status === DownloadStatus.ENQUEUED) {
      // Joined in the queue: started if a downloader is free. An entry queued while there
      // were none (during reset) was waiting for a queueNext that nothing called: the
      // manifest a new player asked for again joined it, and never loaded.
      this.queueNext();
    } else if (storedEntry.status === DownloadStatus.DOWNLOAD_INITIATED && storedEntry.priority < priority) {
      // Joined while it downloads (playback now waits for what was a download ahead): a
      // retry goes out with the higher priority (StandardDownloader's fetchPriority). The
      // request already sent keeps its own.
      storedEntry.priority = priority;
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
   * A server answered 429 or 503 (FetchLoader tells at once, before it retries): half the
   * downloaders go (one stays) - one mid-fetch hands its download back to the queue, one
   * delivering a finished download finishes it first (StandardDownloader.retire) - the
   * speed test stops, and every download waits for the server's Retry-After (up to
   * MaxRetryAfterMs), or the usual second after a failure. Answers of the same burst
   * (SlowDownSettleMs) halve once. After a calm period, at least the Retry-After and
   * doubling with each slow-down in a row (CalmPeriodMs, up to MaxCalmPeriodMs), the speed
   * test probes again (onDownloaderFinished): downloads go as fast as the server allows.
   * It went "for good" until 2026-10-06; the user wanted the speed back. A next video
   * starts with one downloader until a probe ends without one.
   * @param {number} [retryAfter] - The wait the server asked for, in ms.
   */
  slowDown(retryAfter) {
    if (!this.downloaders) return; // destroyed
    const now = Date.now();
    // Hold every download back for at least the server's Retry-After, as before. An answer
    // in the same burst still extends this, even if it does not halve again.
    if (retryAfter > 0) {
      this.holdUntil = Math.max(this.holdUntil, now + Math.min(retryAfter, DownloadManager.MaxRetryAfterMs));
    }
    // Answers within this time of the last halving belong to the same burst: they extend
    // the Retry-After hold but do not halve again.
    if (now - this.lastSlowDown < DownloadManager.SlowDownSettleMs) {
      return;
    }
    this.lastSlowDown = now;
    this.throttled = true;
    this.testing = false;
    this.probing = false;
    this.droppedDownloaders = 0;
    this.lastFailed = now;
    this.slowDowns++;
    // The calm period doubles with each slow-down in a row, up to MaxCalmPeriodMs.
    this.calmUntil = now + Math.min(
        Math.max(DownloadManager.CalmPeriodMs, retryAfter || 0) * Math.pow(2, this.slowDowns - 1),
        DownloadManager.MaxCalmPeriodMs,
    );
    // Taken off their downloads, none still running untracked when the player pauses or
    // goes, nor answering a 429 later to halve the rest again; retire() hands a download
    // back to the queue without its watchers hearing of it (it went "aborted" to them, and
    // one being delivered was thrown away).
    const keep = Math.max(1, Math.floor(this.downloaders.length / 2));
    for (const cut of this.downloaders.splice(keep)) {
      if (cut.delivering) this.retiring.add(cut);
      cut.retire();
    }
    this.client?.resetFailed?.();
    console.log('The server asked to slow down: ' + this.downloaders.length + ' downloader(s) now');
  }

  /**
   * The speed test that probed after a calm period ended. Without a slow-down it found
   * the rate the server takes: careful no more, the slow-downs in a row forgotten. Ended
   * by failures, it waits another calm period before it probes again, or every next
   * success would start it at once.
   * @param {boolean} found - It ended on the speed (no gain, or the limit), not failures.
   */
  endProbe(found) {
    if (!this.probing) return;
    this.probing = false;
    if (found) {
      this.throttled = false;
      this.slowDowns = 0;
      console.log('The server takes this rate');
    } else {
      this.calmUntil = Date.now() + DownloadManager.CalmPeriodMs;
    }
  }

  /**
   * Puts an entry handed back by StandardDownloader.retire() into the queue again, so a
   * download cut by a slow-down resumes without its watchers hearing anything. An entry
   * whose watchers gave up meanwhile (failed or complete) is left alone.
   * @param {DownloadEntry} entry - The entry to requeue.
   */
  requeueEntry(entry) {
    if (!this.downloaders) return; // destroyed
    if (entry.status === DownloadStatus.DOWNLOAD_FAILED || entry.status === DownloadStatus.DOWNLOAD_COMPLETE) {
      return;
    }
    entry.status = DownloadStatus.ENQUEUED;
    const priority = entry.priority || 0;
    entry.priority = priority;
    // Insert by priority exactly like getFile: after entries of equal or higher priority.
    let ind = this.queue.length;
    while (ind > 0 && this.queue[ind - 1].priority < priority) {
      ind--;
    }
    this.queue.splice(ind, 0, entry);
    this.queueNext();
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
    this.abortRetiring();
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

  /**
   * Leaves the network to another FastStream player that the user watches and that is short
   * of video (PlayerPeers.shouldYield), or takes it back. While yielding the client starts no
   * downloads ahead (predownloadFragments), what still goes out asks Firefox for 'low'
   * priority (StandardDownloader), and the downloads ahead that are running are cancelled -
   * not those this player's own playback waits for (priority 1000 and up), nor one at least
   * half done, nor one being delivered. A cancelled one is downloaded again later, from the
   * start: DownloadEntry.abort() puts its fragment back to waiting. Not pause(): that is the
   * user's, and stops everything.
   * A paused player holds its playback's requests too (holdPlayback): they wait in the queue
   * until it stops yielding. Its player still wanted to buffer ahead, and once its downloads
   * ahead were cancelled it asked for them itself - measured: three paused MP4 players in
   * background tabs kept a request each running all through a seek in the watched one.
   * @param {boolean} yielding
   * @param {boolean} [holdPlayback] - Hold its playback's requests as well.
   */
  setYield(yielding, holdPlayback = false) {
    if (!this.downloaders) return;
    const hold = yielding && holdPlayback;
    const holdChanged = this.holdingPlayback !== hold;
    const yieldChanged = this.yielding !== yielding;
    // Both set before anything starts again: queueNext and the client read them.
    this.holdingPlayback = hold;
    this.yielding = yielding;
    if (yieldChanged && yielding) {
      // The downloads ahead: queued ones leave the queue, running ones under half done stop.
      // Not a save's (priority below 0: the user asked for it), not what playback waits for.
      const cancellable = (entry) => {
        const priority = entry.priority || 0;
        return priority >= 0 && priority < PLAYBACK_PRIORITY;
      };
      for (const entry of this.queue.filter((queued) => queued.status === DownloadStatus.ENQUEUED && cancellable(queued))) {
        this.queue.splice(this.queue.indexOf(entry), 1);
        entry.abort();
      }
      for (const downloader of this.downloaders.slice()) {
        const entry = downloader.entry;
        if (!entry || downloader.delivering || !cancellable(entry)) continue;
        const stats = downloader.stats;
        if (stats && stats.total > 0 && stats.loaded / stats.total >= 0.5) continue;
        entry.abort();
      }
    }
    if (yieldChanged && !yielding) {
      this.client?.predownloadFragments?.();
    }
    if (yieldChanged || holdChanged) {
      // Freed connections go to what may run now.
      this.queueNext();
    }
  }

  /**
   * Cancels the download of a request, when that is cheap and harmless: not one this player's
   * playback waits for (priority 1000 and up), not one at least half done, not one being
   * delivered. A queued one leaves the queue. Its fragment goes back to waiting
   * (DownloadEntry.abort tells the watchers) and is downloaded again when it is wanted.
   * @param {Object} details - The request (a fragment's getContext()).
   * @return {boolean} Whether it was cancelled.
   */
  cancelIfCheap(details) {
    const entry = this.getEntry(details);
    if (!entry || (entry.priority || 0) >= PLAYBACK_PRIORITY) return false;
    if (entry.status === DownloadStatus.ENQUEUED) {
      const index = this.queue.indexOf(entry);
      if (index !== -1) this.queue.splice(index, 1);
      entry.abort();
      return true;
    }
    if (entry.status !== DownloadStatus.DOWNLOAD_INITIATED) return false;
    const downloader = entry.downloader;
    if (downloader?.delivering) return false;
    const stats = downloader?.stats;
    if (stats && stats.total > 0 && stats.loaded / stats.total >= 0.5) return false;
    entry.abort();
    return true;
  }

  /**
   * Downloads running or waiting in the queue.
   * @return {number}
   */
  activeCount() {
    if (!this.downloaders) return 0;
    return this.downloaders.filter((downloader) => downloader.entry).length + this.queue.length;
  }

  removeAllDownloaders() {
    this.testing = false;
    this.droppedDownloaders = 0;
    this.abortRetiring();
    this.downloaders.forEach((downloader) => {
      downloader.abort();
    });
    this.downloaders.length = 0;
  }

  /** Stops the downloaders a slow-down took away that are still delivering. */
  abortRetiring() {
    const retiring = Array.from(this.retiring);
    this.retiring.clear();
    retiring.forEach((downloader) => downloader.abort());
  }

  onDownloaderFinished(downloader, entry) {
    this.retiring.delete(downloader);
    if (this.paused || !this.downloaders) return;

    const failed = entry.status === DownloadStatus.DOWNLOAD_FAILED && !entry.aborted;
    // A 429/503 was already signalled when the answer came (StandardDownloader.onSlowDown ->
    // slowDown). It is not an ordinary failure: no lastFailed and no downloader dropped.
    const slowDownStatus = failed && DownloadManager.SlowDownStatuses.includes(downloader.stats?.error?.code);
    if (slowDownStatus) {
      // handled by slowDown() when the answer arrived
    } else if (navigator.onLine && failed) {
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

    // After a slow-down the player stays careful; once the calm period is over, a successful
    // download starts the speed test again, from the small number of downloaders left.
    if (entry.status === DownloadStatus.DOWNLOAD_COMPLETE && this.downloaders.includes(downloader) &&
        this.throttled && !this.testing && this.calmUntil &&
        Date.now() >= Math.max(this.calmUntil, this.holdUntil)) {
      this.probing = true;
      this.testing = true;
      this.failed = 0;
      this.speedTestBuffer = [];
      this.speedTestSeen = [];
      this.speedTestCount = 0;
      this.lastSpeed = 0;
      console.log('Calm period over, probing the server speed');
    }

    if (this.testing) {
      const ind = this.downloaders.indexOf(downloader);
      if (ind !== -1) {
        if (entry.status === DownloadStatus.DOWNLOAD_FAILED && !entry.aborted) {
          this.failed++;
          if (this.failed >= 4) {
            console.log('Speed test failed');
            this.testing = false;
            this.endProbe(false);
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
                  this.endProbe(true);
                  console.log('Speed test finished (maxed out), speed: ' + this.getSpeed());
                }
              } else {
                console.log('Speed test finished, speed: ' + speed);
                this.testing = false;
                this.endProbe(true);
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
      // A paused player that leaves the network to a watched one starts only a save (priority
      // below 0: the user asked for it), nothing of its own playback (setYield).
      const index = this.holdingPlayback ?
        this.queue.findIndex((entry) => entry.status === DownloadStatus.ENQUEUED && (entry.priority || 0) < 0) : 0;
      if (index === -1) return;

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
        return downloader.canHandle(this.queue[index].details);
      });
      if (!downloader) return;

      const entry = this.queue.splice(index, 1)[0];
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
    this.lastSlowDown = 0;
    // After a server throttled, the next video starts with one downloader, and its speed
    // test is a probe: one that climbs without another 429 or 503 ends the caution. One
    // stopped short (the add/remove downloader keys) probes again after a calm period.
    this.probing = this.throttled;
    this.calmUntil = this.throttled ? Date.now() + DownloadManager.CalmPeriodMs : 0;

    // keepStorageOnce() asks for this reset only; resetOverride() for as long as it is on.
    const keep = this.dontClearStorage || this.keepStorageNext;
    this.keepStorageNext = false;
    if (!keep) {
      await this.clearStorage();
    }

    const start = this.throttled ? 1 : Math.min(DownloadManager.StartDownloaders, this.downloaderLimit());
    for (let i = 0; i < start; i++) {
      this.downloaders?.push(new StandardDownloader(this));
    }
    // What was asked for while there were no downloaders (the reset's await): a player set
    // up meanwhile - a seek preview's build still running - queued its manifest then, and
    // nothing started it. The queue holding it, the client asked for nothing more
    // (canGetFile), and the next player's request for the same manifest joined it: a live
    // DASH stream reloaded without a failed codec never loaded (2026-10-06).
    if (this.downloaders) this.queueNext();
  }

  async setup() {

  }

  resetOverride(value) {
    this.dontClearStorage = value;
  }

  /**
   * The next reset() keeps what was downloaded, and only that one (the player built again
   * for its source after an error, FastStreamClient.recoverPlayer). Not resetOverride(), the
   * save manager's switch for a loaded archive: one turned it off under the other.
   */
  keepStorageOnce() {
    this.keepStorageNext = true;
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
    this.abortRetiring();

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
