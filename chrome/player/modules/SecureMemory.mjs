// @ts-check
import {IndexedDBManager} from '../network/IndexedDBManager.mjs';

/**
 * A record's two keys (getHashes): where it is stored, and what encrypts it.
 * @typedef {{identifierHash: ArrayBuffer, keyHash: ArrayBuffer}} Hashes
 */

/**
 * What setFile stores under a record's identifierHash: its encrypted JSON (the IV first, then
 * AES-GCM's output) and when it was written (pruneOld).
 * @typedef {{encryptedData: Uint8Array, time: number}} StoredRecord
 */

export class SecureMemory {
  /** @param {string} dbName - The IndexedDB database it keeps its records in. */
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

  /**
   * A key derived from the message and the salt (PBKDF2, 600,000 rounds of SHA-256).
   * @param {string} message
   * @param {Uint8Array} salt - One of getSalt's.
   * @return {Promise<ArrayBuffer>} The key's 32 bytes.
   */
  static async hash(message, salt) {
    // use pbkdf2 to hash the message
    // @ts-expect-error - TextEncoder takes no argument (it is always UTF-8): the browser ignores it.
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
      // @ts-expect-error - encode() takes a string: the bytes go in as that decimal list (above).
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

  /**
   * @param {ArrayBuffer} key - A record's keyHash.
   * @param {string} value
   * @return {Promise<Uint8Array>} A fresh 12-byte IV, then AES-GCM's output.
   */
  static async encrypt(key, value) {
    const keyBuffer = await crypto.subtle.importKey(
        'raw',
        key,
        {name: 'AES-GCM'},
        false,
        ['encrypt'],
    );

    const iv = await SecureMemory.randomBuffer(12);
    // @ts-expect-error - TextEncoder takes no argument (it is always UTF-8): the browser ignores it.
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

  /**
   * @param {ArrayBuffer} key - A record's keyHash.
   * @param {Uint8Array} value - What encrypt made.
   * @return {Promise<string>}
   */
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

  /**
   * @param {number} length - In bytes.
   * @return {Promise<Uint8Array<ArrayBuffer>>}
   */
  static async randomBuffer(length) {
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    return randomValues;
  }

  /**
   * The salt stored under the name, made (128 random bytes) if there is none yet.
   * @param {string} name - 'identifier_salt' or 'key_salt'.
   * @return {Promise<Uint8Array>}
   */
  async getSalt(name) {
    const db = this.indexedDbManager.getDatabase();
    const salt = await IndexedDBManager.getValue(db, 'metadata', name);
    if (salt) {
      // The bytes a getSalt stored (randomBuffer), as below.
      return /** @type {Uint8Array} */ (salt);
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
    return /** @type {Uint8Array} */ (stored);
  }

  async setup() {
    await this.indexedDbManager.setup();
    this.identifierSalt = await this.getSalt('identifier_salt');
    this.keySalt = await this.getSalt('key_salt');
  }

  /**
   * @param {string} identifier - What the record is for (a video source's identifier).
   * @return {Promise<Hashes>}
   */
  async getHashes(identifier) {
    // Side by side: each is 600,000 rounds of PBKDF2, and the video's start (autoplay, the
    // seek to the time in its URL) waits for both.
    // (The salts are there: the client asks only once setup() is done.)
    const [identifierHash, keyHash] = await Promise.all([
      SecureMemory.hash(identifier, /** @type {Uint8Array} */ (this.identifierSalt)),
      SecureMemory.hash(identifier, /** @type {Uint8Array} */ (this.keySalt)),
    ]);
    return {identifierHash, keyHash};
  }

  /**
   * Stores a record, encrypted.
   * @param {Hashes|null|undefined} hashes - The record's (getHashes). FastStreamClient keeps
   *   its as maybe none, though it saves only once a read gave it some; none rejects.
   * @param {unknown} data - Anything JSON.stringify takes.
   */
  async setFile(hashes, data) {
    // None throws here, and the call rejects (above).
    const {identifierHash, keyHash} = /** @type {Hashes} */ (hashes);
    const encryptedData = await SecureMemory.encrypt(keyHash, JSON.stringify(data));
    return this.indexedDbManager.setFile(identifierHash, {
      encryptedData,
      time: Date.now(),
    });
  }

  /**
   * A record, decrypted.
   * @param {Hashes} hashes - The record's (getHashes).
   * @return {Promise<*>} What setFile was given, as JSON.parse gives it back (any JSON value);
   *   null for no record.
   */
  async getFile(hashes) {
    const {identifierHash, keyHash} = hashes;
    const data = await this.indexedDbManager.getFile(identifierHash);
    if (!data) {
      return null;
    }

    // What setFile stored.
    const {encryptedData} = /** @type {StoredRecord} */ (data);
    if (encryptedData) {
      try {
        const data = await SecureMemory.decrypt(keyHash, encryptedData);
        return JSON.parse(data);
      } catch (e) {
        // A record that was read but is no use. The caller may save over it; after a
        // failed read it must not (see FastStreamClient.loadProgressData).
        /** @type {Error & {unusableRecord?: boolean}} */
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
      // None (closed) throws here as a closed one does, and is caught below.
      const transaction = /** @type {IDBDatabase} */ (db).transaction(['files'], 'readwrite');
      const store = transaction.objectStore('files');
      const request = store.openCursor();
      await /** @type {Promise<void>} */ (new Promise((resolve, reject)=>{
        request.onsuccess = (event)=>{
          // The event's target is the request.
          const cursor = /** @type {IDBRequest<IDBCursorWithValue|null>} */ (event.target).result;
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
      }));
    } catch (e) {
      console.warn('Could not delete old saved positions', e);
    }
  }

  destroy() {
    this.indexedDbManager.close();
    // Its last use: the client drops this object here, and its reads and writes catch a
    // call still in flight.
    this.indexedDbManager = /** @type {any} */ (null);
  }
}
