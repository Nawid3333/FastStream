// @ts-check

export class HLSDecrypter {
  constructor() {
    this.lastId = 0;
  }
  /**
   * @param {ArrayBuffer} data
   * @param {ArrayBuffer} iv
   * @param {ArrayBuffer} key
   */
  async decryptAES(data, iv, key) {
    // No data is a failure, never a result: it would be stored as the segment, complete.
    if (this.destroyed) {
      throw new Error('Decrypter already destroyed');
    }
    if (!this.encryptionWorker) {
      this.setupEncryptionWorker();
    }
    const id = this.lastId++;
    return new Promise((resolve, reject) => {
      /** @type {Map<number, (decrypted: any, error: any) => void>} */ (this.encryptionWorkerCallbacks).set(id, (decrypted, error) => {
        // decrypter-worker.js answers a failure with 0 bytes and an error.
        if (decrypted?.byteLength > 0) {
          resolve(decrypted);
        } else {
          reject(new Error('Segment not decrypted: ' + (error || 'the decrypter was destroyed')));
        }
      });
      /** @type {Worker} */ (this.encryptionWorker).postMessage({
        encrypted: data,
        iv: iv,
        key: key,
        id: id,
      }, [data]);
    });
  }

  destroy() {
    if (this.encryptionWorker) {
      this.encryptionWorker.terminate();
      this.encryptionWorker = null;
    }
    // A terminated worker never answers: settle what waits now.
    this.failPending(null);
    this.destroyed = true;
  }

  /** @param {?string} error - Null for a destroyed decrypter. */
  failPending(error) {
    if (this.encryptionWorkerCallbacks) {
      this.encryptionWorkerCallbacks.forEach((callback) => callback(null, error));
      this.encryptionWorkerCallbacks.clear();
    }
  }

  setupEncryptionWorker() {
    const worker = this.encryptionWorker = new Worker('modules/decrypter-worker.js');
    worker.addEventListener('message', (event) => {
      const data = event.data;
      const callback = /** @type {Map<number, (decrypted: any, error: any) => void>} */ (this.encryptionWorkerCallbacks).get(data.id);
      if (!callback) return;
      /** @type {Map<number, (decrypted: any, error: any) => void>} */ (this.encryptionWorkerCallbacks).delete(data.id);
      callback(data.decrypted, data.error);
    });
    // A worker that failed to load or threw answers nothing: what waits fails, the next decrypt starts a new one.
    /** @param {Event & {message?: string}} event */
    const crashed = (event) => {
      console.error('The decrypter worker failed', event);
      if (this.encryptionWorker === worker) {
        worker.terminate();
        this.encryptionWorker = null;
      }
      this.failPending(event?.message || 'the decrypter worker failed');
    };
    worker.addEventListener('error', crashed);
    worker.addEventListener('messageerror', crashed);

    this.encryptionWorkerCallbacks = new Map();
  }
}
