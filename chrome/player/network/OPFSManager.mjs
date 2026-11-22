// @ts-check
import {EnvUtils} from '../utils/EnvUtils.mjs';

// Main-thread side of opfs-worker.mjs: FileSystemSyncAccessHandle exists only in a dedicated worker.
export class OPFSManager {
  static live = new Set();

  /** How long the worker may go without answering while calls wait, before it counts as crashed. */
  static CallTimeoutMs = 30000;

  constructor() {
    /** @type {Worker | null} */
    this.worker = null;
    this.pending = new Map();
    this.nextId = 0;
    this.sessionName = null;
    this.fileNames = new Map();
    this.fileCount = 0;
    /** @type {number | ReturnType<typeof setTimeout> | null} */
    this.watchdog = null;
  }

  /**
   * OPFS names cannot hold a slash, so an identifier (a URL) gets a name of its own.
   * @param {string | null} identifier
   * @param {boolean} [create]
   * @return {?string}
   */
  fileName(identifier, create = false) {
    let name = this.fileNames.get(identifier);
    if (name === undefined && create) {
      name = 'f' + this.fileCount++;
      this.fileNames.set(identifier, name);
    }
    return name ?? null;
  }

  /** @return {Array<{id: number, op: string, ms: number}>} */
  pendingCalls() {
    const now = Date.now();
    return [...this.pending].map(([id, {op, started}]) => ({id, op, ms: now - started}));
  }

