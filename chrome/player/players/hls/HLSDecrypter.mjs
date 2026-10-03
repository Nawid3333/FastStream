
export class HLSDecrypter {
  constructor() {
    this.lastId = 0;
  }
  async decryptAES(data, iv, key) {
    // No data is a failure, never a result: the download stored what it got as the
    // decrypted segment, complete, and nothing was ever there to play or save.
    if (this.destroyed) {
      throw new Error('Decrypter already destroyed');
    }
    if (!this.encryptionWorker) {
      this.setupEncryptionWorker();
    }
    const id = this.lastId++;
    return new Promise((resolve, reject) => {
      this.encryptionWorkerCallbacks.set(id, (decrypted, error) => {
        // decrypter-worker.js answers a failure (a wrong key, an IV that is not 16 bytes,
        // a download cut short) with 0 bytes and an error, and those 0 bytes were stored
        // as the segment, complete.
        if (decrypted?.byteLength > 0) {
          resolve(decrypted);
        } else {
          reject(new Error('Segment not decrypted: ' + (error || 'the decrypter was destroyed')));
        }
      });
      this.encryptionWorker.postMessage({
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
    // A terminated worker will never post back the results these are
    // waiting on - settle them now instead of leaving decryptAES() callers
    // hung forever on a fragment that will never finish.
    this.failPending(null);
    this.destroyed = true;
  }

  /**
   * Fails every decrypt still waiting for the worker.
   * @param {?string} error - Why, or null for a destroyed decrypter.
   */
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
      const callback = this.encryptionWorkerCallbacks.get(data.id);
      if (!callback) return;
      this.encryptionWorkerCallbacks.delete(data.id);
      callback(data.decrypted, data.error);
    });
    // A worker that failed to load, or threw, answers nothing, and an answer that could not
    // be read reaches no one: what was waiting waited forever (the segment stayed
    // "downloading", and a save holding it hung). It is failed, and the next decrypt starts
    // a new worker.
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
