// Main-thread counterpart to opfs-worker.mjs. Mirrors IndexedDBManager.mjs's
// method shape (setup/getFile/setFile/deleteFile/clearStorage/close) so
// FSBlob.mjs only needs one new branch, parallel to its existing
// UseIndexedDB one. All actual filesystem work happens in the worker -
// FileSystemSyncAccessHandle only exists inside a dedicated worker, not here.
export class OPFSManager {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.nextId = 0;
  }

  static isSupported() {
    // Firefox supports navigator.storage.getDirectory() and
    // createSyncAccessHandle() but, unlike Chrome, does not expose
    // FileSystemFileHandle as a global constructor to duck-type against -
    // so this is deliberately just the primary gate. If a browser claims
    // getDirectory() but genuinely lacks sync access handles, that surfaces
    // as a rejected setup() the first time it's used, which FSBlob already
    // catches and falls back from - the same way it already handles
    // IndexedDBManager.isSupported() being similarly optimistic.
    return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
  }

  async setup() {
    const basePath = import.meta.url
        .replace(/#.*$/, '')
        .replace(/\?.*$/, '')
        .replace(/\/[^/]+$/, '/');
    this.worker = new Worker(basePath + 'opfs-worker.mjs', {type: 'module'});
    this.worker.addEventListener('message', (event) => this.handleMessage(event.data));
    this.worker.addEventListener('error', (event) => this.handleWorkerCrash(event));
    await this.call('init');
  }

  handleMessage(msg) {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.ok) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.error));
    }
  }

  /** Fails every still-pending call rather than leaving callers hanging if the worker itself crashes. */
  handleWorkerCrash(event) {
    const error = new Error(event.message || 'OPFS worker crashed');
    for (const {reject} of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }

  call(op, payload, transfer) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.worker.postMessage({id, op, ...payload}, transfer || []);
    });
  }

  async setFile(identifier, blob) {
    const buffer = await blob.arrayBuffer();
    await this.call('set', {identifier, data: buffer}, [buffer]);
  }

  async getFile(identifier) {
    const buffer = await this.call('get', {identifier});
    return new Blob([buffer]);
  }

  async deleteFile(identifier) {
    await this.call('delete', {identifier});
  }

  async clearStorage() {
    await this.call('clear');
  }

  async close() {
    if (!this.worker) return;
    try {
      await this.call('destroy');
    } catch (e) {
      // Best-effort - the worker may already be unresponsive.
    }
    this.worker.terminate();
    this.worker = null;
    for (const {reject} of this.pending.values()) {
      reject(new Error('OPFSManager closed'));
    }
    this.pending.clear();
  }
}