  static isSupported() {
    // Optimistic: a browser without sync access handles fails setup(), and FSBlob moves on.
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
      return false;
    }
    // A private window's getDirectory() throws SecurityError on every call: refused up front.
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
    let started;
    try {
      started = await this.call('init');
    } catch (e) {
      // FSBlob drops this manager and moves on: its worker ends here.
      this.worker?.terminate();
      this.worker = null;
      OPFSManager.live.delete(this);
      throw e;
    }
    this.sessionName = started.sessionName;
  }

  /** @param {{id: number, ok: boolean, result: *, error: string}} msg */
  handleMessage(msg) {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    // An answer is progress: the calls still waiting get the full time again.
    if (this.pending.size) {
      this.armWatchdog();
    } else {
      clearTimeout(/** @type {number} */ (this.watchdog));
    }
    if (msg.ok) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.error));
    }
  }

  /**
   * Progressive whole-file saves: written through the worker, read back with getFile here.
   * @param {string | null} identifier
   * @return {Promise<void>}
   */
  async saveBegin(identifier) {
    await this.call('saveBegin', {identifier: this.fileName(identifier, true)});
  }

  /**
   * @param {string | null} identifier
   * @param {Uint8Array} chunk
   * @return {Promise<void>}
   */
  async saveAppend(identifier, chunk) {
    await this.call('saveAppend', {identifier: this.fileName(identifier), data: chunk}, [(chunk.buffer)]);
  }

  /**
   * @param {string | null} identifier
   * @return {Promise<void>}
   */
  async saveEnd(identifier) {
    await this.call('saveEnd', {identifier: this.fileName(identifier)});
  }

  /**
   * @param {string | null} identifier
   * @return {Promise<void>}
   */
  async saveAbort(identifier) {
    const name = this.fileName(identifier);
    if (name === null) return;
    this.fileNames.delete(identifier);
    await this.call('saveAbort', {identifier: name});
  }

  /**
   * Takes over a file another player stored (its hand-off), moved into this session's directory.
   * @param {string} identifier
   * @param {string} fromSession
   * @param {string} fromName
   * @return {Promise<File>}
   */
  async adoptFile(identifier, fromSession, fromName) {
    if (!this.sessionName) {
      throw new Error('OPFS session not initialized');
    }
    const root = await navigator.storage.getDirectory();
    const fsblobRoot = await root.getDirectoryHandle('fsblob');
    const from = await fsblobRoot.getDirectoryHandle(fromSession);
    const to = await fsblobRoot.getDirectoryHandle(this.sessionName);
    const handle = await from.getFileHandle(fromName);
    const name = /** @type {string} */ (this.fileName(identifier, true));
    try {
      // FileSystemHandle.move: Firefox has it for OPFS, lib.dom does not declare it yet.
      await /** @type {FileSystemFileHandle & {move: (dir: FileSystemDirectoryHandle, name: string) => Promise<void>}} */ (handle).move(to, name);
    } catch (e) {
      this.fileNames.delete(identifier);
      throw e;
    }
    return (await to.getFileHandle(name)).getFile();
  }

  /**
   * @param {string} session
   * @return {Promise<void>}
   */
  async dropSession(session) {
    if (session === this.sessionName) return;
    const root = await navigator.storage.getDirectory();
    const fsblobRoot = await root.getDirectoryHandle('fsblob');
    await fsblobRoot.removeEntry(session, {recursive: true});
  }

  /**
   * @param {string} identifier
   * @return {Promise<File>}
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
   * Fails every pending call and drops the worker: a crashed worker may live on and never answer.
   * @param {ErrorEvent | {message: string}} event
   */
  handleWorkerCrash(event) {
    clearTimeout(/** @type {number} */ (this.watchdog));
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

  /**
   * @param {string} op
   * @param {{identifier: string | null, data?: Uint8Array | ArrayBuffer | Blob}} [payload]
   * @param {Transferable[]} [transfer]
   * @return {Promise<*>}
   */
  call(op, payload, transfer) {
    if (!this.worker) {
      return Promise.reject(new Error('OPFS worker is not available'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // The wait starts now only if the worker had nothing else to answer (armWatchdog).
      if (this.pending.size === 0) this.armWatchdog();
      this.pending.set(id, {resolve, reject, op, started: Date.now()});
      try {
        /** @type {Worker} */ (this.worker).postMessage({id, op, ...payload}, transfer || []);
      } catch (e) {
        // Never sent: left waiting, it would keep the watchdog going.
        this.pending.delete(id);
        if (this.pending.size === 0) clearTimeout(/** @type {number} */ (this.watchdog));
        reject(e);
      }
    });
  }

  /** The limit is on time without any answer, not on one call's wait: calls queue in order. */
  armWatchdog() {
    clearTimeout(/** @type {number} */ (this.watchdog));
    this.watchdog = setTimeout(() => {
      const [oldest] = this.pending.values();
      if (oldest) {
        this.handleWorkerCrash({message: `OPFS worker did not answer ${oldest.op} in ${OPFSManager.CallTimeoutMs / 1000} s`});
      }
    }, OPFSManager.CallTimeoutMs);
  }

  /**
   * @param {string | null} identifier
   * @param {Blob} blob
   * @return {Promise<void>}
   */
  async setFile(identifier, blob) {
    // The Blob itself goes to the worker, without a copy: read here, a spill sat in RAM twice.
    await this.call('set', {identifier: this.fileName(identifier, true), data: blob});
  }

  /**
   * A disk-backed File: read through the worker, it would sit in RAM too.
   * @param {string} identifier
   * @return {Promise<File>}
   */
  async getFile(identifier) {
    return this.getSavedFile(identifier);
  }

  /**
   * @param {string | null} identifier
   * @return {Promise<void>}
   */
  async deleteFile(identifier) {
    const name = this.fileName(identifier);
    if (name === null) return;
    this.fileNames.delete(identifier);
    await this.call('delete', {identifier: name});
  }

  async clearStorage() {
    this.fileNames.clear();
    // The worker goes on in a new session directory (opfs-worker.mjs clearStorage).
    const cleared = await this.call('clear');
    if (typeof cleared?.sessionName === 'string') this.sessionName = cleared.sessionName;
  }

  /**
   * Ends the worker; its session directory stays until the next prune unless removeSession.
   * @param {boolean} [removeSession]
   * @return {Promise<void>}
   */
  async close(removeSession = false) {
    if (this.worker) {
      try {
        // Bounded: a wedged worker must not keep close() from reaching terminate().
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
      clearTimeout(/** @type {number} */ (this.watchdog));
      OPFSManager.live.delete(this);
      for (const {reject} of this.pending.values()) {
        reject(new Error('OPFSManager closed'));
      }
      this.pending.clear();
    }
    if (removeSession && this.sessionName) {
      try {
        const root = await navigator.storage.getDirectory();
        const fsblobRoot = await root.getDirectoryHandle('fsblob');
        await fsblobRoot.removeEntry(this.sessionName, {recursive: true});
      } catch (e) {
        // Gone already, or a file still held: the next prune takes it.
        console.warn('Could not delete the files of a closed save; the next player start will', e);
      }
    }
  }
}
