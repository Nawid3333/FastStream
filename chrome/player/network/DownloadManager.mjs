// @ts-check
import {DownloadStatus} from '../enums/DownloadStatus.mjs';
import {FSBlob} from '../modules/FSBlob.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {DownloadEntry} from './DownloadEntry.mjs';
import {signatureParams, withoutSignature} from './LinkSignature.mjs';
import {URGENT_PARALLEL} from './PlayheadFirst.mjs';
import {PLAYBACK_PRIORITY, StandardDownloader} from './StandardDownloader.mjs';

const AdoptAtOnce = 8;

/** @typedef {import('./DownloadEntry.mjs').DownloadRequest} DownloadRequest */
/**
 * @typedef {{entry: DownloadEntry, identifier: string, session: string, file: string, generation: number,
 *   moved: ?Promise<boolean>}} AdoptedFile
 */

export class DownloadManager {
  /** How long no download may fail before a downloader dropped for a failure comes back. */
  static FailureRecoveryMs = 10000;

  /** Downloaders a video starts with, the limit allowing; one after a server throttled. */
  static StartDownloaders = 3;
  /** Speed samples averaged before the test adds a downloader. */
  static SamplesPerStep = 1;
  static SlowDownStatuses = [429, 503];
  /** The longest a server's Retry-After holds every download back. */
  static MaxRetryAfterMs = 30000;
  /** Base calm period after a slow-down, before the player probes the server speed again. */
  static CalmPeriodMs = 15000;
  static MaxCalmPeriodMs = 120000;
  /** Answers this soon after the last halving extend the Retry-After hold but do not halve again. */
  static SlowDownSettleMs = 2000;

  /** @param {import('../FastStreamClient.mjs').FastStreamClient} client */
  constructor(client) {
    this.client = client;
    /** @type {DownloadEntry[]} */
    this.queue = [];

    // Untyped: getEntry gives undefined for one never asked for; SaveFragmentFetcher takes an entry or null.
    this.storage = new Map();

    /** @type {StandardDownloader[]} */
    this.downloaders = [];
    this.paused = false;
    // Handed over by an earlier player (adopt), by address without the link's signature.
    /** @type {?Map<string, DownloadEntry>} */
    this.adopted = null;
    /** @type {?Set<string>} */
    this.adoptedSignature = null;
    // Counts clearStorage(): a handed-over file moved after its downloads went is not kept.
    this.storageGeneration = 0;
    this.keepStorageNext = false;
    this.yielding = false;
    // ...and its own playback's requests too. yieldHold and waitHold say which asked for it.
    this.holdingPlayback = false;
    this.yieldHold = false;
    this.waitHold = false;
    this.waiting = false;
    this.receivedDone = 0;
    // Players on one host share Firefox's connections to it (PlayerTurns.leavesRoom).
    this.lastHost = '';
    /** @type {number[]} */
    this.speedTestBuffer = [];
    /** @type {Set<StandardDownloader>} */
    this.speedTestSeen = new Set();
    this.testing = true;
    this.testHeld = false;
    this.lastSpeed = 0;
    this.lastSpeedCount = 0;
    // The speed test's verdict: true for a server limiting each connection, false for a shared line.
    /** @type {boolean|null} */
    this.perConnection = null;
    // Whether perConnection is a verdict: a test cut short leaves the guess of its last round.
    this.perConnectionFound = false;
    this.lastFailed = 0;
    this.stopping = false;
    this.droppedDownloaders = 0;
    // A server answered 429 or 503: this player stays careful, for the next video too.
    this.throttled = false;
    // Until when a server's Retry-After holds downloads back (Date.now() time).
    this.holdUntil = 0;
    this.slowDowns = 0;
    // Until when the player waits before probing the server speed again (Date.now() time).
    this.calmUntil = 0;
    this.lastSlowDown = 0;
    this.probing = false;
    // Retired while delivering: out of this.downloaders, but a reset, pause or destroy still stops them.
    /** @type {Set<StandardDownloader>} */
    this.retiring = new Set();

    this.failed = 0;

    this.blobStore = new FSBlob({memoryOnly: EnvUtils.isIncognito() || client?.options?.bufferToDisk === false});
    this.memoryFull = false;

    this.failedOffline = false;
    this.onNetworkBack = this.onNetworkBack.bind(this);
    globalThis.addEventListener?.('online', this.onNetworkBack);
  }

  /** Failed fragments wait again, and retries waiting out their backoff go now (FetchLoader.retryNow). */
  onNetworkBack() {
    if (!this.downloaders) return;
    // A downloader still making its request holds a stand-in without retryNow (StandardDownloader.run).
    for (const downloader of this.downloaders) downloader.loader?.retryNow?.();
    // Only after a failure offline: a link that failed for good is not retried at each Wi-Fi flap.
    if (this.failedOffline) {
      this.failedOffline = false;
      this.client?.resetFailed?.();
    }
  }

