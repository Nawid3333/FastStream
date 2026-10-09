import {IndexedDBManager} from '../network/IndexedDBManager.mjs';
import {OPFSManager} from '../network/OPFSManager.mjs';
import {AlertPolyfill} from '../utils/AlertPolyfill.mjs';
import {Localize} from './Localize.mjs';

// Offloading backends in preference order. OPFS (via a worker-owned
// FileSystemSyncAccessHandle) beats the Cache API round trip where it works.
//
// Each entry is only a *claim* of support. Every one of these APIs can be
// present and still refuse at runtime, so a backend whose setup() rejects
// hands off to the next one in the chain (see ready()) instead of dropping
// straight to memory. A Firefox private window is exactly that case: it
// exposes navigator.storage.getDirectory and throws SecurityError the moment
// OPFS actually calls it, while the Cache API right behind it works normally.
// Going to memory there would put every buffered fragment in RAM for no
// reason.
const BackendChain = ['opfs', 'cache', 'indexeddb'];

// What blobStore holds for a blob the Cache API has: it is read from there when asked for
// (getBlob), not kept. Reading each one back at once (match().blob()) made a copy in RAM,
// and in a private window always one: Firefox keeps a private Response.blob() in memory
// (dom/fetch/Fetch.cpp, MutableBlobStorage::eOnlyInMemory), so every fragment of the
// 300 s a private window keeps sat in RAM, beside the Cache API's encrypted copy on disk
// (storage/private), for every player tab.
const IN_CACHE = Symbol('in the Cache API');

