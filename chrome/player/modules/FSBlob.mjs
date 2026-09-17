import {IndexedDBManager} from '../network/IndexedDBManager.mjs';
import {OPFSManager} from '../network/OPFSManager.mjs';
import {AlertPolyfill} from '../utils/AlertPolyfill.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {Localize} from './Localize.mjs';

const BrowserCanAutoOffloadBlobs = EnvUtils.isChrome();
// Offloading backends in preference order. OPFS (via a worker-owned
// FileSystemSyncAccessHandle) beats the Cache API round trip where it works -
// currently Firefox only, since Chrome already offloads Blob storage on its
// own, which is why the chain is empty there.
//
// Each entry is only a *claim* of support. Every one of these APIs can be
// present and still refuse at runtime, so a backend whose setup() rejects
// hands off to the next one in the chain (see ready()) instead of dropping
// straight to memory. A Firefox private window is exactly that case: it
// exposes navigator.storage.getDirectory and throws SecurityError the moment
// OPFS actually calls it, while the Cache API right behind it works normally.
// Going to memory there would put every buffered fragment in RAM for no
// reason.
const BackendChain = BrowserCanAutoOffloadBlobs ?
  [] : ['opfs', 'cache', 'indexeddb'];

export class FSBlob {
  constructor() {
    this.blobStore = new Map();
    this.blobStorePromises = new Map();
    this.opfsManager = null;
    this.cache = null;
    this.indexedDBManager = null;
    this.setupPromise = null;
    this.remainingBackends = BackendChain.slice();

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
      this.blobStore.set(identifier, file);
      return true;
    } catch (e) {
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

      if (EnvUtils.isFirefox()) {
        // Delete file to orphan it
        await this.indexedDBManager.deleteFile(identifier);
      }

      this.blobStore.set(identifier, file);
      return true;
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

    try {
      await this.cache.put(identifierURL, new Response(blob));

      const match = await this.cache.match(identifierURL);
      const blobResponse = await match?.blob();

      if (!blobResponse) {
        // put() resolved but match() came back empty (eviction under quota
        // pressure, or some other Cache API surprise) - leave the original
        // in-memory blob in blobStore alone rather than overwrite it with
        // undefined and silently lose the data.
        console.warn('Cache write could not be verified for this blob, keeping it in memory');
        return false;
      }

      this.blobStore.set(identifier, blobResponse);
      return true;
    } catch (e) {
      // A single write failing (e.g. quota exceeded mid-session) doesn't
      // mean the Cache API is broken for everything else - leave this.cache
      // in place and just keep this one blob in memory instead.
      console.warn('Cache write failed for this blob, keeping it in memory', e);
      return false;
    }
  }

  getIdentifierURL(identifier) {
    return 'https://faststream.online/blob-cache?identifier=' + encodeURIComponent(identifier);
  }

  nextIdentifier() {
    return `blob${this.blobIndex++}`;
  }

  async saveBlobAsync(blob, identifier) {
    if (!identifier) {
      identifier = this.nextIdentifier();
    }
    this.blobStore.set(identifier, blob);
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
    if (!await this.ready()) return false;
    if (this.opfsManager) return this.saveBlobInOPFSAsync(identifier, blob);
    if (this.cache) return this.saveBlobUsingCache(identifier, blob);
    if (this.indexedDBManager) return this.saveBlobInIndexedDBAsync(identifier, blob);
    return false;
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

    if (this.blobStorePromises.has(identifier)) {
      await this.blobStorePromises.get(identifier);
    }

    this.blobStore.delete(identifier);
    this.blobStorePromises.delete(identifier);

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

  getBlob(identifier) {
    return this.blobStore.get(identifier);
  }

  async clear() {
    this.blobStore.clear();
    this.blobStorePromises.clear();

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