  /** @return {DownloadEntry[]} */
  getCompletedEntries() {
    /** @type {DownloadEntry[]} */
    const entries = [];
    this.storage.forEach((entry) => {
      if (entry.status === DownloadStatus.DOWNLOAD_COMPLETE) {
        entries.push(entry);
      }
    });
    return entries;
  }

  /** @param {DownloadEntry[]} entries */
  setEntries(entries) {
    entries.forEach((entry) => {
      this.setEntry(entry);
    });
  }

  /** @param {DownloadEntry} entry */
  async archiveEntryData(entry) {
    if (entry.status !== DownloadStatus.DOWNLOAD_COMPLETE || entry.storeRaw || typeof entry.data === 'function') {
      return;
    }

    const identifier = entry.blobId ?? this.getIdentifier(entry);
    // Kept in RAM; the client writes it to disk only when the RAM budget needs it to.
    await this.blobStore.saveBlobAsync(/** @type {Blob} */ (entry.data), identifier, {deferred: true});

    entry.data = () => {
      return this.blobStore.getBlob(identifier);
    };
  }

  /** @param {DownloadEntry} entry */
  setEntry(entry) {
    // A failed save (a full disk) leaves the data in memory.
    /** @param {DownloadEntry} done */
    const archive = (done) => this.archiveEntryData(done).catch((e) => console.warn('Could not archive a download', e));
    if (entry.status === DownloadStatus.DOWNLOAD_COMPLETE) {
      archive(entry);
    } else {
      entry.setTransferFunction(archive);
    }

    this.keepEntry(entry, this.getIdentifier(entry));
  }

  /**
   * @param {DownloadEntry} entry
   * @param {string} identifier
   */
  keepEntry(entry, identifier) {
    entry.onDataLost = (error) => {
      if (this.storage?.get(identifier) !== entry) return;
      console.warn('A stored download could not be read, it will be downloaded again', error);
      this.storage.delete(identifier);
      this.blobStore?.deleteBlob(entry.blobId ?? identifier);
    };
    this.storage.set(identifier, entry);
  }

