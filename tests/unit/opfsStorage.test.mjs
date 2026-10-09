import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Where downloaded fragments go instead of RAM: OPFS through a dedicated worker
// (OPFSManager, opfs-worker.mjs), with the Cache API and IndexedDB behind it (FSBlob).
// tests/e2e/specs/storage.e2e.mjs covers the real Firefox OPFS; this covers the failure
// paths, on stand-ins:
// - getFile read each stored fragment back through the worker into an ArrayBuffer and
//   wrapped it in a Blob, so every "offloaded" fragment was in RAM too.
// - A worker call that never got an answer held up setup and every save for good.
// - A dead worker left OPFS "on" for the session, every later fragment kept in RAM.
// - Two players starting together: one's prune deleted the other's brand-new session
//   directory (made before its first heartbeat).
// - clear() while an offload ran: the blob came back after the clear, and stayed.
// - A fragment's identifier is its URL, and OPFS refuses a name with a '/': no fragment
//   was ever stored, every one stayed in RAM.
// - A backlog of writes longer than the call timeout counted as a crashed worker.
// - A write the disk took only part of was taken for a whole one.

vi.mock('../../chrome/player/network/IndexedDBManager.mjs', () => ({
  IndexedDBManager: class {
    static isSupported() {
      return false;
    }
  },
}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({AlertPolyfill: {alert: () => {}}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));

const {OPFSManager} = await import('../../chrome/player/network/OPFSManager.mjs');
const {FSBlob} = await import('../../chrome/player/modules/FSBlob.mjs');

/** How many more bytes the stand-in disk takes; a write past it is cut short. */
let diskRoom = Infinity;

/**
 * Firefox's rule for a file or directory name (IsValidName in
 * dom/fs/shared/FileSystemHelpers.cpp, as built for Windows): anything else is a TypeError.
 * @param {string} name
 */
function checkName(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' ||
      name.includes('/') || name.includes('\\')) {
    throw new TypeError('Invalid name: ' + name);
  }
}

/** A file in the stand-in OPFS. */
class FakeFile {
  constructor(text = '', name = '') {
    this.bytes = new TextEncoder().encode(text);
    this.unreadable = false;
    // The heartbeat is left out of diskRoom: it is written every second, whenever.
    this.isHeartbeat = name === '_meta.json';
    // Forced syncs to the disk (FileSystemSyncAccessHandle.flush).
    this.flushes = 0;
  }
  async createSyncAccessHandle() {
    return {
      // As Firefox's: what the disk did not take is left out of the count, not thrown.
      write: (data, {at = 0} = {}) => {
        const source = data instanceof ArrayBuffer ? new Uint8Array(data) :
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const count = this.isHeartbeat ? source.byteLength : Math.min(source.byteLength, diskRoom);
        if (!this.isHeartbeat) diskRoom -= count;
        if (at + count > this.bytes.byteLength) {
          const grown = new Uint8Array(at + count);
          grown.set(this.bytes);
          this.bytes = grown;
        }
        this.bytes.set(source.subarray(0, count), at);
        return count;
      },
      truncate: (n) => {
        const cut = new Uint8Array(n);
        cut.set(this.bytes.subarray(0, n));
        this.bytes = cut;
      },
      flush: () => {
        this.flushes++;
      },
      close: () => {},
    };
  }
  async getFile() {
    if (this.unreadable) throw new Error('NoModificationAllowedError: the file is locked');
    return {text: async () => new TextDecoder().decode(this.bytes), size: this.bytes.byteLength, disk: this};
  }
}

/** A directory in the stand-in OPFS. */
class FakeDir {
  constructor() {
    this.children = new Map();
  }
  async getDirectoryHandle(name, {create = false} = {}) {
    checkName(name);
    if (!this.children.has(name)) {
      if (!create) throw new Error('NotFoundError: ' + name);
      this.children.set(name, new FakeDir());
    }
    const child = this.children.get(name);
    if (!(child instanceof FakeDir)) throw new Error('TypeMismatchError: ' + name);
    return child;
  }
  async getFileHandle(name, {create = false} = {}) {
    checkName(name);
    if (!this.children.has(name)) {
      if (!create) throw new Error('NotFoundError: ' + name);
      this.children.set(name, new FakeFile('', name));
    }
    return this.children.get(name);
  }
  async removeEntry(name) {
    checkName(name);
    if (!this.children.delete(name)) throw new Error('NotFoundError: ' + name);
  }
  async* keys() {
    yield* [...this.children.keys()];
  }
}

/**
 * A fresh copy of the real opfs-worker.mjs on the stand-in OPFS, run in this thread: what
 * is posted to the returned worker reaches it, and its answers go to `answer`.
 * @param {FakeDir} root
 * @return {Promise<Object>} the worker, as OPFSManager uses one
 */
async function startWorker(root) {
  let onMessage;
  const worker = {
    answer: () => {},
    postMessage: (message) => queueMicrotask(() => onMessage({data: message})),
    terminate: vi.fn(),
  };
  vi.stubGlobal('self', {
    addEventListener: (type, listener) => {
      onMessage = listener;
    },
    postMessage: (message) => worker.answer(message),
  });
  vi.stubGlobal('navigator', {storage: {getDirectory: async () => root}});
  vi.resetModules();
  await import('../../chrome/player/network/opfs-worker.mjs');
  return worker;
}

/**
 * An OPFSManager whose worker is the real one on the stand-in OPFS, set up as setup() does.
 * @param {FakeDir} root
 * @return {Promise<OPFSManager>}
 */
async function startManager(root) {
  const worker = await startWorker(root);
  const manager = new OPFSManager();
  manager.worker = worker;
  worker.answer = (message) => manager.handleMessage(message);
  manager.sessionName = (await manager.call('init')).sessionName;
  return manager;
}

/**
 * The session directory a manager writes to.
 * @param {FakeDir} root
 * @param {OPFSManager} manager
 * @return {FakeDir}
 */
function sessionOf(root, manager) {
  return root.children.get('fsblob').children.get(manager.sessionName);
}

afterEach(() => {
  diskRoom = Infinity;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OPFSManager', () => {
  it('gives a stored fragment back as the file on disk, not a copy in RAM', async () => {
    const root = new FakeDir();
    const session = await (await root.getDirectoryHandle('fsblob', {create: true})).getDirectoryHandle('fsblob-1-1', {create: true});
    session.children.set('f0', new FakeFile('fragment bytes'));
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => root}});

    const manager = new OPFSManager();
    manager.sessionName = 'fsblob-1-1';
    manager.worker = {postMessage: vi.fn()};
    manager.fileNames.set('blob0', 'f0');

    const file = await manager.getFile('blob0');
    expect(file.disk).toBe(session.children.get('f0'));
    expect(manager.worker.postMessage).not.toHaveBeenCalled();
  });

  it('gives up on a worker that never answers, and counts it as crashed', async () => {
    vi.useFakeTimers();
    const manager = new OPFSManager();
    const worker = {postMessage: vi.fn(), terminate: vi.fn()};
    manager.worker = worker;

    const call = manager.call('set', {identifier: 'blob0'});
    const outcome = call.then(() => 'answered', (e) => e.message);
    await vi.advanceTimersByTimeAsync(OPFSManager.CallTimeoutMs);

    expect(await outcome).toMatch(/did not answer set/);
    expect(worker.terminate).toHaveBeenCalled();
    expect(manager.worker).toBeNull();
    expect(manager.pending.size).toBe(0);
  });

  it('keeps a worker that answered in time', async () => {
    vi.useFakeTimers();
    const manager = new OPFSManager();
    manager.worker = {
      postMessage: (message) => manager.handleMessage({id: message.id, ok: true, result: 'done'}),
      terminate: vi.fn(),
    };
    expect(await manager.call('set', {identifier: 'blob0'})).toBe('done');
    await vi.advanceTimersByTimeAsync(OPFSManager.CallTimeoutMs * 2);
    expect(manager.worker).not.toBeNull();
    // And no timer is left behind for it.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a worker that is working through a backlog longer than the timeout', async () => {
    // It answers one call at a time, in order, each well within the limit; the last one
    // waits three times the limit in all, behind the others.
    vi.useFakeTimers();
    const manager = new OPFSManager();
    const posted = [];
    manager.worker = {postMessage: (message) => posted.push(message), terminate: vi.fn()};
    const step = OPFSManager.CallTimeoutMs * 0.75;
    const calls = Array.from({length: 4}, (_, i) => manager.call('set', {identifier: 'f' + i}));

    for (const message of posted) {
      await vi.advanceTimersByTimeAsync(step);
      manager.handleMessage({id: message.id, ok: true});
    }

    await expect(Promise.all(calls)).resolves.toHaveLength(4);
    expect(manager.worker.terminate).not.toHaveBeenCalled();
    expect(manager.worker).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still gives up when the worker stops answering in the middle of a backlog', async () => {
    vi.useFakeTimers();
    const manager = new OPFSManager();
    const posted = [];
    const worker = {postMessage: (message) => posted.push(message), terminate: vi.fn()};
    manager.worker = worker;
    const calls = [0, 1, 2].map((i) => manager.call('set', {identifier: 'f' + i}).then(() => 'answered', (e) => e.message));

    await vi.advanceTimersByTimeAsync(1000);
    manager.handleMessage({id: posted[0].id, ok: true});
    await vi.advanceTimersByTimeAsync(OPFSManager.CallTimeoutMs);

    expect(await Promise.all(calls)).toEqual(['answered', expect.stringMatching(/did not answer set/), expect.stringMatching(/did not answer set/)]);
    expect(worker.terminate).toHaveBeenCalled();
  });
});

