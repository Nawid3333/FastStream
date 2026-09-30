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

/** A file in the stand-in OPFS. */
class FakeFile {
  constructor(text = '') {
    this.bytes = new TextEncoder().encode(text);
    this.unreadable = false;
  }
  async createSyncAccessHandle() {
    return {
      write: (data) => {
        this.bytes = new Uint8Array(data.buffer ? data.buffer.slice(0) : data);
        return this.bytes.byteLength;
      },
      truncate: (n) => {
        this.bytes = this.bytes.subarray(0, n);
      },
      flush: () => {},
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
    if (!this.children.has(name)) {
      if (!create) throw new Error('NotFoundError: ' + name);
      this.children.set(name, new FakeDir());
    }
    const child = this.children.get(name);
    if (!(child instanceof FakeDir)) throw new Error('TypeMismatchError: ' + name);
    return child;
  }
  async getFileHandle(name, {create = false} = {}) {
    if (!this.children.has(name)) {
      if (!create) throw new Error('NotFoundError: ' + name);
      this.children.set(name, new FakeFile());
    }
    return this.children.get(name);
  }
  async removeEntry(name) {
    if (!this.children.delete(name)) throw new Error('NotFoundError: ' + name);
  }
  async* keys() {
    yield* [...this.children.keys()];
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OPFSManager', () => {
  it('gives a stored fragment back as the file on disk, not a copy in RAM', async () => {
    const root = new FakeDir();
    const session = await (await root.getDirectoryHandle('fsblob', {create: true})).getDirectoryHandle('fsblob-1-1', {create: true});
    session.children.set('blob0', new FakeFile('fragment bytes'));
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => root}});

    const manager = new OPFSManager();
    manager.sessionName = 'fsblob-1-1';
    manager.worker = {postMessage: vi.fn()};

    const file = await manager.getFile('blob0');
    expect(file.disk).toBe(session.children.get('blob0'));
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

    let onMessage;
    const replies = [];
    vi.stubGlobal('self', {
      addEventListener: (type, listener) => {
        onMessage = listener;
      },
      postMessage: (message) => replies.push(message),
    });
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => root}});
    await import('../../chrome/player/network/opfs-worker.mjs');

    await onMessage({data: {id: 1, op: 'init'}});
    try {
      expect(replies[0]).toMatchObject({id: 1, ok: true});
      const left = [...fsblob.children.keys()].sort();
      expect(left).toEqual([
        `fsblob-${now - 50}-1`,
        `fsblob-${now - 60000}-4`,
        `fsblob-${now - 60000}-5`,
        replies[0].result.sessionName,
      ].sort());
    } finally {
      await onMessage({data: {id: 2, op: 'destroy'}});
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
    vi.stubGlobal('navigator', {});
    const fsblob = new FSBlob();
    fsblob.remainingBackends = ['cache'];
    fsblob.opfsManager = opfsManager;
    fsblob.cache = null;
    fsblob.setupPromise = Promise.resolve();
    return {fsblob, cached};
  }

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
    expect(await fsblob.getBlob(identifier).text()).toBe('fragment');

    // And the next one goes there directly.
    await fsblob.saveBlobAsync(new Blob(['next']));
    expect(cached.size).toBe(2);
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
