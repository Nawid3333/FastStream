import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Where fragments go instead of RAM: OPFS through a worker, Cache API and IndexedDB behind it
// (FSBlob). The failure paths:
// - getFile gives the file on disk, not a copy in RAM.
// - unanswered or dead workers, concurrent prunes, clear() during an offload, '/' in names, long
// backlogs, partial writes.

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
    // The heartbeat is left out of diskRoom: it is written every 5 s, whenever.
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
    // Removed from its parent: a handle to it finds nothing any more, as Firefox's.
    this.gone = false;
  }
  check() {
    if (this.gone) throw new Error('NotFoundError: the directory is gone');
  }
  async getDirectoryHandle(name, {create = false} = {}) {
    this.check();
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
    this.check();
    checkName(name);
    if (!this.children.has(name)) {
      if (!create) throw new Error('NotFoundError: ' + name);
      this.children.set(name, new FakeFile('', name));
    }
    return this.children.get(name);
  }
  async removeEntry(name) {
    this.check();
    checkName(name);
    const child = this.children.get(name);
    if (!this.children.delete(name)) throw new Error('NotFoundError: ' + name);
    if (child instanceof FakeDir) child.gone = true;
  }
  async* keys() {
    this.check();
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

  it('keeps a working worker after a call that could not be sent', async () => {
    // A postMessage that throws is not counted as waiting for an answer.
    vi.useFakeTimers();
    const manager = new OPFSManager();
    const worker = {
      postMessage: () => {
        throw new DOMException('An ArrayBuffer is detached and could not be cloned.', 'DataCloneError');
      },
      terminate: vi.fn(),
    };
    manager.worker = worker;
    await expect(manager.call('set', {identifier: 'blob0'})).rejects.toThrow(/detached/);
    expect(manager.pending.size).toBe(0);
    await vi.advanceTimersByTimeAsync(OPFSManager.CallTimeoutMs * 2);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(manager.worker).toBe(worker);
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
    // A tab that crashed two minutes ago.
    session(`fsblob-${now - 180000}-2`, heartbeat(now - 120000));
    // One that crashed before its first heartbeat.
    session(`fsblob-${now - 180000}-3`);
    // A live one, busy writing its heartbeat right now (the file is locked).
    const locked = heartbeat(now - 1000);
    locked.unreadable = true;
    session(`fsblob-${now - 180000}-4`, locked);
    // A live one.
    session(`fsblob-${now - 180000}-5`, heartbeat(now - 2000));
    // A live one whose heartbeat is 20 s late: a page in the back-forward cache, or a browser
    // the computer's sleep stopped.
    session(`fsblob-${now - 180000}-8`, heartbeat(now - 20000));
    // One whose heartbeat a crash cut short (heartbeats are not flushed): it reads, but is
    // not JSON. Kept as "being written", its fragments stayed on the disk for good.
    session(`fsblob-${now - 180000}-6`, new FakeFile('{"updated_ti'));
    session(`fsblob-${now - 180000}-7`, new FakeFile(''));

    const manager = await startManager(root);
    try {
      const left = [...fsblob.children.keys()].sort();
      expect(left).toEqual([
        `fsblob-${now - 50}-1`,
        `fsblob-${now - 180000}-4`,
        `fsblob-${now - 180000}-5`,
        `fsblob-${now - 180000}-8`,
        manager.sessionName,
      ].sort());
    } finally {
      await manager.close();
    }
  });
});