export class FSBlob {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.memoryOnly] - Never write to disk: a private window's store,
   *   as Firefox keeps a private window's media in RAM (browser.privatebrowsing.
   *   forceMediaMemoryCache). Its blobs stay in RAM, and what does not fit in the RAM budget
   *   is let go of and downloaded again when needed (FastStreamClient.enforceMemoryBudget).
   */
  constructor({memoryOnly = false} = {}) {
    this.blobStore = new Map();
    this.blobStorePromises = new Map();
    this.memoryOnly = memoryOnly;
    // The blobs held in RAM, with their sizes: a deferred save keeps its blob here until
    // spill() writes it to disk (the RAM budget, FastStreamClient.enforceMemoryBudget).
    /** @type {Map<string, number>} */
    this.inRam = new Map();
    // The ones being written to disk now.
    /** @type {Set<string>} */
    this.spilling = new Set();
    // Counts clear()s, so an offload that finishes after one can tell (offloadBlob).
    this.generation = 0;
    this.opfsManager = null;
    this.cache = null;
    this.indexedDBManager = null;
    this.setupPromise = null;
    this.remainingBackends = memoryOnly ? [] : BackendChain.slice();

    try {
      this.activateNextBackend();
    } catch (e) {
      // activateNextBackend() already absorbs a single backend's failure and
      // moves on, so reaching this means something more fundamental broke.
      // Memory storage still works; warn and say so.
      console.warn('FSBlob setup failed, falling back to memory storage', e);
      this.opfsManager = null;
      this.cache = null;
      this.indexedDBManager = null;
      this.setupPromise = null;
      this.blobStorePromises.clear();
      AlertPolyfill.alert(Localize.getMessage('player_outofstorage'));
    }

    this.blobIndex = 0;
  }

  /**
   * Starts the most-preferred backend that still claims support, consuming
   * the chain as it goes. Leaves every backend field null - plain in-memory
   * storage - once the chain runs out.
   */
  activateNextBackend() {
    this.opfsManager = null;
    this.cache = null;
    this.indexedDBManager = null;
    this.setupPromise = null;

    while (this.remainingBackends.length) {
      const backend = this.remainingBackends.shift();
      try {
        if (backend === 'opfs') {
          if (!OPFSManager.isSupported()) continue;
          this.opfsManager = new OPFSManager();
          this.setupPromise = this.opfsManager.setup();
          // Best-effort: makes OPFS data less likely to be evicted under
          // storage pressure during a long buffer-heavy session. Never
          // requested anywhere else in the codebase today.
          navigator.storage?.persist?.().catch(() => {});
        } else if (backend === 'cache') {
          if (!window.caches) continue;
          this.cache = true;
          this.setupPromise = this.setupOrphanedCache();
        } else {
          if (!IndexedDBManager.isSupported()) continue;
          this.indexedDBManager = new IndexedDBManager();
          this.setupPromise = this.indexedDBManager.setup();
        }
      } catch (e) {
        // A constructor that throws outright is the same kind of "claimed
        // but unusable" as a setup() that rejects - keep walking the chain.
        console.warn(`FSBlob ${backend} backend could not be started`, e);
        this.opfsManager = null;
        this.cache = null;
        this.indexedDBManager = null;
        this.setupPromise = null;
        continue;
      }
      // ready() is what actually handles a rejected setup. This second,
      // silent .catch() only exists to stop an instance that never gets used
      // (constructed, then the tab/player closes before anything awaits it)
      // from surfacing as an unhandled promise rejection.
      this.setupPromise?.catch?.(() => {});
      return;
    }
  }

  /**
   * Awaits the active backend's setup and, if it failed, moves on to the
   * next backend in the chain before answering.
   *
   * Every async entry point goes through this, and none of them may reject
   * because of it. clear() and deleteBlob() used to await the OPFS manager
   * directly, so a private window's SecurityError travelled up through
   * DownloadManager.reset() into FastStreamClient.setSource(), whose catch
   * abandoned player creation - FastStream came up with no <video> element
   * at all in every Firefox private window.
   *
   * @return {Promise<boolean>} true when an offloading backend is live,
   *     false when storage is now plain memory
   */
  async ready() {
    for (;;) {
      const attempt = this.setupPromise;
      if (!attempt) return false;
      try {
        await attempt;
        return true;
      } catch (e) {
        // Concurrent callers all wake on the same rejection; only the first
        // one through advances the chain, or they would skip backends.
        if (this.setupPromise === attempt) {
          console.warn('FSBlob backend setup failed, trying the next backend', e);
          this.opfsManager?.close();
          this.blobStorePromises.clear();
          this.activateNextBackend();
        }
      }
    }
  }

  async setupOrphanedCache() {
    const cacheName = 'blob-cache-' + Date.now() + '-' + Math.random();
    const cache = await window.caches.open(cacheName);
    // Orphan it!
    await window.caches.delete(cacheName);
    // Store the cache reference for later use
    this.cache = cache;
  }

  async saveBlobInOPFSAsync(identifier, blob) {
    // Setup is already settled and the backend re-checked by offloadBlob().
    try {
      await this.opfsManager.setFile(identifier, blob);
      const file = await this.opfsManager.getFile(identifier);
      return this.replaceIfStill(identifier, blob, file);
    } catch (e) {
      if (this.opfsManager && !this.opfsManager.worker) {
        // The worker is gone (it crashed, or stopped answering): OPFS is over for this
        // session. Every later fragment stayed in RAM; the next backend takes them now.
        console.warn('The OPFS worker is gone, moving to the next storage backend', e);
        this.opfsManager.close();
        this.activateNextBackend();
        return this.offloadBlob(identifier, blob);
      }
      // A single write failing (e.g. quota exceeded mid-session) doesn't
      // mean OPFS is broken for everything else - leave opfsManager in
      // place and just keep this one blob in memory instead.
      console.warn('OPFS write failed for this blob, keeping it in memory', e);
      return false;
    }
  }

  async saveBlobInIndexedDBAsync(identifier, blob) {
    try {
      // Store file
      await this.indexedDBManager.setFile(identifier, blob);
      // Get file
      const file = await this.indexedDBManager.getFile(identifier);

      // Delete file to orphan it
      await this.indexedDBManager.deleteFile(identifier);

      return this.replaceIfStill(identifier, blob, file);
    } catch (e) {
      // A single write failing (e.g. quota exceeded mid-session) doesn't
      // mean IndexedDB is broken for everything else - leave
      // indexedDBManager in place and just keep this one blob in memory
      // instead, same as the OPFS/Cache backends already do.
      console.warn('IndexedDB write failed for this blob, keeping it in memory', e);
      return false;
    }
  }

  async saveBlobUsingCache(identifier, blob) {
    const identifierURL = this.getIdentifierURL(identifier);
    // One cache for the put and the check: clear() replaces this.cache meanwhile.
    const cache = this.cache;

    try {
      await cache.put(identifierURL, new Response(blob));

      // Checked, not read: its body stays on disk until getBlob() asks for it. The
      // answer's unread body is let go of at once rather than when it is collected.
      const match = await cache.match(identifierURL);
      match?.body?.cancel().catch(() => {});

      if (!match) {
        // put() resolved but match() came back empty (eviction under quota
        // pressure, or some other Cache API surprise) - leave the original
        // in-memory blob in blobStore alone rather than overwrite it with
        // a marker for nothing and silently lose the data.
        console.warn('Cache write could not be verified for this blob, keeping it in memory');
        return false;
      }

      return this.replaceIfStill(identifier, blob, IN_CACHE);
    } catch (e) {
      // A single write failing (e.g. quota exceeded mid-session) doesn't
      // mean the Cache API is broken for everything else - leave this.cache
      // in place and just keep this one blob in memory instead.
      console.warn('Cache write failed for this blob, keeping it in memory', e);
      return false;
    }
  }

  /**
   * Puts what a backend stored in place of the blob held in RAM - only if that blob is still
   * the one held: the same identifier may have been deleted, cleared or saved again while the
   * backend wrote (a fragment let go of and downloaded again), and the old write's answer
   * put the old data back, or took the new one out of the RAM count.
   * @param {string} identifier
   * @param {Blob} blob - What was written.
   * @param {*} stored - What now stands for it (a File, IN_CACHE).
   * @return {boolean} Whether it took its place.
   */
  replaceIfStill(identifier, blob, stored) {
    if (this.blobStore.get(identifier) !== blob) return false;
    this.blobStore.set(identifier, stored);
    this.inRam.delete(identifier);
    return true;
  }

  getIdentifierURL(identifier) {
    return 'https://faststream.online/blob-cache?identifier=' + encodeURIComponent(identifier);
  }

  nextIdentifier() {
    return `blob${this.blobIndex++}`;
  }

  /**
   * Saves a blob, to disk at once unless deferred.
   * @param {Blob} blob
   * @param {string} [identifier]
   * @param {Object} [options]
   * @param {boolean} [options.deferred] - Keep it in RAM until spill() writes it to disk.
   *   Every downloaded fragment was written to disk at once (44 ms for 1.5 MB on OPFS,
   *   measured), and a video that fits in RAM never needed it.
   * @return {Promise<string>} Its identifier.
   */
  async saveBlobAsync(blob, identifier, {deferred = false} = {}) {
    if (!identifier) {
      identifier = this.nextIdentifier();
    }
    this.blobStore.set(identifier, blob);
    this.inRam.set(identifier, blob?.size || 0);
    if (deferred) {
      return identifier;
    }
    const promise = this.offloadBlob(identifier, blob);
    this.blobStorePromises.set(identifier, promise);

    await promise;

    return identifier;
  }

  /**
   * Hands one blob to whichever backend is live once setup has settled,
   * keeping it in memory when none is. The backend is re-read after the
   * await because ready() may have moved the chain along in the meantime.
   * @param {string} identifier
   * @param {Blob} blob
   * @return {Promise<boolean>} true when the blob reached a backend
   */
  async offloadBlob(identifier, blob) {
    const generation = this.generation;
    if (!await this.ready()) return false;
    let handled = false;
    if (this.opfsManager) {
      handled = await this.saveBlobInOPFSAsync(identifier, blob);
    } else if (this.cache) {
      handled = await this.saveBlobUsingCache(identifier, blob);
    } else if (this.indexedDBManager) {
      handled = await this.saveBlobInIndexedDBAsync(identifier, blob);
    }
    if (generation !== this.generation) {
      // clear() ran meanwhile: what the backend answered was not put back (replaceIfStill),
      // and whatever is under this identifier now is a newer save's.
      return false;
    }
    return handled;
  }

  /**
   * Writes a blob held in RAM to disk, and lets the RAM copy go once it is there. Nothing for
   * a memory-only store, a blob already on disk, or one already on its way.
   * @param {string} identifier
   * @return {Promise<boolean>} Whether it is on disk now.
   */
  async spill(identifier) {
    if (this.memoryOnly || !this.inRam.has(identifier) || this.spilling.has(identifier)) return false;
    const blob = this.blobStore.get(identifier);
    this.spilling.add(identifier);
    try {
      const promise = this.offloadBlob(identifier, blob).catch((e) => {
        console.warn('Could not write a blob to disk', e);
        return false;
      });
      this.blobStorePromises.set(identifier, promise);
      return await promise;
    } finally {
      this.spilling.delete(identifier);
    }
  }

  /**
   * Bytes of blobs held in RAM.
   * @return {number}
   */
  ramBytes() {
    let bytes = 0;
    for (const size of this.inRam.values()) bytes += size;
    return bytes;
  }

  /**
   * Bytes of blobs being written to disk now (spill()): RAM that is about to be let go of.
   * @return {number}
   */
  spillingBytes() {
    let bytes = 0;
    for (const identifier of this.spilling) bytes += this.inRam.get(identifier) || 0;
    return bytes;
  }

  /**
   * @param {string} identifier
   * @return {boolean} Whether the blob is held in RAM.
   */
  isInRam(identifier) {
    return this.inRam.has(identifier);
  }

  saveBlob(blob) {
    const identifier = this.nextIdentifier();
    this.saveBlobAsync(blob, identifier);
    return identifier;
  }

  createBlob(data) {
    const blob = new Blob([data], {type: 'application/octet-stream'});
    return this.saveBlob(blob);
  }

  async deleteBlob(identifier) {
    this.blobStore.delete(identifier);
    this.inRam.delete(identifier);

    if (this.blobStorePromises.has(identifier)) {
      await this.blobStorePromises.get(identifier);
    }

    this.blobStore.delete(identifier);
    this.blobStorePromises.delete(identifier);
    this.inRam.delete(identifier);

    if (!await this.ready()) return true;

    try {
      if (this.opfsManager) {
        await this.opfsManager.deleteFile(identifier);
      } else if (this.cache) {
        const identifierURL = this.getIdentifierURL(identifier);
        await this.cache.delete(identifierURL);
      } else if (this.indexedDBManager) {
        await this.indexedDBManager.deleteFile(identifier);
      }
    } catch (e) {
      // The blob is already gone from blobStore, so the caller has what it
      // asked for. A backend that can't drop its own copy is not worth
      // rejecting over - see clear() for where that rejection used to land.
      console.warn('FSBlob could not delete this blob from the backend', e);
    }

    return true;
  }

  /**
   * The blob saved under an identifier: the Blob or File itself, or - for one the Cache API
   * holds - a promise of it, read from there now. Every caller awaits what this gives.
   * @param {string} identifier
   * @return {Blob|File|Promise<Blob|undefined>|undefined} undefined once it is gone.
   */
  getBlob(identifier) {
    const blob = this.blobStore.get(identifier);
    if (blob !== IN_CACHE) return blob;
    return this.readFromCache(identifier);
  }

  /**
   * Reads a blob the Cache API holds.
   * @param {string} identifier
   * @return {Promise<Blob|undefined>} undefined when the cache no longer has it.
   */
  async readFromCache(identifier) {
    // A read during clear()'s new setup waits for it: the placeholder (cache === true) is
    // no answer, and "undefined" would have the download manager drop and fetch again
    // what is stored (DownloadEntry.onDataLost).
    await this.ready();
    const cache = this.cache;
    if (!cache || cache === true) return undefined;
    const match = await cache.match(this.getIdentifierURL(identifier));
    return match ? match.blob() : undefined;
  }

  /**
   * Settles once a blob saveBlob() or createBlob() took has reached the backend, or has
   * stayed in memory because it could not. A writer that waits for it keeps no more in RAM
   * than it chooses to (StreamSaver's memory sink).
   * @param {string} identifier
   * @return {Promise<*>}
   */
  whenStored(identifier) {
    return this.blobStorePromises.get(identifier) ?? Promise.resolve();
  }

  async clear() {
    this.blobStore.clear();
    this.blobStorePromises.clear();
    this.inRam.clear();
    // Offloads still running belong to what was cleared (offloadBlob).
    this.generation++;

    if (!await this.ready()) return;

    try {
      if (this.opfsManager) {
        await this.opfsManager.clearStorage();
      } else if (this.cache) {
        // Setup a new cache entirely
        this.cache = true;
        this.setupPromise = this.setupOrphanedCache();
        this.setupPromise.catch(() => {});
        await this.ready();
      } else if (this.indexedDBManager) {
        await this.indexedDBManager.clearStorage();
      }
    } catch (e) {
      // Wiping the backing store is best-effort: the in-memory maps are
      // already empty above, so the caller's invariant holds either way.
      // This must not reject - DownloadManager.reset() awaits it on the
      // FastStreamClient.setSource() path, and a rejection there is caught
      // as "setting the source failed" and leaves the player unbuilt.
      console.warn('FSBlob could not clear the backend', e);
    }
  }

  close() {
    return this.opfsManager?.close() ?? this.indexedDBManager?.close();
  }
}
