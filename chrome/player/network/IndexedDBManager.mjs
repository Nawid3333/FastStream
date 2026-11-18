// @ts-check
/** @type {IndexedDBManager[]} */
const closeQueue = [];

/** @typedef {IDBDatabase|null|undefined} MaybeDatabase */

export class IndexedDBManager {
  /** @param {string} [persistentName] - None: a temporary one, deleted when it closes. */
  constructor(persistentName) {
    this.persistentName = persistentName || null;
  }

  static isSupported() {
    return window.indexedDB !== undefined;
  }

  isPersistent() {
    return this.persistentName !== null;
  }

  async setup() {
    await this.close();

    if (!this.isPersistent()) {
      this.prune();
      // As opfs-worker.mjs's heartbeat: prune's 60 s window needs no more.
      this.aliveInterval = setInterval(()=>{
        this.keepAlive();
      }, 5000);
      this.dbName = 'faststream-temp-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    } else {
      this.dbName = /** @type {string} */ (this.persistentName);
    }

    try {
      this.db = await IndexedDBManager.requestDB(this.dbName, true);
      closeQueue.push(this);

      return await IndexedDBManager.transact(this.db, 'metadata', 'readwrite', (transaction)=>{
        const metaDataStore = transaction.objectStore('metadata');
        metaDataStore.put(Date.now(), 'creation_time');
        if (!this.isPersistent()) {
          metaDataStore.put(Date.now(), 'updated_time');
        }
      });
    } catch (e) {
      await this.close();
      throw e;
    }
  }

  async close() {
    clearInterval(this.aliveInterval);
    if (this.db) {
      this.db.close();
      this.db = null;

      if (!this.isPersistent()) {
        await IndexedDBManager.deleteDB(/** @type {string} */ (this.dbName));
      }

      const index = closeQueue.indexOf(this);
      if (index !== -1) {
        closeQueue.splice(index, 1);
      }
    }
  }

  static async getDatabases() {
    return window.indexedDB.databases();
  }

  async prune() {
    const databases = await IndexedDBManager.getDatabases();

    return Promise.all(databases.map(async (database)=>{
      if (/** @type {string} */ (database.name).startsWith('faststream-temp-')) {
        try {
          const db = await IndexedDBManager.requestDB(/** @type {string} */ (database.name), false);
          let stale = false;
          try {
            const updatedTime = await IndexedDBManager.getValue(db, 'metadata', 'updated_time');
            // A hidden tab's timers run up to 15 s late, so 60 s, not less, tells a dead database.
            stale = !updatedTime || Date.now() - /** @type {number} */ (updatedTime) > 60000;
          } catch (e) {
            stale = true;
          } finally {
            // A live tab's too: kept open, it blocks that tab's deleteDatabase when it closes.
            db.close();
          }
          if (stale) {
            await IndexedDBManager.deleteDB(/** @type {string} */ (database.name));
            console.log('Pruned', database.name);
          }
        } catch (e) {
          console.error(e);
        }
      }
    }));
  }

  /**
   * @param {string} dbName
   * @param {boolean} [open]
   * @return {Promise<IDBDatabase>}
   */
  static async requestDB(dbName, open = false) {
    const request = window.indexedDB.open(dbName, 3);
    if (open) {
      request.onupgradeneeded = (event) => {
        const db = /** @type {IDBOpenDBRequest} */ (event.target).result;
        db.createObjectStore('metadata');
        db.createObjectStore('files');
      };
    }
    try {
      return await IndexedDBManager.wrapRequest(request, 5000);
    } catch (e) {
      // A connection after the timeout is closed: kept open, it blocks its tab's deleteDatabase.
      request.onsuccess = (event) => /** @type {IDBOpenDBRequest} */ (event.target).result.close();
      throw e;
    }
  }

