import {IndexedDBManager} from '../network/IndexedDBManager.mjs';
import {OPFSManager} from '../network/OPFSManager.mjs';
import {AlertPolyfill} from '../utils/AlertPolyfill.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {Localize} from './Localize.mjs';

const BrowserCanAutoOffloadBlobs = EnvUtils.isChrome();
// OPFS (via a worker-owned FileSystemSyncAccessHandle) is preferred over the
// Cache API round trip where it's available - currently Firefox only, since
// Chrome already offloads Blob storage on its own.
const UseOPFS = !BrowserCanAutoOffloadBlobs && OPFSManager.isSupported();
const UseCache = !BrowserCanAutoOffloadBlobs && !UseOPFS && !!window.caches;
const UseIndexedDB = !BrowserCanAutoOffloadBlobs && !UseOPFS && !UseCache && IndexedDBManager.isSupported();

export class FSBlob {
  constructor() {
    this.blobStore = new Map();
    this.blobStorePromises = new Map();

    try {
      if (UseOPFS) {
        this.opfsManager = new OPFSManager();
        this.setupPromise = this.opfsManager.setup();
        // Best-effort: makes OPFS data less likely to be evicted under
        // storage pressure during a long buffer-heavy session. Never
        // requested anywhere else in the codebase today.
        navigator.storage?.persist?.().catch(() => {});
      } else if (UseCache) {
        this.cache = true;
        this.setupPromise = this.setupOrphanedCache();
      } else if (UseIndexedDB) {
        this.indexedDBManager = new IndexedDBManager();
        this.setupPromise = this.indexedDBManager.setup();
      }
    } catch (e) {
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

  async setupOrphanedCache() {
    const cacheName = 'blob-cache-' + Date.now() + '-' + Math.random();
    const cache = await window.caches.open(cacheName);
    // Orphan it!
    await window.caches.delete(cacheName);
    // Store the cache reference for later use
    this.cache = cache;
  }

  async saveBlobInOPFSAsync(identifier, blob) {
    try {
      await this.setupPromise;
    } catch (e) {
      // OPFS setup itself failed (unsupported/quota denied) - disable it
      // for the rest of this session, same as the other backends.
      console.warn('OPFS is not supported, falling back to memory storage');
      this.opfsManager = null;
      this.setupPromise = false;
      this.blobStorePromises.clear();
      return false;
    }

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
      await this.setupPromise;
    } catch (e) {
      // IndexedDB is not supported
      console.warn('IndexedDB is not supported, falling back to memory storage');
      this.indexedDBManager = null;
      this.setupPromise = false;
      this.blobStorePromises.clear();
      return false;
    }
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
  }

  async saveBlobUsingCache(identifier, blob) {
    try {
      await this.setupPromise;
    } catch (e) {
      console.warn('Cache API is not supported, falling back to memory storage');
      this.cache = null;
      this.setupPromise = false;
      this.blobStorePromises.clear();
      return false;
    }

    const response = new Response(blob);
    const identifierURL = this.getIdentifierURL(identifier);

    await this.cache.put(identifierURL, response);

    const match = await this.cache.match(identifierURL);

    const blobResponse = await match?.blob();

    this.blobStore.set(identifier, blobResponse);
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
    let promise;
    if (this.opfsManager) {
      promise = this.saveBlobInOPFSAsync(identifier, blob);
    } else if (this.cache) {
      promise = this.saveBlobUsingCache(identifier, blob);
    } else if (this.indexedDBManager) {
      promise = this.saveBlobInIndexedDBAsync(identifier, blob);
    }
    this.blobStorePromises.set(identifier, promise);

    await promise;

    return identifier;
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
    if (this.opfsManager) {
      await this.opfsManager.deleteFile(identifier);
    } else if (this.cache) {
      const identifierURL = this.getIdentifierURL(identifier);
      await this.cache.delete(identifierURL);
    } else if (this.indexedDBManager) {
      await this.indexedDBManager.deleteFile(identifier);
    }

    return true;
  }

  getBlob(identifier) {
    return this.blobStore.get(identifier);
  }

  async clear() {
    this.blobStore.clear();
    this.blobStorePromises.clear();
    if (this.opfsManager) {
      await this.opfsManager.clearStorage();
    } else if (this.cache) {
      // Setup a new cache entirely
      this.cache = true;
      this.setupPromise = this.setupOrphanedCache();
      await this.setupPromise;
    } else if (this.indexedDBManager) {
      await this.indexedDBManager.clearStorage();
    }
  }

  close() {
    return this.opfsManager?.close() ?? this.indexedDBManager?.close();
  }
}