  /**
   * @param {DownloadRequest} details
   * @return {boolean}
   */
  canGetFile(details) {
    const key = this.getIdentifier(details);
    const storedEntry = this.stored(details, key);

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

  /** @param {DownloadRequest} details */
  getEntry(details) {
    const key = this.getIdentifier(details);
    return this.stored(details, key);
  }

  /**
   * Under its address, or one handed over under the link's old signature, kept under this one from now on.
   * @param {DownloadRequest} details
   * @param {string} key
   * @return {*}
   */
  stored(details, key) {
    const entry = this.storage.get(key);
    if (entry || !this.adopted?.size) {
      return entry;
    }
    const loose = this.looseIdentifier(details);
    const adopted = this.adopted.get(loose);
    if (!adopted || this.storage.get(this.getIdentifier(adopted)) !== adopted) {
      return undefined;
    }
    this.adopted.delete(loose);
    // Under the new address now; its data stays where the store has it (blobId).
    const oldKey = this.getIdentifier(adopted);
    adopted.blobId ??= oldKey;
    this.storage.delete(oldKey);
    adopted.url = details.url;
    this.keepEntry(adopted, key);
    return adopted;
  }

  /**
   * @param {{url: string, rangeStart?: number, rangeEnd?: number, responseType?: string}} details
   * @return {string}
   */
  looseIdentifier(details) {
    return this.getIdentifier({...details, url: withoutSignature(details.url, this.adoptedSignature)});
  }

  /**
   * Keeps the downloads for a new link to the source (FreshLink): found without the signature.
   * @param {string} oldUrl
   * @param {string} newUrl
   */
  relink(oldUrl, newUrl) {
    const signature = signatureParams(oldUrl, newUrl);
    if (!signature?.size || !this.storage) {
      return;
    }
    this.adoptedSignature = signature;
    this.adopted = new Map();
    const adopted = /** @type {Map<string, DownloadEntry>} */ (this.adopted);
    this.storage.forEach((entry) => {
      const loose = this.looseIdentifier(entry);
      // The first of twins (one file under two issues of the link) stands for both.
      if (entry.status === DownloadStatus.DOWNLOAD_COMPLETE && !entry.storeRaw && entry.responseType === 'arraybuffer' &&
          !adopted.has(loose)) {
        adopted.set(loose, entry);
      }
    });
  }

  /**
   * The finished downloads as plain records for the next player after a reload (BufferStash).
   * Only a video's files, in RAM or in this session's OPFS.
   * @return {{session: ?string, entries: import('../../background/BufferStash.mjs').HandedEntry[]}}
   */
  handOff() {
    /** @type {import('../../background/BufferStash.mjs').HandedEntry[]} */
    const entries = [];
    const store = this.blobStore;
    const opfs = store?.opfsManager;
    this.storage?.forEach((entry, identifier) => {
      if (entry.status !== DownloadStatus.DOWNLOAD_COMPLETE || entry.storeRaw || entry.responseType !== 'arraybuffer' ||
          typeof entry.data !== 'function') {
        return;
      }
      const blobId = entry.blobId ?? identifier;
      const record = {url: entry.url, rangeStart: entry.rangeStart, rangeEnd: entry.rangeEnd,
        responseType: entry.responseType, dataSize: entry.dataSize};
      const data = store.blobStore.get(blobId);
      if (store.isInRam(blobId) && data instanceof Blob) {
        entries.push({...record, blob: data});
        return;
      }
      const file = opfs?.fileName(blobId);
      if (file) {
        entries.push({...record, file});
      }
    });
    return {session: opfs?.sessionName ?? null, entries};
  }

  /**
   * Takes back what an earlier player of this video handed over; its disk files are moved meanwhile.
   * @param {{url: string, session: ?string, entries: import('../../background/BufferStash.mjs').HandedEntry[]}} handOff
   * @param {string} url
   * @return {{taken: number, onDisk: Promise<number>}} Taken at once (RAM), and how many of the disk's once moved.
   */
  adopt(handOff, url) {
    const signature = signatureParams(handOff.url, url);
    if (signature === null || !this.blobStore) {
      return {taken: 0, onDisk: Promise.resolve(0)};
    }
    this.adoptedSignature = signature;
    this.adopted = new Map();
    let taken = 0;
    /** @type {AdoptedFile[]} */
    const disk = [];
    /** @type {Set<string>} */
    const seen = new Set();
    for (const record of handOff.entries) {
      if (typeof record?.url !== 'string' || record.responseType !== 'arraybuffer') continue;
      const entry = new DownloadEntry({url: record.url, rangeStart: record.rangeStart, rangeEnd: record.rangeEnd,
        responseType: record.responseType, headers: {}});
      const identifier = this.getIdentifier(entry);
      entry.status = DownloadStatus.DOWNLOAD_COMPLETE;
      entry.dataSize = record.dataSize || 0;
      entry.blobId = identifier;
      // One file under two issues of the link: taken once.
      const loose = this.looseIdentifier(entry);
      if (seen.has(loose)) continue;
      seen.add(loose);
      if (record.blob instanceof Blob) {
        if (this.storage.has(identifier)) continue;
        entry.data = record.blob;
        this.keepAdopted(entry);
        taken++;
      } else if (typeof record.file === 'string' && handOff.session) {
        if (this.storage.has(identifier)) continue;
        // Here at once, read once its file is moved: in its turn, or at once for a read that comes first.
        /** @type {AdoptedFile} */
        const item = {entry, identifier, session: handOff.session, file: record.file, generation: this.storageGeneration, moved: null};
        entry.data = async () => {
          try {
            return await this.adoptOne(item) ? await this.blobStore.getBlob(identifier) : undefined;
          } catch (e) {
            return undefined;
          }
        };
        this.keepAdopted(entry);
        disk.push(item);
      }
    }
    return {taken, onDisk: this.adoptDiskFiles(disk, handOff.session)};
  }

  /**
   * Moves one handed-over file into this session once, whoever asks first.
   * One that cannot be moved, or whose downloads went meanwhile, is dropped.
   * @param {AdoptedFile} item
   * @return {Promise<boolean>} Whether it is here.
   */
  adoptOne(item) {
    item.moved ??= (async () => {
      // Its downloads went meanwhile (a new source): the old session's files go with it (dropSession).
      if (this.storageGeneration !== item.generation) return false;
      const store = this.blobStore;
      let moved = false;
      try {
        moved = !!store && await store.adoptStoredFile(item.identifier, item.session, item.file);
      } catch (e) {
        moved = false;
      }
      // Let go of meanwhile: its file would stay with nothing to read or delete it.
      const kept = !item.entry.aborted && item.entry.status === DownloadStatus.DOWNLOAD_COMPLETE;
      if (moved && kept && this.blobStore === store && this.storageGeneration === item.generation) {
        return true;
      }
      // The same part downloaded again meanwhile is saved under the same key: that file is the new download's now.
      const current = this.blobStore === store ? this.storage?.get(item.identifier) : undefined;
      if (moved && (!current || current === item.entry)) store.deleteBlob(item.identifier);
      if (this.storageGeneration === item.generation) {
        item.entry.onDataLost?.(new Error('A handed-over download could not be moved here'));
      }
      return false;
    })();
    return item.moved;
  }

  /** @param {DownloadEntry} entry */
  keepAdopted(entry) {
    this.setEntry(entry);
    if (this.adoptedSignature?.size) {
      /** @type {Map<string, DownloadEntry>} */ (this.adopted).set(this.looseIdentifier(entry), entry);
    }
  }

  /**
   * A few at a time while the player starts: each takes a few ms, and a long video has thousands.
   * @param {AdoptedFile[]} disk
   * @param {?string} session
   * @return {Promise<number>}
   */
  async adoptDiskFiles(disk, session) {
    const store = this.blobStore;
    let taken = 0;
    for (let i = 0; i < disk.length && session; i += AdoptAtOnce) {
      const moved = await Promise.all(disk.slice(i, i + AdoptAtOnce).map((item) => this.adoptOne(item)));
      taken += moved.filter(Boolean).length;
    }
    if (session && this.blobStore === store) {
      store.dropSession(session);
    }
    return taken;
  }

  /**
   * A live manifest loaded again: its stored copy is the old window. A copy still downloading stays.
   * @param {DownloadRequest} details
   */
  forgetCompletedFile(details) {
    if (this.getEntry(details)?.status === DownloadStatus.DOWNLOAD_COMPLETE) {
      this.removeFile(details);
    }
  }

  /** @param {DownloadRequest} details */
  removeFile(details) {
    const key = this.getIdentifier(details);
    const storedEntry = this.stored(details, key);
    if (storedEntry) {
      // Out of the queue too: left there failed, it kept canGetFile saying no to every download ahead.
      const queued = this.queue.indexOf(storedEntry);
      if (queued !== -1) this.queue.splice(queued, 1);
      storedEntry.destroy();
      this.storage.delete(key);
      this.blobStore.deleteBlob(storedEntry.blobId ?? key);
    }
  }

  destroy() {
    globalThis.removeEventListener?.('online', this.onNetworkBack);
    // queueNext's retry after a failure would find no downloaders left.
    clearTimeout(/** @type {ReturnType<typeof setTimeout>|undefined} */ (this.failCooldown));
    this.failCooldown = null;
    this.abortRetiring();
    this.downloaders.forEach((downloader) => {
      downloader.destroy();
    });
    // Gone with the manager: typed as the live fields they are until here.
    this.downloaders = /** @type {any} */ (null);
    this.storage = /** @type {any} */ (null);
    this.blobStore.close();
    this.blobStore = /** @type {any} */ (null);
  }

  /**
   * A stored one answers at once, one already asked for is joined, a new one is queued by priority.
   * @param {import('./DownloadEntry.mjs').DownloadDetails} details
   * @param {import('./DownloadEntry.mjs').DownloadCallbacks} callbacks
   * @param {number} [priority] - Higher first: 0 by default, a save's -1, playback's PLAYBACK_PRIORITY.
   * @return {import('./DownloadEntry.mjs').DownloadWatcher}
   */
  getFile(details, callbacks, priority) {
    priority = priority || 0;
    const key = this.getIdentifier(details);
    let storedEntry = this.stored(details, key);

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

    /** @type {import('./DownloadEntry.mjs').DownloadWatcher} */
    const watcher = {
      entry: storedEntry,
      priority,
      abort: () => {
        this.letGo(watcher);
      },
      callbacks: callbacks,

    };

    storedEntry.addWatcher(watcher);

    if (storedEntry.status === DownloadStatus.ENQUEUED && storedEntry.priority < priority) {
      storedEntry.status = DownloadStatus.WAITING;
      const ind = this.queue.indexOf(storedEntry);
      if (ind !== -1) {
        this.queue.splice(ind, 1);
      }
    }

    if (storedEntry.status === DownloadStatus.WAITING) {
      storedEntry.priority = priority;

      let ind = this.queue.length;
      while (ind > 0 && this.queue[ind - 1].priority < priority) {
        ind--;
      }
      this.queue.splice(ind, 0, storedEntry);

      storedEntry.status = DownloadStatus.ENQUEUED;
      this.queueNext();
    } else if (storedEntry.status === DownloadStatus.ENQUEUED) {
      // Started if a downloader is free: an entry queued during a reset waits for a queueNext.
      this.queueNext();
    } else if (storedEntry.status === DownloadStatus.DOWNLOAD_INITIATED && storedEntry.priority < priority) {
      // Joined while it downloads: a retry goes out with the higher priority.
      storedEntry.priority = priority;
    }

    return watcher;
  }

  /**
   * The last hold stops it; the others keep the highest priority they asked for.
   * One playback let go of outside the playhead's window is cancelled now, while the player keeps to it.
   * @param {import('./DownloadEntry.mjs').DownloadWatcher} watcher
   */
  letGo(watcher) {
    const entry = watcher.entry;
    entry.abortWatcher(watcher);
    if (!entry.watchers.length && entry.status !== DownloadStatus.ENQUEUED) {
      // Out of the queue, as removeFile takes one.
      const queued = this.queue.indexOf(entry);
      if (queued !== -1) this.queue.splice(queued, 1);
    }
    // Destroyed (a player gone, its loaders giving up after): nothing to reorder or cancel.
    if (!entry.watchers.length || !this.downloaders) return;
    const priority = Math.max(...entry.watchers.map((other) => other.priority ?? 0));
    const was = entry.priority || 0;
    if (priority >= was) return;
    if (entry.status === DownloadStatus.ENQUEUED) {
      const index = this.queue.indexOf(entry);
      if (index !== -1) this.queue.splice(index, 1);
      entry.priority = priority;
      this.requeueEntry(entry);
    } else if (entry.status === DownloadStatus.DOWNLOAD_INITIATED) {
      entry.priority = priority;
    } else {
      return;
    }
    if (was >= PLAYBACK_PRIORITY && priority < PLAYBACK_PRIORITY && this.client?.concentrating) {
      this.client.cancelFarDownloads();
    }
  }

  getSpeed() {
    let totalSpeed = 0;
    this.downloaders.forEach((downloader) => {
      totalSpeed += downloader.getSpeed();
    });

    return totalSpeed;
  }

  /**
   * The option, 1 to 6 (a browser's limit per server): none is 6, and 0 is the least that downloads, 1.
   * @return {number}
   */
  downloaderLimit() {
    const limit = this.client?.options?.maximumDownloaders;
    return Number.isFinite(limit) && limit >= 0 ? Math.min(Math.max(Math.floor(limit), 1), 6) : 6;
  }

  addDownloader() {
    this.testing = false;
    this.droppedDownloaders = 0;
    this.downloaders.push(new StandardDownloader(this));
    // The user's choice (the add-downloader key): all of them run, short of video too.
    this.perConnection = true;
    this.perConnectionFound = true;
    this.client.predownloadFragments();
    this.queueNext();
  }

  /**
   * @param {number} status
   * @param {string} url
   */
  linkRefused(status, url) {
    this.client?.linkRefused?.(status, url);
  }

  /**
   * Half the downloaders go, and every download waits for the Retry-After.
   * After a calm period, doubling with each slow-down in a row, the speed test probes again.
   * @param {number|null} [retryAfter] - In ms; null when the server named none.
   */
  slowDown(retryAfter) {
    if (!this.downloaders) return;
    const now = Date.now();
    if (/** @type {number} */ (retryAfter) > 0) {
      this.holdUntil = Math.max(this.holdUntil, now + Math.min(/** @type {number} */ (retryAfter), DownloadManager.MaxRetryAfterMs));
    }
    if (now - this.lastSlowDown < DownloadManager.SlowDownSettleMs) {
      return;
    }
    this.lastSlowDown = now;
    this.throttled = true;
    this.testing = false;
    this.probing = false;
    // Short of video, two at most again until a probe finds that more add speed.
    this.perConnection = null;
    this.perConnectionFound = false;
    this.droppedDownloaders = 0;
    this.lastFailed = now;
    this.slowDowns++;
    this.calmUntil = now + Math.min(
        Math.max(DownloadManager.CalmPeriodMs, retryAfter || 0) * Math.pow(2, this.slowDowns - 1),
        DownloadManager.MaxCalmPeriodMs,
    );
    // retire() hands a download back to the queue without its watchers hearing of it.
    const keep = Math.max(1, Math.floor(this.downloaders.length / 2));
    for (const cut of this.downloaders.splice(keep)) {
      if (cut.delivering) this.retiring.add(cut);
      cut.retire();
    }
    this.client?.resetFailed?.();
    console.log('The server asked to slow down: ' + this.downloaders.length + ' downloader(s) now');
  }

  /**
   * One ended by failures waits another calm period, or every next success would start it at once.
   * @param {boolean} found
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
   * A download cut by a slow-down resumes without its watchers hearing; one they gave up on stays out.
   * @param {DownloadEntry} entry
   */
  requeueEntry(entry) {
    if (!this.downloaders) return;
    if (entry.status === DownloadStatus.DOWNLOAD_FAILED || entry.status === DownloadStatus.DOWNLOAD_COMPLETE) {
      return;
    }
    entry.status = DownloadStatus.ENQUEUED;
    const priority = entry.priority || 0;
    entry.priority = priority;
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
    if (!downloader) {
      return;
    }
    downloader.abort();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.abortRetiring();
    this.stopDownloaders(this.downloaders);
  }

  /**
   * Stops downloaders on purpose (a new source, a failed load, a pause): no failure is counted.
   * @param {Iterable<StandardDownloader>} downloaders
   */
  stopDownloaders(downloaders) {
    const stopping = this.stopping;
    this.stopping = true;
    try {
      for (const downloader of Array.from(downloaders)) {
        downloader.abort();
      }
    } finally {
      this.stopping = stopping;
    }
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
   * Leaves the network to a watched player short of video: downloads ahead are cancelled, the rest go 'low'.
   * Not pause(): that is the user's. A paused player holds its playback's requests too.
   * @param {boolean} yielding
   * @param {boolean} [holdPlayback]
   */
  setYield(yielding, holdPlayback = false) {
    if (!this.downloaders) return;
    const hold = yielding && holdPlayback;
    const holdChanged = this.yieldHold !== hold;
    const yieldChanged = this.yielding !== yielding;
    // Both set before anything starts again: queueNext and the client read them.
    this.yieldHold = hold;
    this.holdingPlayback = hold || this.waitHold;
    this.yielding = yielding;
    if (yieldChanged && yielding) {
      // Not a save's (priority below 0: the user asked for it), nor what playback waits for.
      /** @param {DownloadEntry} entry */
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
        entry.abort();
      }
    }
    if (yieldChanged && !yielding) {
      this.client?.predownloadFragments?.();
    }
    if (yieldChanged || holdChanged) {
      this.queueNext();
    }
  }

  /**
   * Softer than setYield: nothing is cancelled, no new downloads ahead start, what goes out is 'low'.
   * @param {boolean} waiting
   * @param {boolean} [holdPlayback]
   */
  setWaiting(waiting, holdPlayback = false) {
    if (!this.downloaders) return;
    const hold = waiting && holdPlayback;
    const changed = this.waiting !== waiting;
    const holdChanged = this.waitHold !== hold;
    if (!changed && !holdChanged) return;
    this.waiting = waiting;
    this.waitHold = hold;
    this.holdingPlayback = this.yieldHold || hold;
    if (changed && !waiting) this.client?.predownloadFragments?.();
    if ((changed && !waiting) || holdChanged) this.queueNext();
  }

  /**
   * Goes down when a running download is cancelled: PlayerPeers reads only how fast it grows.
   * @return {number}
   */
  received() {
    let bytes = this.receivedDone;
    for (const downloader of this.downloaders || []) {
      if (downloader.entry) bytes += downloader.loader?.stats?.loaded || 0;
    }
    return bytes;
  }

  /**
   * Not one playback waits for, nor one being delivered. A running one goes however far it is in.
   * @param {DownloadRequest} details
   * @return {boolean}
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
    entry.abort();
    return true;
  }

  /**
   * Running downloads: a player short of video runs fewer than its downloaders, a yielding one none.
   * @return {number}
   */
  runningCount() {
    if (!this.downloaders) return 0;
    return this.downloaders.filter((downloader) => downloader.entry).length;
  }

  /**
   * Two on a shared line; all of them while the speed test runs or for a server limiting each connection.
   * @return {number}
   */
  urgentParallel() {
    if (!this.downloaders) return URGENT_PARALLEL;
    return this.testing || this.perConnection ? Math.max(URGENT_PARALLEL, this.downloaders.length) : URGENT_PARALLEL;
  }

  /**
   * Only once the speed test is done: not before, nor after a slow-down until a probe measured again.
   * @return {boolean}
   */
  sharesLine() {
    return !this.testing && this.perConnection === false;
  }

  /**
   * Not while the test runs, nor after one cut short: a gain early on is taken back by a flat round.
   * @return {boolean}
   */
  limitedPerConnection() {
    return !this.testing && this.perConnectionFound && this.perConnection === true;
  }

  /**
   * Idle downloaders read slower for 10 s, which the test would take for a shared line:
   * nothing measured while held counts, and the speeds start afresh when it ends.
   * @param {boolean} held
   */
  holdTest(held) {
    held = held && this.testing;
    if (held === this.testHeld) return;
    this.testHeld = held;
    this.speedTestBuffer = [];
    this.speedTestSeen = new Set();
    if (!held) {
      for (const downloader of this.downloaders || []) downloader.resetSpeed();
    }
  }

  /** @return {boolean} */
  playbackAsked() {
    const playback = (/** @type {DownloadEntry|null|undefined} */ entry) => !!entry && (entry.priority || 0) >= PLAYBACK_PRIORITY;
    return this.queue.some(playback) || !!this.downloaders?.some((downloader) => playback(downloader.entry));
  }

  /** @return {number} */
  activeCount() {
    if (!this.downloaders) return 0;
    return this.downloaders.filter((downloader) => downloader.entry).length + this.queue.length;
  }

  /** @return {number} */
  ramBytes() {
    return this.blobStore?.ramBytes() || 0;
  }

  /**
   * @param {DownloadRequest} details
   * @return {number}
   */
  ramBytesOf(details) {
    return this.blobStore?.inRam.get(this.blobKey(details)) || 0;
  }

  /**
   * A download taken over under a new link keeps its data under the old key (blobId).
   * @param {DownloadRequest} details
   * @return {string}
   */
  blobKey(details) {
    const key = this.getIdentifier(details);
    return this.storage?.get(key)?.blobId ?? key;
  }

  /** @return {number} */
  spillingBytes() {
    return this.blobStore?.spillingBytes() || 0;
  }

  /**
   * @param {DownloadRequest} details
   * @return {boolean}
   */
  isSpilling(details) {
    return !!this.blobStore?.isSpilling(this.blobKey(details));
  }

  /**
   * @param {DownloadRequest} details
   * @return {boolean}
   */
  isInRam(details) {
    return !!this.blobStore?.isInRam(this.blobKey(details));
  }

  /**
   * @param {DownloadRequest} details
   * @return {Promise<boolean>}
   */
  spill(details) {
    return this.blobStore?.spill(this.blobKey(details)) ?? Promise.resolve(false);
  }

  /** @param {boolean} allowed */
  setBufferToDisk(allowed) {
    this.blobStore?.setMemoryOnly(EnvUtils.isIncognito() || !allowed);
  }

  /**
   * @return {boolean} Not in a private window, with "Keep video on disk" off, or once no disk store works.
   */
  canSpill() {
    return !!this.blobStore && !this.blobStore.memoryOnly && !this.blobStore.diskGone;
  }

  removeAllDownloaders() {
    this.testing = false;
    this.droppedDownloaders = 0;
    this.abortRetiring();
    this.stopDownloaders(this.downloaders);
    this.downloaders.length = 0;
  }

  abortRetiring() {
    const retiring = Array.from(this.retiring);
    this.retiring.clear();
    this.stopDownloaders(retiring);
  }

  /**
   * @param {StandardDownloader} downloader
   * @param {DownloadEntry} entry
   */
  onDownloaderFinished(downloader, entry) {
    this.retiring.delete(downloader);
    if (this.paused || !this.downloaders || this.stopping) return;

    const failed = entry.status === DownloadStatus.DOWNLOAD_FAILED && !entry.aborted;
    if (entry.status === DownloadStatus.DOWNLOAD_COMPLETE) this.receivedDone += downloader.stats?.loaded || 0;
    // A 429/503 was handled by slowDown when it came: no ordinary failure.
    const slowDownStatus = failed && /** @type {(number|undefined)[]} */ (DownloadManager.SlowDownStatuses).includes(downloader.stats?.error?.code);
    if (slowDownStatus) {
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
    } else if (failed) {
      // Offline: no downloader taken away; its fragment waits again when the network is back.
      this.failedOffline = true;
    } else if (entry.status === DownloadStatus.DOWNLOAD_COMPLETE && this.droppedDownloaders > 0 &&
        Date.now() - this.lastFailed > DownloadManager.FailureRecoveryMs) {
      // Each success brings back one downloader a failure took away.
      this.droppedDownloaders--;
      // The speed test may have filled the limit meanwhile, or the option lowered it.
      if (this.downloaders.length < this.downloaderLimit()) {
        this.downloaders.push(new StandardDownloader(this));
      } else {
        this.droppedDownloaders = 0;
      }
    }

    // Past the calm period, a successful download starts the speed test again.
    if (entry.status === DownloadStatus.DOWNLOAD_COMPLETE && this.downloaders.includes(downloader) &&
        this.throttled && !this.testing && this.calmUntil &&
        Date.now() >= Math.max(this.calmUntil, this.holdUntil)) {
      this.probing = true;
      this.testing = true;
      this.perConnectionFound = false;
      this.failed = 0;
      this.speedTestBuffer = [];
      this.speedTestSeen = new Set();
      this.lastSpeed = 0;
      console.log('Calm period over, probing the server speed');
    }

    if (this.testing && !this.testHeld) {
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
          // Each downloader heard once with a speed: a sample without one (a cache hit) does not count.
          if (downloader.getSpeed()) {
            this.speedTestSeen.add(downloader);
          }

          if (this.downloaders.every((d) => this.speedTestSeen.has(d))) {
            let speed = this.getSpeed();

            this.speedTestBuffer.push(speed);
            this.speedTestSeen = new Set();

            if (this.speedTestBuffer.length >= DownloadManager.SamplesPerStep) {
              speed = this.speedTestBuffer.reduce((a, b) => a + b, 0) / this.speedTestBuffer.length;
              this.speedTestBuffer = [];

              if (speed > this.lastSpeed) {
                // Each one added brought at least half its share; only a round of exactly one more tells.
                if (this.lastSpeed > 0 && this.downloaders.length === this.lastSpeedCount + 1) {
                  const share = speed >= this.lastSpeed * (1 + 0.5 / this.lastSpeedCount);
                  this.perConnection = this.perConnection !== false && share;
                }
                if (this.downloaders.length < this.downloaderLimit()) {
                  console.log('Adding downloader, speed: ' + speed);
                  this.lastSpeedCount = this.downloaders.length;
                  this.downloaders.push(new StandardDownloader(this));
                  this.lastSpeed = speed;
                } else {
                  this.testing = false;
                  this.perConnectionFound = true;
                  this.endProbe(true);
                  console.log('Speed test finished (maxed out), speed: ' + this.getSpeed());
                }
              } else {
                console.log('Speed test finished, speed: ' + speed);
                this.testing = false;
                this.perConnection = false;
                this.perConnectionFound = true;
                this.endProbe(true);
              }
            }
          }
        }
      }
    }