describe('opfs-worker: a session whose directory another player deleted', () => {
  // A live session pruned while the computer slept writes to a new directory.
  it('makes its directory again for the next fragment, and for the next save', async () => {
    const root = new FakeDir();
    const manager = await startManager(root);
    try {
      await manager.setFile('blob0', new Blob([new Uint8Array([1, 2, 3])]));
      await root.children.get('fsblob').removeEntry(manager.sessionName);
      expect(root.children.get('fsblob').children.has(manager.sessionName)).toBe(false);

      await manager.setFile('blob1', new Blob([new Uint8Array([4, 5])]));
      // Only the new one: what was in the deleted directory is gone.
      expect(sessionOf(root, manager).children.size).toBe(1);
      expect([...(await manager.getFile('blob1')).disk.bytes]).toEqual([4, 5]);

      await root.children.get('fsblob').removeEntry(manager.sessionName);
      await manager.saveBegin('save-1');
      await manager.saveAppend('save-1', new Uint8Array([7]));
      await manager.saveEnd('save-1');
      expect([...(await manager.getSavedFile('save-1')).disk.bytes]).toEqual([7]);
    } finally {
      await manager.close();
    }
  });

  it('makes it again at its next heartbeat, so the players after it see a live session', async () => {
    vi.useFakeTimers();
    const root = new FakeDir();
    const manager = await startManager(root);
    try {
      await root.children.get('fsblob').removeEntry(manager.sessionName);
      await vi.advanceTimersByTimeAsync(5000);
      const meta = sessionOf(root, manager)?.children.get('_meta.json');
      expect(meta).toBeDefined();
      expect(JSON.parse(new TextDecoder().decode(meta.bytes)).updated_time).toBe(Date.now());
    } finally {
      vi.useRealTimers();
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

  it('forces nothing to the disk: no fragment, no heartbeat, no save', async () => {
    // No flushed writes: a forced sync per fragment doubled what Windows wrote; all is read back in
    // this session.
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
      expect([...save.disk.bytes]).toEqual([1, 2, 3]);
      expect({
        fragment: fragment.disk.flushes,
        heartbeat: sessionOf(root, manager).children.get('_meta.json').flushes,
        save: save.disk.flushes,
      }).toEqual({fragment: 0, heartbeat: 0, save: 0});
    } finally {
      await manager.close();
    }
  });

  it('reads a spilled fragment into RAM only in its turn, one at a time', async () => {
    // Blobs are posted unread: fragments spilled together are not all in RAM a second time.
    const root = new FakeDir();
    const manager = await startManager(root);
    const writtenAtEachRead = [];
    const fragments = [0, 1, 2].map((i) => {
      const blob = new Blob([new Uint8Array([i + 1, 2, 3])]);
      const read = blob.arrayBuffer.bind(blob);
      blob.arrayBuffer = () => {
        writtenAtEachRead.push([...sessionOf(root, manager).children.entries()]
            .filter(([name, file]) => name !== '_meta.json' && file.bytes.byteLength > 0).length);
        return read();
      };
      return blob;
    });
    try {
      await Promise.all(fragments.map((blob, i) => manager.setFile('blob' + i, blob)));
      expect(writtenAtEachRead).toEqual([0, 1, 2]);
      expect([...(await manager.getFile('blob2')).disk.bytes]).toEqual([3, 2, 3]);
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

  it('says when no disk backend is left, and a memory-only store does not', async () => {
    // OPFS, the Cache API and IndexedDB all failing left the store
    // in RAM with nobody told (its warning sat in a catch nothing reached).
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    const fsblob = new FSBlob();
    expect(await fsblob.ready()).toBe(false);
    expect(fsblob.diskGone).toBe(true);

    const memoryOnly = new FSBlob({memoryOnly: true});
    expect(await memoryOnly.ready()).toBe(false);
    expect(memoryOnly.diskGone).toBe(false);
  });

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
    // A private window's Response.blob() stays in memory: fragments are not read back at once.
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
    // fragments go to disk only past the RAM budget (FastStreamClient.enforceMemoryBudget)
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
    // an old write's late answer does not put old data back over a re-download
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
    // What the RAM budget asks before it chooses a fragment (FastStreamClient).
    expect(fsblob.isSpilling('f1')).toBe(true);
    const second = new Blob(['new data']);
    await fsblob.saveBlobAsync(second, 'f1', {deferred: true});
    release();
    expect(await spilling).toBe(false);
    expect(fsblob.isSpilling('f1')).toBe(false);
    expect(fsblob.getBlob('f1')).toBe(second);
    expect(fsblob.ramBytes()).toBe(second.size);
  });

  it('does not let a delete take away a fragment saved again while it waited', async () => {
    // DeleteBlob does not clear the identifier of the fragment downloaded anew under it
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const deleted = [];
    const {fsblob} = withOpfs({
      worker: {},
      setFile: () => gate,
      deleteFile: async (id) => deleted.push(id),
      close: vi.fn(),
    });
    const writing = fsblob.saveBlobAsync(new Blob(['old']), 'f1');
    const deleting = fsblob.deleteBlob('f1');
    const second = new Blob(['new data']);
    await fsblob.saveBlobAsync(second, 'f1', {deferred: true});
    release(true);
    await writing;
    expect(await deleting).toBe(true);
    expect(fsblob.getBlob('f1')).toBe(second);
    expect(fsblob.ramBytes()).toBe(second.size);
    expect(deleted).toEqual([]);
  });

  it('still deletes a fragment whose write it waited for, when nothing saved it again', async () => {
    // The control of the one above: a delete that never deletes
    // would pass that one.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const deleted = [];
    const {fsblob} = withOpfs({
      worker: {},
      setFile: () => gate,
      deleteFile: async (id) => deleted.push(id),
      close: vi.fn(),
    });
    const writing = fsblob.saveBlobAsync(new Blob(['old']), 'f1');
    const deleting = fsblob.deleteBlob('f1');
    release(true);
    await writing;
    expect(await deleting).toBe(true);
    expect(fsblob.blobStore.has('f1')).toBe(false);
    expect(fsblob.ramBytes()).toBe(0);
    expect(deleted).toEqual(['f1']);
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

  it('writes nothing more to disk once "Keep video on disk" is off, and reads what is there', async () => {
    // The option: off, what does not fit in the RAM budget is let go of
    // instead (FastStreamClient.keepWithinMemoryBudget, through canSpill).
    const root = new FakeDir();
    const manager = await startManager(root);
    const {fsblob} = withOpfs(manager);
    try {
      await fsblob.saveBlobAsync(new Blob([new Uint8Array([1, 2])]), 'before', {deferred: true});
      expect(await fsblob.spill('before')).toBe(true);

      fsblob.setMemoryOnly(true);
      const blob = new Blob([new Uint8Array([3, 4, 5])]);
      await fsblob.saveBlobAsync(blob, 'after', {deferred: true});
      expect(await fsblob.spill('after')).toBe(false);
      expect(fsblob.getBlob('after')).toBe(blob);
      expect(fsblob.ramBytes()).toBe(3);
      expect([...sessionOf(root, manager).children.keys()].filter((name) => name !== '_meta.json')).toHaveLength(1);
      // The one written before is still read from disk.
      expect(fsblob.getBlob('before').disk).toBeDefined();

      fsblob.setMemoryOnly(false);
      expect(await fsblob.spill('after')).toBe(true);
    } finally {
      await manager.close();
    }
  });

  it('starts its backends when a store made memory-only may write to disk after all', async () => {
    // "Keep video on disk" switched on in a player that opened with it off.
    const cached = new Map();
    const cache = {
      put: async (url, response) => cached.set(url, await response.blob()),
      match: async (url) => cached.has(url) ? new Response(cached.get(url)) : undefined,
      delete: async (url) => cached.delete(url),
    };
    vi.stubGlobal('window', {caches: {open: async () => cache, delete: async () => true}});
    vi.stubGlobal('navigator', {});
    const fsblob = new FSBlob({memoryOnly: true});
    expect(await fsblob.ready()).toBe(false);
    await fsblob.saveBlobAsync(new Blob(['fragment']), 'f1', {deferred: true});
    expect(await fsblob.spill('f1')).toBe(false);

    fsblob.setMemoryOnly(false);
    expect(await fsblob.ready()).toBe(true);
    expect(await fsblob.spill('f1')).toBe(true);
    expect(cached.size).toBe(1);
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

// a worker whose init fails is stopped when FSBlob moves on
describe('OPFSManager.setup', () => {
  it('ends the worker when its init fails', async () => {
    const workers = [];
    class FailingWorker {
      constructor() {
        this.listeners = {};
        this.terminate = vi.fn();
        workers.push(this);
      }
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      }
      postMessage(message) {
        queueMicrotask(() => this.listeners.message({data: {id: message.id, ok: false, error: 'SecurityError'}}));
      }
    }
    vi.stubGlobal('Worker', FailingWorker);
    try {
      const manager = new OPFSManager();
      await expect(manager.setup()).rejects.toThrow('SecurityError');
      expect(workers[0].terminate).toHaveBeenCalled();
      expect(OPFSManager.live.has(manager)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says why when its worker crashes before init answers', async () => {
    // The crash handler had let the worker go already, and the cleanup's terminate() on
    // null threw a TypeError in place of the reason.
    class CrashingWorker {
      constructor() {
        this.listeners = {};
        this.terminate = vi.fn();
      }
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      }
      postMessage() {
        queueMicrotask(() => this.listeners.error({message: 'SyntaxError: a broken import'}));
      }
    }
    vi.stubGlobal('Worker', CrashingWorker);
    try {
      const manager = new OPFSManager();
      await expect(manager.setup()).rejects.toThrow('SyntaxError: a broken import');
      expect(OPFSManager.live.has(manager)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// A save's store deletes its session directory as it closes, not at the next prune.
describe('OPFSManager.close, a save\'s session', () => {
  /**
   * A manager whose session holds a finished save's file.
   * @return {Promise<{root: FakeDir, manager: OPFSManager}>}
   */
  async function withSavedFile() {
    const root = new FakeDir();
    const manager = await startManager(root);
    await manager.saveBegin('save');
    await manager.saveAppend('save', new Uint8Array([1, 2, 3]));
    await manager.saveEnd('save');
    expect(sessionOf(root, manager).children.size).toBe(2);
    return {root, manager};
  }

  it('deletes the session directory, once its worker ended, when asked to', async () => {
    const {root, manager} = await withSavedFile();
    const worker = manager.worker;
    await manager.close(true);
    expect(worker.terminate).toHaveBeenCalled();
    expect(root.children.get('fsblob').children.has(manager.sessionName)).toBe(false);
  });

  it('keeps it on a plain close: a download may still read the file', async () => {
    const {root, manager} = await withSavedFile();
    await manager.close();
    expect(sessionOf(root, manager).children.size).toBe(2);
  });

  it('deletes it after a worker that is gone already, and minds no directory left to delete', async () => {
    const {root, manager} = await withSavedFile();
    manager.worker.terminate();
    manager.worker = null;
    await manager.close(true);
    expect(root.children.get('fsblob').children.has(manager.sessionName)).toBe(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(manager.close(true)).resolves.toBeUndefined();
  });

  it('is what FSBlob.close(true) does', async () => {
    const store = new FSBlob({memoryOnly: true});
    store.opfsManager = {close: vi.fn(async () => {})};
    await store.close(true);
    expect(store.opfsManager.close).toHaveBeenCalledWith(true);
    await store.close();
    expect(store.opfsManager.close).toHaveBeenLastCalledWith(false);
  });
});
