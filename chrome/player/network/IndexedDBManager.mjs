// @ts-check
// The open managers, closed when the page goes (beforeunload, below).
/** @type {IndexedDBManager[]} */
const closeQueue = [];

/**
 * A manager's database: none before setup() or after close(). A call given none rejects, as
 * for any database it cannot use: the transaction cannot be made (transact, addValue).
 * @typedef {IDBDatabase|null|undefined} MaybeDatabase
 */

export class IndexedDBManager {
  /**
   * @param {string} [persistentName] - The database to keep (SecureMemory's); none for a
   *   temporary one of this page's, deleted when it closes and pruned once it is stale.
   */
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
      this.aliveInterval = setInterval(()=>{
        this.keepAlive();
      }, 1000);
      this.dbName = 'faststream-temp-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    } else {
      // Persistent: it has a name.
      this.dbName = /** @type {string} */ (this.persistentName);
    }

    this.db = await IndexedDBManager.requestDB(this.dbName, true);
    closeQueue.push(this);

    return IndexedDBManager.transact(this.db, 'metadata', 'readwrite', (transaction)=>{
      const metaDataStore = transaction.objectStore('metadata');
      metaDataStore.put(Date.now(), 'creation_time');
      if (!this.isPersistent()) {
        metaDataStore.put(Date.now(), 'updated_time');
      }
    });
  }

  async close() {
    clearInterval(this.aliveInterval);
    if (this.db) {
      this.db.close();
      this.db = null;

      if (!this.isPersistent()) {
        // Named: setup() named it before it opened it.
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
      // (A string from here on: it starts with the prefix.)
      if (/** @type {string} */ (database.name).startsWith('faststream-temp-')) {
        try {
          const db = await IndexedDBManager.requestDB(/** @type {string} */ (database.name), false);
          // check if stale
          let stale = false;
          try {
            const updatedTime = await IndexedDBManager.getValue(db, 'metadata', 'updated_time');
            // A live tab writes it each second, but Firefox delays a hidden tab's timers by up
            // to 15 s (PlayerPeers): 10 s took live databases for dead ones (review, 2026-10-09).
            // (A Date.now(): setup and keepAlive write it.)
            stale = !updatedTime || Date.now() - /** @type {number} */ (updatedTime) > 60000;
          } catch (e) {
            stale = true;
          } finally {
            // A live tab's database too: kept open, it blocked that tab's own
            // deleteDatabase when it closed, until this tab closed as well.
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
   * Opens a database (version 3), giving a new one its two stores when `open` asks for that.
   * @param {string} dbName
   * @param {boolean} [open] - Create it with its stores if it is not there.
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
      // A connection that comes after the timeout is closed: kept open, it held the
      // database, and its tab's own deleteDatabase waited on it when that tab closed.
      request.onsuccess = (event) => /** @type {IDBOpenDBRequest} */ (event.target).result.close();
      throw e;
    }
  }

  /** @param {string} dbName - Deleted; a failure is logged, not thrown. */
  static async deleteDB(dbName) {
    try {
      await IndexedDBManager.wrapRequest(window.indexedDB.deleteDatabase(dbName), 5000);
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * @param {MaybeDatabase} db
   * @param {string} storeName - 'metadata' or 'files'.
   * @param {IDBValidKey} key
   * @return {Promise<unknown>} What is stored under the key (any value IndexedDB can hold),
   *   undefined for none.
   */
  static async getValue(db, storeName, key) {
    return IndexedDBManager.transact(db, storeName, 'readonly', (transaction)=>{
      const metaDataStore = transaction.objectStore(storeName);
      return IndexedDBManager.wrapRequest(metaDataStore.get(key));
    });
  }

  /**
   * @param {MaybeDatabase} db
   * @param {string} storeName - 'metadata' or 'files'.
   * @param {IDBValidKey} key
   * @param {unknown} value - Any value IndexedDB can hold (one it can clone).
   */
  static async setValue(db, storeName, key, value) {
    return IndexedDBManager.transact(db, storeName, 'readwrite', (transaction)=>{
      const metaDataStore = transaction.objectStore(storeName);
      return IndexedDBManager.wrapRequest(metaDataStore.put(value, key));
    });
  }

  /**
   * Stores a value only when the key has none yet, in one transaction, so of two tabs
   * racing to create the same value exactly one wins.
   * @param {MaybeDatabase} db
   * @param {string} storeName - 'metadata' or 'files'.
   * @param {IDBValidKey} key
   * @param {unknown} value - Any value IndexedDB can hold (one it can clone).
   * @return {Promise<boolean>} true when this call stored it, false when the key had a value
   */
  static addValue(db, storeName, key, value) {
    return new Promise((resolve, reject)=>{
      let transaction;
      try {
        // None throws here as a closed one does, and the call rejects (MaybeDatabase).
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
   * @param {IDBValidKey} identifier - FSBlob's (a string), SecureMemory's (an identifierHash,
   *   an ArrayBuffer).
   * @return {Promise<unknown>} What setFile stored under it, undefined for none.
   */
  async getFile(identifier) {
    return IndexedDBManager.getValue(this.db, 'files', identifier);
  }

  /**
   * @param {IDBValidKey} identifier - As getFile's.
   * @param {unknown} data - Any value IndexedDB can hold: FSBlob's Blobs, SecureMemory's
   *   encrypted records.
   */
  async setFile(identifier, data) {
    return IndexedDBManager.transact(this.db, 'files', 'readwrite', (transaction)=>{
      const fileStore = transaction.objectStore('files');
      return IndexedDBManager.wrapRequest(fileStore.put(data, identifier));
    });
  }

  /** @param {IDBValidKey} identifier - As getFile's. */
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
      // A beat that fails is tried again in a second.
      IndexedDBManager.setValue(this.db, 'metadata', 'updated_time', Date.now()).catch(() => {});
    }
  }

  /**
   * Runs the callback's requests in one transaction, and answers once it is committed.
   * @template T
   * @param {MaybeDatabase} db
   * @param {string} storeName - 'metadata' or 'files'.
   * @param {IDBTransactionMode} mode
   * @param {(transaction: IDBTransaction) => T} callback - Makes the requests; what it
   *   returns (a request's wrapRequest, or nothing) is the answer.
   * @return {Promise<Awaited<T>>}
   */
  static transact(db, storeName, mode, callback) {
    return new Promise((resolve, reject)=>{
      let transaction;
      try {
        // None throws here as a closed one does, and the call rejects (MaybeDatabase).
        transaction = /** @type {IDBDatabase} */ (db).transaction(storeName, mode);
      } catch (e) {
        reject(e);
        return;
      }

      // The callback's answer once it has run (below), before the transaction completes.
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
        // The callback's answer: it ran before the transaction could complete, and one that
        // threw rejected first (the null is never what the call answers).
        resolve(/** @type {Awaited<T>} */ (await result));
      };

      try {
        result = callback(transaction);
        transaction.commit();
      } catch (e) {
        // A request the callback could not make (put() of a value that cannot be stored):
        // the transaction, with nothing in it, completed and the call answered null, as if
        // it had worked.
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
   * The request's result, as a promise.
   * @template T
   * @param {IDBRequest<T>} request
   * @param {number} [timeout] - Reject after this many ms; none to wait for good.
   * @return {Promise<T>}
   */
  static wrapRequest(request, timeout) {
    return new Promise((resolve, reject)=>{
      request.onerror = (event) => {
        console.error(event);
        reject(event);
      };
      request.onsuccess = (event) => {
        // The event's target is the request.
        resolve(/** @type {IDBRequest<T>} */ (event.target).result);
      };
      if (timeout) {
        setTimeout(()=>{
          reject(new Error('Timeout'));
        }, timeout);
      }
    });
  }
}

window.addEventListener('beforeunload', async ()=>{
  await Promise.all(closeQueue.map((manager)=>{
    return manager.close();
  }));
});