describe('opfs-worker: cleaning up other tabs\' sessions', () => {
  it('deletes only sessions that are gone, never a new or a busy one', async () => {
    const now = Date.now();
    const heartbeat = (time) => new FakeFile(JSON.stringify({updated_time: time}));
    const root = new FakeDir();
    const fsblob = await root.getDirectoryHandle('fsblob', {create: true});
    const session = (name, meta) => {
      const dir = new FakeDir();
      if (meta) dir.children.set('_meta.json', meta);
      fsblob.children.set(name, dir);
    };
    // Another player that started a moment ago: its directory is there, its first
    // heartbeat not yet.
    session(`fsblob-${now - 50}-1`);
    // A tab that crashed a minute ago.
    session(`fsblob-${now - 60000}-2`, heartbeat(now - 55000));
    // One that crashed before its first heartbeat.
    session(`fsblob-${now - 60000}-3`);
    // A live one, busy writing its heartbeat right now (the file is locked).
    const locked = heartbeat(now - 1000);
    locked.unreadable = true;
    session(`fsblob-${now - 60000}-4`, locked);
    // A live one.
    session(`fsblob-${now - 60000}-5`, heartbeat(now - 2000));

    const manager = await startManager(root);
    try {
      const left = [...fsblob.children.keys()].sort();
      expect(left).toEqual([
        `fsblob-${now - 50}-1`,
        `fsblob-${now - 60000}-4`,
        `fsblob-${now - 60000}-5`,
        manager.sessionName,
      ].sort());
    } finally {
      await manager.close();
    }
  });
});