    this.client.predownloadFragments();
    this.queueNext();
    // The others hear at once: a background tab's next tick may be 15 s away.
    this.client.updatePeers?.();
  }

  queueNext() {
    while (!this.paused && this.queue.length > 0) {
      if (this.queue[0].status !== DownloadStatus.ENQUEUED) {
        this.queue.shift();
        continue;
      }
      // A paused yielding player starts only a save (priority below 0), not its own playback.
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
        // An entry has no details: canHandle is given undefined, and reads nothing.
        return downloader.canHandle(/** @type {DownloadEntry & {details?: undefined}} */ (this.queue[index]).details);
      });
      if (!downloader) return;

      const entry = this.queue.splice(index, 1)[0];
      downloader.run(entry);
    }
  }

  /**
   * @param {DownloadRequest} details
   * @return {string}
   */
  getIdentifier(details) {
    const url = details.url;
    const rangeStart = details.rangeStart;
    const rangeEnd = details.rangeEnd;
    const responseType = details.responseType;

    return url + '::' + rangeStart + '-' + rangeEnd + '::' + responseType;
  }

  async reset() {
    // Destroyed: nothing to reset.
    if (!this.downloaders) return;
    // A reset begun while this one waits for its storage owns the downloaders.
    const resetting = this.resetting = {};
    this.abortAll();
    this.failedOffline = false;

    this.testing = true;
    this.testHeld = false;
    this.downloaders = [];
    this.droppedDownloaders = 0;
    this.speedTestBuffer = [];
    this.speedTestSeen = new Set();
    this.lastSpeed = 0;
    this.perConnection = null;
    this.perConnectionFound = false;

    this.failed = 0;
    this.holdUntil = 0;
    this.lastSlowDown = 0;
    // A failure's cooldown is the last video's.
    this.lastFailed = 0;
    // After a server throttled, the next video's speed test is a probe.
    this.probing = this.throttled;
    this.calmUntil = this.throttled ? Date.now() + DownloadManager.CalmPeriodMs : 0;

    // keepStorageOnce() asks for this reset only; resetOverride() for as long as it is on.
    const keep = this.dontClearStorage || this.keepStorageNext;
    this.keepStorageNext = false;
    this.memoryFull = false;
    this.lastHost = '';
    if (!keep) {
      await this.clearStorage();
    }
    if (this.resetting !== resetting) return;

    const start = this.throttled ? 1 : Math.min(DownloadManager.StartDownloaders, this.downloaderLimit());
    for (let i = 0; i < start; i++) {
      this.downloaders?.push(new StandardDownloader(this));
    }
    // A player set up during the reset's await may have queued its manifest: nothing else starts it.
    if (this.downloaders) this.queueNext();
  }

  /** @param {boolean} value */
  resetOverride(value) {
    this.dontClearStorage = value;
  }

  /**
   * Only the next reset() keeps the downloads (recoverPlayer); resetOverride() is the save manager's switch.
   */
  keepStorageOnce() {
    this.keepStorageNext = true;
  }

  async clearStorage() {
    this.storageGeneration++;
    this.storage.clear();
    this.adopted = null;
    this.adoptedSignature = null;
    await this.blobStore.clear();
  }

  abortAll() {
    this.queue.forEach((entry) => {
      entry.abort();
    });
    this.queue.length = 0;
    this.abortRetiring();
    this.stopDownloaders(this.downloaders);
  }

  getStorageByteCount() {
    let count = 0;
    this.storage.forEach((entry) => {
      count += entry.getDataSize();
    });
    return count;
  }
}
