
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
      this.encryptionWorkerCallbacks.set(id, (data, idn) => {
        if (data) {
          resolve(data);
        } else {
          reject(new Error('Segment not decrypted: the decrypter was destroyed'));
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
    if (this.encryptionWorkerCallbacks) {
      this.encryptionWorkerCallbacks.forEach((callback) => callback(null));
      this.encryptionWorkerCallbacks.clear();
    }
    this.destroyed = true;
  }

  setupEncryptionWorker() {
    this.encryptionWorker = new Worker('modules/decrypter-worker.js');
    this.encryptionWorker.addEventListener('message', (event) => {
      const data = event.data;
      this.encryptionWorkerCallbacks.get(data.id)(data.decrypted);
      this.encryptionWorkerCallbacks.delete(data.id);
    });

    this.encryptionWorkerCallbacks = new Map();
  }
}