describe('opfs-worker: writes', () => {
  it('fails a fragment the disk took only part of, and leaves nothing of it behind', async () => {
    const root = new FakeDir();
    const manager = await startManager(root);
    try {
      diskRoom = 3;
      const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);
      await expect(manager.setFile('blob0', blob)).rejects.toThrow(/wrote 3 of 5 bytes/);
      expect([...sessionOf(root, manager).children.keys()]).toEqual(['_meta.json']);
    } finally {
      diskRoom = Infinity;
      await manager.close();
    }
  });

  it('fails a save whose chunk the disk took only part of', async () => {
    const root = new FakeDir();
    const manager = await startManager(root);
    try {
      await manager.saveBegin('save-1');
      await manager.saveAppend('save-1', new Uint8Array([1, 2, 3]));
      diskRoom = 1;
      await expect(manager.saveAppend('save-1', new Uint8Array([4, 5, 6]))).rejects.toThrow(/wrote 1 of 3 bytes/);
    } finally {
      diskRoom = Infinity;
      await manager.close();
    }
  });

  it('forces no fragment and no heartbeat to the disk, and a save once, when it is complete', async () => {
    // A flushed write is a forced sync: 500 MB as 1.6 MB files, each flushed, made Windows
    // write 800 MB, lazily 423 MB (measured), and the heartbeat was flushed every second for
    // every open player. A fragment and the heartbeat are only read back in this session.
    const root = new FakeDir();
    const manager = await startManager(root);
    try {
      await manager.setFile('blob0', new Blob([new Uint8Array([1, 2, 3])]));
      await manager.saveBegin('save-1');
      await manager.saveAppend('save-1', new Uint8Array([1, 2]));
      await manager.saveAppend('save-1', new Uint8Array([3]));
      await manager.saveEnd('save-1');
      const fragment = await manager.getFile('blob0');
      const save = await manager.getSavedFile('save-1');
      expect({
        fragment: fragment.disk.flushes,
        heartbeat: sessionOf(root, manager).children.get('_meta.json').flushes,
        save: save.disk.flushes,
      }).toEqual({fragment: 0, heartbeat: 0, save: 1});
    } finally {
      await manager.close();
    }
  });

  it('writes a whole save, chunk after chunk, into one file', async () => {
    const root = new FakeDir();
    const manager = await startManager(root);
    try {
      await manager.saveBegin('save-1');
      await manager.saveAppend('save-1', new Uint8Array([1, 2, 3]));
      await manager.saveAppend('save-1', new Uint8Array([4, 5]));
      await manager.saveEnd('save-1');
      const file = await manager.getSavedFile('save-1');
      expect([...file.disk.bytes]).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await manager.close();
    }
  });
});

