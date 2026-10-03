import {IndexedDBManager} from '../network/IndexedDBManager.mjs';

export class SecureMemory {
  constructor(dbName) {
    this.indexedDbManager = new IndexedDBManager(dbName);
  }

  static isSupported() {
    if (!IndexedDBManager.isSupported()) {
      return false;
    }

    if (!window.crypto || !window.crypto.subtle) {
      return false;
    }

    return true;
  }

  static async hash(message, salt) {
    // use pbkdf2 to hash the message
    const encoder = new TextEncoder('utf-8');
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(message),
        {name: 'PBKDF2'},
        false,
        ['deriveBits', 'deriveKey'],
    );

    const params = {
      name: 'PBKDF2',
      hash: 'SHA-256',
      // The salt is the 128 random bytes getSalt() stores, and TextEncoder takes a string:
      // what PBKDF2 gets is the UTF-8 of their decimal list ("12,200,7,..."). Still the
      // stored random value, so the derivation is sound; but every saved position was
      // derived this way, and passing the bytes themselves would make every one of them
      // unreadable (unusableRecord), so changing it needs a new record format.
      // tests/unit/SecureMemory.test.mjs pins it.
      salt: encoder.encode(salt),
      iterations: 600000,
    };

    const derivedKey = await crypto.subtle.deriveKey(
        params,
        key,
        {name: 'AES-GCM', length: 256},
        true,
        ['encrypt'],
    );

    return await crypto.subtle.exportKey('raw', derivedKey);
  }

  static async encrypt(key, value) {
    const keyBuffer = await crypto.subtle.importKey(
        'raw',
        key,
        {name: 'AES-GCM'},
        false,
        ['encrypt'],
    );

    const iv = await SecureMemory.randomBuffer(12);
    const encoder = new TextEncoder('utf-8');
    const encrypted = await crypto.subtle.encrypt(
        {name: 'AES-GCM', iv},
        keyBuffer,
        encoder.encode(value),
    );

    const encryptedArray = new Uint8Array(encrypted);
    const ivArray = new Uint8Array(iv);
    const result = new Uint8Array(ivArray.length + encryptedArray.length);
    result.set(ivArray);
    result.set(encryptedArray, ivArray.length);
    return result;
  }

  static async decrypt(key, value) {
    const keyBuffer = await crypto.subtle.importKey(
        'raw',
        key,
        {name: 'AES-GCM'},
        false,
        ['decrypt'],
    );

    const decoder = new TextDecoder('utf-8');
    const iv = value.slice(0, 12);
    const encrypted = value.slice(12);
    const decrypted = await crypto.subtle.decrypt(
        {name: 'AES-GCM', iv},
        keyBuffer,
        encrypted,
    );
    return decoder.decode(decrypted);
  }

  static async randomBuffer(length) {
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    return randomValues;
  }

  async getSalt(name) {
    const db = this.indexedDbManager.getDatabase();
    const salt = await IndexedDBManager.getValue(db, 'metadata', name);
    if (salt) {
      return salt;
    }
    // Added, not put: on a fresh profile two players starting together both found no
    // salt, and the second overwrote the first, so the first tab's saved positions could
    // never be found again. add() stores only the first; the other reads that one back.
    const newSalt = await SecureMemory.randomBuffer(128);
    if (await IndexedDBManager.addValue(db, 'metadata', name, newSalt)) {
      return newSalt;
    }
    const stored = await IndexedDBManager.getValue(db, 'metadata', name);
    if (!stored) {
      throw new Error(`The ${name} was neither added nor found`);
    }
    return stored;
  }

  async setup() {
    await this.indexedDbManager.setup();
    this.identifierSalt = await this.getSalt('identifier_salt');
    this.keySalt = await this.getSalt('key_salt');
  }

  async getHashes(identifier) {
    // Side by side: each is 600,000 rounds of PBKDF2, and the video's start (autoplay, the
    // seek to the time in its URL) waits for both.
    const [identifierHash, keyHash] = await Promise.all([
      SecureMemory.hash(identifier, this.identifierSalt),
      SecureMemory.hash(identifier, this.keySalt),
    ]);
    return {identifierHash, keyHash};
  }

  async setFile(hashes, data) {
    const {identifierHash, keyHash} = hashes;
    const encryptedData = await SecureMemory.encrypt(keyHash, JSON.stringify(data));
    return this.indexedDbManager.setFile(identifierHash, {
      encryptedData,
      time: Date.now(),
    });
  }

  async getFile(hashes) {
    const {identifierHash, keyHash} = hashes;
    const data = await this.indexedDbManager.getFile(identifierHash);
    if (!data) {
      return null;
    }

    const {encryptedData} = data;
    if (encryptedData) {
      try {
        const data = await SecureMemory.decrypt(keyHash, encryptedData);
        return JSON.parse(data);
      } catch (e) {
        // A record that was read but is no use. The caller may save over it; after a
        // failed read it must not (see FastStreamClient.loadProgressData).
        const error = new Error('The saved record does not decrypt', {cause: e});
        error.unusableRecord = true;
        throw error;
      }
    }
  }

  /**
   * Deletes records not saved since the cutoff. Best effort, and it never fails or
   * hangs: the player's setup waits on it before the player shows. It rejected on a
   * cursor error, and an aborted transaction left it pending for good.
   * @param {number} cutoff - Records older than this (ms since the epoch) go.
   * @return {Promise<void>}
   */
  async pruneOld(cutoff) {
    try {
      const db = this.indexedDbManager.getDatabase();
      const transaction = db.transaction(['files'], 'readwrite');
      const store = transaction.objectStore('files');
      const request = store.openCursor();
      await new Promise((resolve, reject)=>{
        request.onsuccess = (event)=>{
          const cursor = event.target.result;
          if (cursor) {
            const {time} = cursor.value;
            if (time < cutoff) {
              cursor.delete();
            }
            cursor.continue();
          } else {
            transaction.commit();
          }
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error('the transaction was aborted'));
        request.onerror = () => {
          reject(request.error || new Error('the cursor failed'));
          try {
            transaction.abort();
          } catch (e) {
            // Already finished.
          }
        };
      });
    } catch (e) {
      console.warn('Could not delete old saved positions', e);
    }
  }

  destroy() {
    this.indexedDbManager.close();
    this.indexedDbManager = null;
  }
}
