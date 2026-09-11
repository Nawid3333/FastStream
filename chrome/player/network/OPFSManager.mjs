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
    this.sessionName = null;
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
    const {sessionName} = await this.call('init');
    this.sessionName = sessionName;
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

  /**
   * Progressive whole-file saves (see opfs-worker.mjs). The main thread
   * writes chunks through the worker - FileSystemSyncAccessHandle only
   * exists in a dedicated worker - and finishes by opening the completed
   * file directly with getFileHandle/getFile, which DO exist here.
   * @return {Promise<void>}
   */
  async saveBegin(identifier) {
    await this.call('saveBegin', {identifier});
  }

  async saveAppend(identifier, chunk) {
    await this.call('saveAppend', {identifier, data: chunk}, [chunk.buffer]);
  }

  async saveEnd(identifier) {
    await this.call('saveEnd', {identifier});
  }

  async saveAbort(identifier) {
    await this.call('saveAbort', {identifier});
  }

  /**
   * Opens a file the worker wrote in this session, as a plain File. Used to
   * hand a finished save to the download pipeline without ever holding the
   * whole file in RAM.
   * @param {string} identifier the name passed to saveBegin
   * @return {Promise<File>} disk-backed file handle
   */
  async getSavedFile(identifier) {
    if (!this.sessionName) {
      throw new Error('OPFS session not initialized');
    }
    const root = await navigator.storage.getDirectory();
    const fsblobRoot = await root.getDirectoryHandle('fsblob');
    const sessionDir = await fsblobRoot.getDirectoryHandle(this.sessionName);
    const fileHandle = await sessionDir.getFileHandle(identifier);
    return fileHandle.getFile();
  }

  /**
   * Fails every still-pending call rather than leaving callers hanging if
   * the worker itself crashes, and terminates + drops the worker reference
   * so every *later* call fails fast too instead of posting into a worker
   * that fired 'error' but may still be technically alive (a crash doesn't
   * always mean the worker stopped running) and never replies.
   */
  handleWorkerCrash(event) {
    const error = new Error(event.message || 'OPFS worker crashed');
    for (const {reject} of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch (e) {
        // Already gone.
      }
    }
    this.worker = null;
  }

  call(op, payload, transfer) {
    if (!this.worker) {
      return Promise.reject(new Error('OPFS worker is not available'));
    }
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
      // Bounded: 'destroy' only clears in-memory state and closes a couple
      // of sync access handles, so it should be fast. A worker wedged on
      // something else (e.g. blocked file I/O) must not be able to stop
      // close() from ever reaching terminate() below.
      await Promise.race([
        this.call('destroy'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('OPFS destroy timed out')), 3000)),
      ]);
    } catch (e) {
      // Best-effort - the worker may already be unresponsive or too slow.
    }
    if (this.worker) {
      this.worker.terminate();
    }
    this.worker = null;
    for (const {reject} of this.pending.values()) {
      reject(new Error('OPFSManager closed'));
    }
    this.pending.clear();
  }
}