describe('FSBlob', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  /**
   * An FSBlob on the stand-in OPFS manager given, with the Cache API next in line.
   * @param {Object} opfsManager
   * @return {{fsblob: FSBlob, cached: Map}}
   */
  function withOpfs(opfsManager) {
    const cached = new Map();
    const cache = {
      put: async (url, response) => cached.set(url, await response.blob()),
      match: async (url) => cached.has(url) ? new Response(cached.get(url)) : undefined,
      delete: async (url) => cached.delete(url),
    };
    vi.stubGlobal('window', {caches: {open: async () => cache, delete: async () => true}});
    const storage = globalThis.navigator?.storage;
    vi.stubGlobal('navigator', {});
    const fsblob = new FSBlob();
    // The OPFS manager reads the directory from here.
    vi.stubGlobal('navigator', storage ? {storage} : {});
    fsblob.remainingBackends = ['cache'];
    fsblob.opfsManager = opfsManager;
    fsblob.cache = null;
    fsblob.setupPromise = Promise.resolve();
    return {fsblob, cached};
  }

  it('stores a downloaded fragment, named by its URL, on disk and deletes it again', async () => {
    const root = new FakeDir();
    const manager = await startManager(root);
    const {fsblob} = withOpfs(manager);
    try {
      const identifier = 'https://cdn.example/video/720p/seg-1.ts::0-1000000::arraybuffer';
      await fsblob.saveBlobAsync(new Blob([new Uint8Array([7, 8, 9])]), identifier);

      // The file on disk, not the Blob in RAM it was given.
      const stored = fsblob.getBlob(identifier);
      expect(stored.disk).toBeDefined();
      expect([...stored.disk.bytes]).toEqual([7, 8, 9]);
      expect(console.warn).not.toHaveBeenCalled();

      await fsblob.deleteBlob(identifier);
      expect([...sessionOf(root, manager).children.keys()]).toEqual(['_meta.json']);
    } finally {
      await manager.close();
    }
  });

  it('keeps a fragment in RAM that the disk took only part of', async () => {
    const root = new FakeDir();
    const manager = await startManager(root);
    const {fsblob} = withOpfs(manager);
    try {
      diskRoom = 2;
      const blob = new Blob([new Uint8Array([7, 8, 9])]);
      await fsblob.saveBlobAsync(blob, 'blob0');
      expect(fsblob.getBlob('blob0')).toBe(blob);
      expect(fsblob.opfsManager).toBe(manager);
    } finally {
      diskRoom = Infinity;
      await manager.close();
    }
  });

  it('moves on to the next backend once the OPFS worker is gone', async () => {
    const dead = {
      worker: null,
      setFile: async () => {
        throw new Error('OPFS worker is not available');
      },
      close: vi.fn(),
    };
    const {fsblob, cached} = withOpfs(dead);

    const identifier = await fsblob.saveBlobAsync(new Blob(['fragment']));

    expect(dead.close).toHaveBeenCalled();
    expect(fsblob.opfsManager).toBeNull();
    expect(cached.size).toBe(1);
    expect(await (await fsblob.getBlob(identifier)).text()).toBe('fragment');

    // And the next one goes there directly.
    await fsblob.saveBlobAsync(new Blob(['next']));
    expect(cached.size).toBe(2);
  });

  it('keeps nothing in RAM for a blob the Cache API holds, and reads it from there', async () => {
    // A private window's backend. Reading each fragment back at once (match().blob()) kept a
    // copy of every one in RAM: Firefox keeps a private window's Response.blob() in memory.
    const {fsblob, cached} = withOpfs(null);
    let reads = 0;
    const cache = await window.caches.open('x');
    const match = cache.match;
    cache.match = async (url) => {
      reads++;
      return match(url);
    };
    const identifier = await fsblob.saveBlobAsync(new Blob(['fragment']));

    expect(cached.size).toBe(1);
    expect(fsblob.blobStore.get(identifier)).not.toBeInstanceOf(Blob);
    const readsAfterSave = reads;
    expect(await (await fsblob.getBlob(identifier)).text()).toBe('fragment');
    expect(reads).toBe(readsAfterSave + 1);

    // Gone from the cache: nothing, which the download manager takes as data lost.
    cached.clear();
    expect(await fsblob.getBlob(identifier)).toBeUndefined();
  });

  it('keeps a downloaded fragment in RAM until it is spilled to disk', async () => {
    // Every fragment was written to OPFS at once (44 ms for 1.5 MB, measured); a video that
    // fits in the RAM budget never needs it (FastStreamClient.enforceMemoryBudget).
    const root = new FakeDir();
    const manager = await startManager(root);
    const {fsblob} = withOpfs(manager);
    try {
      const blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
      const identifier = await fsblob.saveBlobAsync(blob, 'blob0', {deferred: true});
      expect(fsblob.getBlob(identifier)).toBe(blob);
      expect(fsblob.ramBytes()).toBe(4);
      expect(fsblob.isInRam(identifier)).toBe(true);
      expect([...sessionOf(root, manager).children.keys()]).toEqual(['_meta.json']);

      expect(await fsblob.spill(identifier)).toBe(true);
      expect(fsblob.ramBytes()).toBe(0);
      expect(fsblob.isInRam(identifier)).toBe(false);
      expect(fsblob.getBlob(identifier).disk).toBeDefined();
      // Once on disk, nothing more to spill.
      expect(await fsblob.spill(identifier)).toBe(false);

      await fsblob.saveBlobAsync(new Blob([new Uint8Array([5])]), 'blob1', {deferred: true});
      await fsblob.deleteBlob('blob1');
      expect(fsblob.ramBytes()).toBe(0);
    } finally {
      await manager.close();
    }
  });

  it('does not let an old write replace a fragment saved again meanwhile', async () => {
    // A fragment let go of and downloaded again while its first copy was still being
    // written: the old write's answer put the old data back, and took the new one out of
    // the RAM count.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const {fsblob} = withOpfs({
      worker: {},
      setFile: () => gate,
      getFile: async () => new Blob(['old, from disk']),
      close: vi.fn(),
    });
    const first = new Blob(['old']);
    await fsblob.saveBlobAsync(first, 'f1', {deferred: true});
    const spilling = fsblob.spill('f1');
    const second = new Blob(['new data']);
    await fsblob.saveBlobAsync(second, 'f1', {deferred: true});
    release();
    expect(await spilling).toBe(false);
    expect(fsblob.getBlob('f1')).toBe(second);
    expect(fsblob.ramBytes()).toBe(second.size);
  });

  it('never writes a private window\'s blob to disk', async () => {
    // Firefox keeps a private window's media in RAM; so does FastStream (memoryOnly).
    const cached = new Map();
    vi.stubGlobal('window', {caches: {
      open: async () => ({put: async (url, response) => cached.set(url, response)}),
      delete: async () => true,
    }});
    const fsblob = new FSBlob({memoryOnly: true});
    expect(await fsblob.ready()).toBe(false);
    const blob = new Blob(['fragment']);
    const identifier = await fsblob.saveBlobAsync(blob);
    expect(fsblob.getBlob(identifier)).toBe(blob);
    expect(await fsblob.spill(identifier)).toBe(false);
    expect(fsblob.ramBytes()).toBe(blob.size);
    expect(cached.size).toBe(0);
    await fsblob.clear();
    expect(fsblob.ramBytes()).toBe(0);
  });

  it('keeps one blob in RAM when a single write fails but the worker lives', async () => {
    const alive = {
      worker: {},
      setFile: async () => {
        throw new Error('QuotaExceededError');
      },
      close: vi.fn(),
    };
    const {fsblob, cached} = withOpfs(alive);
    const blob = new Blob(['fragment']);
    const identifier = await fsblob.saveBlobAsync(blob);
    expect(fsblob.opfsManager).toBe(alive);
    expect(cached.size).toBe(0);
    expect(fsblob.getBlob(identifier)).toBe(blob);
  });

  it('does not let an offload that finishes after clear() put its blob back', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const {fsblob} = withOpfs({
      worker: {},
      setFile: () => gate,
      getFile: async () => new Blob(['from disk']),
      clearStorage: async () => {},
      close: vi.fn(),
    });

    const saving = fsblob.saveBlobAsync(new Blob(['fragment']), 'blob0');
    await fsblob.clear();
    release();
    await saving;

    expect(fsblob.getBlob('blob0')).toBeUndefined();
    expect(fsblob.blobStorePromises.has('blob0')).toBe(false);
  });
});
