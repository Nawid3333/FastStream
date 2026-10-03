import {EnvUtils} from '../utils/EnvUtils.mjs';

// Main-thread counterpart to opfs-worker.mjs. Mirrors IndexedDBManager.mjs's
// method shape (setup/getFile/setFile/deleteFile/clearStorage/close) so
// FSBlob.mjs only needs one new branch, parallel to its existing
// UseIndexedDB one. All actual filesystem work happens in the worker -
// FileSystemSyncAccessHandle only exists inside a dedicated worker, not here.
export class OPFSManager {
  /**
   * Every manager whose worker is running, for diagnostics: pendingCalls() on each says
   * which worker calls have not answered and for how long.
   */
  static live = new Set();

  /** How long the worker may go without answering while calls wait, before it counts as crashed. */
  static CallTimeoutMs = 30000;

  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.nextId = 0;
    this.sessionName = null;
    // identifier -> its name in the session directory (fileName).
    this.fileNames = new Map();
    this.fileCount = 0;
    this.watchdog = null;
  }

  /**
   * The name a stored identifier has in the session directory; the worker only ever sees
   * these. A download's identifier is its URL with its range
   * ('https://host/seg.ts::0-100::arraybuffer'), and an OPFS name must not hold a '/' (or a
   * '\' on Windows): Firefox refused every such name with a TypeError, so no fragment was
   * ever stored here, and every one stayed in RAM.
   * @param {string} identifier
   * @param {boolean} [create] - name an identifier that has no name yet
   * @return {?string} null for an identifier with no name
   */
  fileName(identifier, create = false) {
    let name = this.fileNames.get(identifier);
    if (name === undefined && create) {
      name = 'f' + this.fileCount++;
      this.fileNames.set(identifier, name);
    }
    return name ?? null;
  }

  /** @return {Array<{id: number, op: string, ms: number}>} Calls still waiting on the worker. */
  pendingCalls() {
    const now = Date.now();
    return [...this.pending].map(([id, {op, started}]) => ({id, op, ms: now - started}));
  }

  static isSupported() {
    // Firefox supports navigator.storage.getDirectory() and
    // createSyncAccessHandle() but, unlike Chrome, does not expose
    // FileSystemFileHandle as a global constructor to duck-type against -
    // so this is deliberately just the primary gate. If a browser claims
    // getDirectory() but genuinely lacks sync access handles, that surfaces
    // as a rejected setup() the first time it's used, which FSBlob's backend
    // chain falls through from - the same way it already handles
    // IndexedDBManager.isSupported() being similarly optimistic.
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
      return false;
    }
    // Firefox private windows are the one case worth refusing up front
    // rather than discovering: getDirectory() is present and throws
    // SecurityError on every call, so claiming support here buys nothing but
    // a spawned worker and a SecurityError in the console each time a player
    // opens. The extension build is where inIncognitoContext is readable at
    // all, which is why the runtime fall-through in FSBlob stays the real
    // safety net (the web build in a private window still gets here, fails
    // setup, and moves on to the Cache API).
    if (EnvUtils.isIncognito()) {
      return false;
    }
    return true;
  }

  async setup() {
    const basePath = import.meta.url
        .replace(/#.*$/, '')
        .replace(/\?.*$/, '')
        .replace(/\/[^/]+$/, '/');
    this.worker = new Worker(basePath + 'opfs-worker.mjs', {type: 'module'});
    OPFSManager.live.add(this);
    this.worker.addEventListener('message', (event) => this.handleMessage(event.data));
    this.worker.addEventListener('error', (event) => this.handleWorkerCrash(event));
    const {sessionName} = await this.call('init');
    this.sessionName = sessionName;
  }

  handleMessage(msg) {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    // An answer is progress: the calls still waiting get the full time again.
    if (this.pending.size) {
      this.armWatchdog();
    } else {
      clearTimeout(this.watchdog);
    }
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
    await this.call('saveBegin', {identifier: this.fileName(identifier, true)});
  }

  async saveAppend(identifier, chunk) {
    await this.call('saveAppend', {identifier: this.fileName(identifier), data: chunk}, [chunk.buffer]);
  }

  async saveEnd(identifier) {
    await this.call('saveEnd', {identifier: this.fileName(identifier)});
  }

  async saveAbort(identifier) {
    const name = this.fileName(identifier);
    if (name === null) return;
    this.fileNames.delete(identifier);
    await this.call('saveAbort', {identifier: name});
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
    const name = this.fileName(identifier);
    if (name === null) {
      throw new Error('No OPFS file for ' + identifier);
    }
    const root = await navigator.storage.getDirectory();
    const fsblobRoot = await root.getDirectoryHandle('fsblob');
    const sessionDir = await fsblobRoot.getDirectoryHandle(this.sessionName);
    const fileHandle = await sessionDir.getFileHandle(name);
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
    clearTimeout(this.watchdog);
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
    OPFSManager.live.delete(this);
  }

  call(op, payload, transfer) {
    if (!this.worker) {
      return Promise.reject(new Error('OPFS worker is not available'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // The wait starts now only if the worker had nothing else to answer (armWatchdog).
      if (this.pending.size === 0) this.armWatchdog();
      this.pending.set(id, {resolve, reject, op, started: Date.now()});
      this.worker.postMessage({id, op, ...payload}, transfer || []);
    });
  }

  /**
   * A worker that never answers (wedged, or killed without an error event) held up setup
   * and every save for good. Past the limit it counts as crashed: every call fails, and
   * FSBlob moves on to its next backend. The worker answers its calls one at a time, in
   * order, so the limit is on how long it goes without answering any, not on how long one
   * call has waited: that is the queue ahead of it, and a 30 s backlog of writes (a whole
   * video downloading to a slow disk) counted as a crash, which dropped OPFS for the session.
   */
  armWatchdog() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      const [oldest] = this.pending.values();
      if (oldest) {
        this.handleWorkerCrash({message: `OPFS worker did not answer ${oldest.op} in ${OPFSManager.CallTimeoutMs / 1000} s`});
      }
    }, OPFSManager.CallTimeoutMs);
  }

  async setFile(identifier, blob) {
    const buffer = await blob.arrayBuffer();
    await this.call('set', {identifier: this.fileName(identifier, true), data: buffer}, [buffer]);
  }

  /**
   * The stored fragment as a disk-backed File. Reading it through the worker into an
   * ArrayBuffer and wrapping that in a Blob kept every "offloaded" fragment in RAM too.
   * @param {string} identifier
   * @return {Promise<File>}
   */
  async getFile(identifier) {
    return this.getSavedFile(identifier);
  }

  async deleteFile(identifier) {
    const name = this.fileName(identifier);
    if (name === null) return;
    this.fileNames.delete(identifier);
    await this.call('delete', {identifier: name});
  }

  async clearStorage() {
    // The worker deletes every file in the session. Names are not used again.
    this.fileNames.clear();
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
    clearTimeout(this.watchdog);
    OPFSManager.live.delete(this);
    for (const {reject} of this.pending.values()) {
      reject(new Error('OPFSManager closed'));
    }
    this.pending.clear();
  }
}
