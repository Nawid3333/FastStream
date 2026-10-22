const closeQueue = [];

export class IndexedDBManager {
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
      this.dbName = this.persistentName;
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
        await IndexedDBManager.deleteDB(this.dbName);
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
      if (database.name.startsWith('faststream-temp-')) {
        try {
          const db = await IndexedDBManager.requestDB(database.name, false);
          // check if stale
          let stale = false;
          try {
            const updatedTime = await IndexedDBManager.getValue(db, 'metadata', 'updated_time');
            // A live tab writes it each second, but Firefox delays a hidden tab's timers by up
            // to 15 s (PlayerPeers): 10 s took live databases for dead ones (review, 2026-10-09).
            stale = !updatedTime || Date.now() - updatedTime > 60000;
          } catch (e) {
            stale = true;
          } finally {
            // A live tab's database too: kept open, it blocked that tab's own
            // deleteDatabase when it closed, until this tab closed as well.
            db.close();
          }
          if (stale) {
            await IndexedDBManager.deleteDB(database.name);
            console.log('Pruned', database.name);
          }
        } catch (e) {
          console.error(e);
        }
      }
    }));
  }

  static async requestDB(dbName, open = false) {
    const request = window.indexedDB.open(dbName, 3);
    if (open) {
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        db.createObjectStore('metadata');
        db.createObjectStore('files');
      };
    }
    try {
      return await IndexedDBManager.wrapRequest(request, 5000);
    } catch (e) {
      // A connection that comes after the timeout is closed: kept open, it held the
      // database, and its tab's own deleteDatabase waited on it when that tab closed.
      request.onsuccess = (event) => event.target.result.close();
      throw e;
    }
  }

  static async deleteDB(dbName) {
    try {
      await IndexedDBManager.wrapRequest(window.indexedDB.deleteDatabase(dbName), 5000);
    } catch (e) {
      console.error(e);
    }
  }

  static async getValue(db, storeName, key) {
    return IndexedDBManager.transact(db, storeName, 'readonly', (transaction)=>{
      const metaDataStore = transaction.objectStore(storeName);
      return IndexedDBManager.wrapRequest(metaDataStore.get(key));
    });
  }

  static async setValue(db, storeName, key, value) {
    return IndexedDBManager.transact(db, storeName, 'readwrite', (transaction)=>{
      const metaDataStore = transaction.objectStore(storeName);
      return IndexedDBManager.wrapRequest(metaDataStore.put(value, key));
    });
  }

  /**
   * Stores a value only when the key has none yet, in one transaction, so of two tabs
   * racing to create the same value exactly one wins.
   * @return {Promise<boolean>} true when this call stored it, false when the key had a value
   */
  static addValue(db, storeName, key, value) {
    return new Promise((resolve, reject)=>{
      let transaction;
      try {
        transaction = db.transaction(storeName, 'readwrite');
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

  async getFile(identifier) {
    return IndexedDBManager.getValue(this.db, 'files', identifier);
  }

  async setFile(identifier, data) {
    return IndexedDBManager.transact(this.db, 'files', 'readwrite', (transaction)=>{
      const fileStore = transaction.objectStore('files');
      return IndexedDBManager.wrapRequest(fileStore.put(data, identifier));
    });
  }

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

  static transact(db, storeName, mode, callback) {
    return new Promise((resolve, reject)=>{
      let transaction;
      try {
        transaction = db.transaction(storeName, mode);
      } catch (e) {
        reject(e);
        return;
      }

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
        resolve(await result);
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

  static wrapRequest(request, timeout) {
    return new Promise((resolve, reject)=>{
      request.onerror = (event) => {
        console.error(event);
        reject(event);
      };
      request.onsuccess = (event) => {
        resolve(event.target.result);
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
