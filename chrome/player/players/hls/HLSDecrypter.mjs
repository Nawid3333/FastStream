
export class HLSDecrypter {
  constructor() {
    this.lastId = 0;
  }
  async decryptAES(data, iv, key) {
    if (this.destroyed) {
      console.error('Decrypter already destroyed');
      return;
    }
    if (!this.encryptionWorker) {
      this.setupEncryptionWorker();
    }
    const id = this.lastId++;
    return new Promise((resolve, reject) => {
      this.encryptionWorkerCallbacks.set(id, (data, idn) => {
        resolve(data);
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
