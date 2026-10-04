import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// StreamSaver turns a save that is written as it is made (a direct download, the
// accelerated MP4 player's save, an archive) into a file download, through a blob store:
// OPFS where it works, otherwise blobs the store moves to the Cache API. Here the store is
// a stand-in that counts what was made and closed, and whose moves to disk finish when a
// test says so. These are the ways a save's store was left open, or let RAM fill up.

const stores = [];

vi.mock('../../chrome/player/modules/FSBlob.mjs', () => ({
  FSBlob: class {
    constructor() {
      stores.push(this);
      this.opfsManager = globalThis.fakeOpfs ?? null;
      this.blobStore = new Map();
      this.stored = new Map();
      this.index = 0;
      this.closed = false;
      this.cleared = false;
      // Resolvers of moves to disk that have not finished.
      this.moving = [];
    }
    async ready() {
      return !!this.opfsManager;
    }
    createBlob(data) {
      const identifier = `blob${this.index++}`;
      this.blobStore.set(identifier, new Blob([data]));
      this.stored.set(identifier, new Promise((resolve) => this.moving.push(resolve)));
      return identifier;
    }
    whenStored(identifier) {
      return this.stored.get(identifier);
    }
    getBlob(identifier) {
      return this.blobStore.get(identifier);
    }
    async clear() {
      this.cleared = true;
      this.blobStore.clear();
    }
    close() {
      this.closed = true;
    }
  },
}));

const {streamSaver} = await import('../../chrome/player/modules/StreamSaver.mjs');
const {Utils} = await import('../../chrome/player/utils/Utils.mjs');

/**
 * A stand-in OPFS manager whose calls can be made to fail.
 * @param {Object} [fail] {saveEnd: Error} and the like
 * @return {Object}
 */
function makeOpfs(fail = {}) {
  const call = (name) => vi.fn(async () => {
    if (fail[name]) throw fail[name];
    return name === 'getSavedFile' ? new Blob(['file']) : undefined;
  });
  return {
    saveBegin: call('saveBegin'),
    saveAppend: call('saveAppend'),
    saveEnd: call('saveEnd'),
    getSavedFile: call('getSavedFile'),
    saveAbort: call('saveAbort'),
  };
}

/** Lets pending promise callbacks run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  stores.length = 0;
  globalThis.fakeOpfs = null;
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(Utils, 'downloadURL').mockResolvedValue(7);
  vi.spyOn(Utils, 'revokeWhenDownloaded');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete globalThis.fakeOpfs;
});

describe('StreamSaver: the blob store of a save', () => {
  it('is not made for a save that never wrote anything', async () => {
    // A direct download whose server answered 404 fails before its first write. The store
    // was made with the stream, and with OPFS its worker ran until the tab closed.
    globalThis.fakeOpfs = makeOpfs();
    const stream = streamSaver.createWriteStream('video.mp4');
    await stream.abort(new Error('Bad status code: 404'));

    expect(stores).toHaveLength(0);
  });

  it('lets only a few chunks wait in memory to be moved to disk', async () => {
    // Without OPFS each chunk is a Blob in memory until the store has moved it to disk.
    // write() returned at once, so a producer as fast as the network had them all in RAM.
    const writer = streamSaver.createWriteStream('video.webm').getWriter();
    let written = 0;
    const writes = [];
    for (let i = 0; i < 40; i++) {
      writes.push(writer.write(new Uint8Array(1024)).then(() => written++));
    }
    await settle();
    const store = stores[0];
    expect(written).toBeLessThan(10);

    // As the store moves chunks to disk, the rest go in.
    while (written < 40) {
      store.moving.splice(0).forEach((resolve) => resolve());
      await settle();
    }
    await Promise.all(writes);
    await writer.close();
    expect(Utils.downloadURL).toHaveBeenCalledTimes(1);
  });

  it('is closed when a save is aborted (memory)', async () => {
    const writer = streamSaver.createWriteStream('video.webm').getWriter();
    await writer.write(new Uint8Array(4));
    await writer.abort(new Error('Cancelled'));

    expect(stores[0].cleared).toBe(true);
    expect(stores[0].closed).toBe(true);
  });

  it.each(['saveEnd', 'getSavedFile'])('is closed, its OPFS save ended, when %s fails', async (step) => {
    // A save whose file could not be finished: its session and worker stayed until the
    // tab closed.
    globalThis.fakeOpfs = makeOpfs({[step]: new Error(`${step} failed`)});
    const writer = streamSaver.createWriteStream('video.mp4').getWriter();
    await writer.write(new Uint8Array(4));
    await expect(writer.close()).rejects.toThrow(`${step} failed`);

    expect(globalThis.fakeOpfs.saveAbort).toHaveBeenCalledTimes(1);
    expect(stores[0].closed).toBe(true);
  });

  it('is closed, its OPFS save ended and its URL revoked, when the download cannot start', async () => {
    globalThis.fakeOpfs = makeOpfs();
    Utils.downloadURL.mockRejectedValue(new Error('downloads refused'));
    const writer = streamSaver.createWriteStream('video.mp4').getWriter();
    await writer.write(new Uint8Array(4));
    await expect(writer.close()).rejects.toThrow('downloads refused');

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(globalThis.fakeOpfs.saveAbort).toHaveBeenCalledTimes(1);
    expect(stores[0].closed).toBe(true);
  });

  it('is closed, cleared and its URL revoked, when the download cannot start (memory)', async () => {
    // The memory sink handed its URL on without a catch: a refused download kept the whole
    // video in memory and the store open until the tab closed.
    Utils.downloadURL.mockRejectedValue(new Error('downloads refused'));
    const writer = streamSaver.createWriteStream('video.webm').getWriter();
    await writer.write(new Uint8Array(4));
    stores[0].moving.splice(0).forEach((resolve) => resolve());
    await expect(writer.close()).rejects.toThrow('downloads refused');

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(stores[0].cleared).toBe(true);
    expect(stores[0].closed).toBe(true);
  });

  it('is kept, with its URL, for a finished memory save handed to the download', async () => {
    const writer = streamSaver.createWriteStream('video.webm').getWriter();
    await writer.write(new Uint8Array(4));
    await writer.close();

    expect(Utils.revokeWhenDownloaded).toHaveBeenCalledWith(expect.stringMatching(/^blob:/), 7);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(stores[0].cleared).toBe(false);
    expect(stores[0].closed).toBe(false);
  });

  it('is kept, with its URL, for a finished OPFS save handed to the download', async () => {
    globalThis.fakeOpfs = makeOpfs();
    const writer = streamSaver.createWriteStream('video.mp4').getWriter();
    await writer.write(new Uint8Array(4));
    await writer.close();

    expect(Utils.downloadURL).toHaveBeenCalledWith(expect.stringMatching(/^blob:/), 'video.mp4');
    expect(Utils.revokeWhenDownloaded).toHaveBeenCalledWith(expect.stringMatching(/^blob:/), 7);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(globalThis.fakeOpfs.saveAbort).not.toHaveBeenCalled();
    expect(stores[0].closed).toBe(false);
  });
});