  /** @param {string} dbName */
  static async deleteDB(dbName) {
    try {
      await IndexedDBManager.wrapRequest(window.indexedDB.deleteDatabase(dbName), 5000);
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * @param {MaybeDatabase} db
   * @param {string} storeName
   * @param {IDBValidKey} key
   * @return {Promise<unknown>}
   */
  static async getValue(db, storeName, key) {
    return IndexedDBManager.transact(db, storeName, 'readonly', (transaction)=>{
      const metaDataStore = transaction.objectStore(storeName);
      return IndexedDBManager.wrapRequest(metaDataStore.get(key));
    });
  }

  /**
   * @param {MaybeDatabase} db
   * @param {string} storeName
   * @param {IDBValidKey} key
   * @param {unknown} value
   */
  static async setValue(db, storeName, key, value) {
    return IndexedDBManager.transact(db, storeName, 'readwrite', (transaction)=>{
      const metaDataStore = transaction.objectStore(storeName);
      return IndexedDBManager.wrapRequest(metaDataStore.put(value, key));
    });
  }

  /**
   * Stores only when the key has none yet, in one transaction: of two racing tabs one wins.
   * @param {MaybeDatabase} db
   * @param {string} storeName
   * @param {IDBValidKey} key
   * @param {unknown} value
   * @return {Promise<boolean>} True when this call stored it.
   */
  static addValue(db, storeName, key, value) {
    return new Promise((resolve, reject)=>{
      let transaction;
      try {
        transaction = /** @type {IDBDatabase} */ (db).transaction(storeName, 'readwrite');
      } catch (e) {
        reject(e);
        return;
      }
      let added = false;
      const request = transaction.objectStore(storeName).add(value, key);
      request.onsuccess = () => {
        added = true;
      };
      request.onerror = (event) => {
        // The key exists: an answer, not a failure, so the transaction is not aborted.
        if (request.error?.name === 'ConstraintError') {
          event.preventDefault();
        }
      };
      transaction.oncomplete = () => resolve(added);
      transaction.onabort = () => reject(transaction.error || new Error('the transaction was aborted'));
    });
  }

  async clearStorage() {
    if (!this.db) return;
    return IndexedDBManager.transact(this.db, 'files', 'readwrite', (transaction)=>{
      const metaDataStore = transaction.objectStore('files');
      return IndexedDBManager.wrapRequest(metaDataStore.clear());
    });
  }

  /**
   * @param {IDBValidKey} identifier
   * @return {Promise<unknown>}
   */
  async getFile(identifier) {
    return IndexedDBManager.getValue(this.db, 'files', identifier);
  }

  /**
   * @param {IDBValidKey} identifier
   * @param {unknown} data
   */
  async setFile(identifier, data) {
    return IndexedDBManager.transact(this.db, 'files', 'readwrite', (transaction)=>{
      const fileStore = transaction.objectStore('files');
      return IndexedDBManager.wrapRequest(fileStore.put(data, identifier));
    });
  }

  /** @param {IDBValidKey} identifier */
  async deleteFile(identifier) {
    return IndexedDBManager.transact(this.db, 'files', 'readwrite', (transaction)=>{
      const fileStore = transaction.objectStore('files');
      return IndexedDBManager.wrapRequest(fileStore.delete(identifier));
    });
  }

  getDatabase() {
    return this.db;
  }

  keepAlive() {
    if (this.db && !this.isPersistent()) {
      IndexedDBManager.setValue(this.db, 'metadata', 'updated_time', Date.now()).catch(() => {});
    }
  }

  /**
   * @template T
   * @param {MaybeDatabase} db
   * @param {string} storeName
   * @param {IDBTransactionMode} mode
   * @param {(transaction: IDBTransaction) => T} callback
   * @return {Promise<Awaited<T>>}
   */
  static transact(db, storeName, mode, callback) {
    return new Promise((resolve, reject)=>{
      let transaction;
      try {
        transaction = /** @type {IDBDatabase} */ (db).transaction(storeName, mode);
      } catch (e) {
        reject(e);
        return;
      }

      /** @type {T|Promise<null>} */
      let result = Promise.resolve(null);
      transaction.onerror = (event) => {
        console.error(event);
        reject(event);
      };
      // A commit that fails (quota) aborts with no error event: the call never settled.
      transaction.onabort = () => {
        reject(transaction.error || new Error('the transaction was aborted'));
      };

      transaction.oncomplete = async (event) => {
        resolve(/** @type {Awaited<T>} */ (await result));
      };

      try {
        result = callback(transaction);
        // A failed request rejects the call (onerror); its own promise is awaited only on success.
        if (result instanceof Promise) result.catch(() => {});
        transaction.commit();
      } catch (e) {
        // A request the callback cannot make (an unstorable value) aborts the empty transaction.
        try {
          transaction.abort();
        } catch (abortError) {
          // Already finished.
        }
        reject(e);
      }
    });
  }

  /**
   * @template T
   * @param {IDBRequest<T>} request
   * @param {number} [timeout]
   * @return {Promise<T>}
   */
  static wrapRequest(request, timeout) {
    return new Promise((resolve, reject)=>{
      const timer = timeout ? setTimeout(()=>{
        reject(new Error('Timeout'));
      }, timeout) : undefined;
      request.onerror = (event) => {
        clearTimeout(timer);
        console.error(event);
        reject(event);
      };
      request.onsuccess = (event) => {
        clearTimeout(timer);
        resolve(/** @type {IDBRequest<T>} */ (event.target).result);
      };
    });
  }
}

window.addEventListener('beforeunload', async ()=>{
  // Over a copy: a persistent manager's close() takes it out of the list at once.
  await Promise.all([...closeQueue].map((manager)=>{
    return manager.close();
  }));
});
