import {beforeEach, describe, expect, it, vi} from 'vitest';
import {DownloadStatus} from '../../chrome/player/enums/DownloadStatus.mjs';

// A player hands its finished downloads over as its page goes (handOff), and the next player of
// the video takes them back (adopt), also under a new link whose signature changed (vidmoly's
// ?t=&s= at every load of its page). FreshLink keeps them under its new link the same way
// (relink). The store is a stand-in: what is in RAM, what is on the disk, under which names.

vi.mock('../../chrome/player/modules/FSBlob.mjs', () => ({
  FSBlob: class {
    // Each store its own session directory, as each player's worker makes one.
    static sessions = 0;
    constructor({memoryOnly = false} = {}) {
      this.memoryOnly = memoryOnly;
      this.blobStore = new Map();
      this.inRam = new Map();
      this.names = new Map();
      this.opfsManager = {sessionName: `fsblob-${++this.constructor.sessions}-me`, fileName: (id) => this.names.get(id) ?? null};
      this.adoptStoredFile = vi.fn(async (id, session, name) => {
        if (name === 'broken') return false;
        this.blobStore.set(id, new Blob([`from ${session}/${name}`]));
        this.names.set(id, 'f' + this.names.size);
        return true;
      });
      this.dropSession = vi.fn();
      this.deleteBlob = vi.fn(async (id) => {
        this.blobStore.delete(id);
        this.inRam.delete(id);
      });
    }
    setMemoryOnly(memoryOnly) {
      this.memoryOnly = memoryOnly;
    }
    isInRam(id) {
      return this.inRam.has(id);
    }
    async saveBlobAsync(blob, id) {
      this.blobStore.set(id, blob);
      this.inRam.set(id, blob.size);
      return id;
    }
    getBlob(id) {
      return this.blobStore.get(id);
    }
    close() {}
    async clear() {
      this.blobStore.clear();
      this.inRam.clear();
    }
  },
}));
const {DownloadManager} = await import('../../chrome/player/network/DownloadManager.mjs');

const OLD = 'https://cdn.test/hls/x/master.m3u8?t=AAA&s=100&e=43200';
const NEW = 'https://cdn.test/hls/x/master.m3u8?t=BBB&s=200&e=43200';
const seg = (n, sig = 't=AAA&s=100&e=43200') => `https://cdn.test/hls/x/seg-${n}.ts?${sig}`;
const NEW_SIG = 't=BBB&s=200&e=43200';

/**
 * A player with finished downloads: segments 1 and 2 in RAM, segment 3 on the disk, the
 * playlist (text), a key (raw) and segment 4 still downloading.
 * @return {DownloadManager}
 */
function playerWithDownloads() {
  const manager = new DownloadManager(null);
  const finish = (details, data) => {
    const entry = manager.getFile(details, {}, 0).entry;
    entry.status = DownloadStatus.DOWNLOAD_COMPLETE;
    entry.data = data;
    entry.dataSize = data?.size ?? 0;
    manager.archiveEntryData(entry);
    return entry;
  };
  manager.downloaders = [];
  finish({url: seg(1), responseType: 'arraybuffer'}, new Blob(['one']));
  finish({url: seg(2), responseType: 'arraybuffer'}, new Blob(['two']));
  const onDisk = finish({url: seg(3), responseType: 'arraybuffer'}, new Blob(['three']));
  // Written to the disk since: a File there, no longer in RAM.
  const id3 = manager.getIdentifier(onDisk);
  manager.blobStore.inRam.delete(id3);
  manager.blobStore.names.set(id3, 'f7');
  manager.blobStore.blobStore.set(id3, new Blob(['on disk']));
  finish({url: 'https://cdn.test/hls/x/index.m3u8?t=AAA', responseType: 'text'}, 'playlist');
  const key = manager.getFile({url: 'https://cdn.test/key?t=AAA', responseType: 'arraybuffer', storeRaw: true}, {}, 0).entry;
  key.status = DownloadStatus.DOWNLOAD_COMPLETE;
  key.data = new ArrayBuffer(16);
  manager.getFile({url: seg(4), responseType: 'arraybuffer'}, {}, 0);
  return manager;
}

describe('DownloadManager.handOff', () => {
  it('hands over a video\'s finished files: RAM ones as Blobs, disk ones as their names', async () => {
    const manager = playerWithDownloads();
    await Promise.resolve();
    const {session, entries} = manager.handOff();
    expect(session).toBe(manager.blobStore.opfsManager.sessionName);
    expect(entries.map((e) => [e.url, e.blob ? 'ram' : e.file])).toEqual([
      [seg(1), 'ram'], [seg(2), 'ram'], [seg(3), 'f7'],
    ]);
    // Plain records: nothing of the entry itself (functions do not survive the message).
    expect(Object.keys(entries[0]).sort()).toEqual(['blob', 'dataSize', 'rangeEnd', 'rangeStart', 'responseType', 'url']);
  });
});

describe('DownloadManager.adopt', () => {
  let handOff;
  beforeEach(async () => {
    const old = playerWithDownloads();
    await Promise.resolve();
    handOff = {url: OLD, ...old.handOff()};
  });

  /**
   * A new player's request: answered from the store at once, or queued for a download.
   * @param {DownloadManager} manager
   * @param {string} url
   * @return {{stored: boolean, entry: Object}}
   */
  const ask = (manager, url) => {
    let stored = false;
    const {entry} = manager.getFile({url, responseType: 'arraybuffer'}, {onSuccess: () => {
      stored = true;
    }}, 0);
    return {stored, entry};
  };

  it('answers the same link\'s requests from what it took back', async () => {
    const manager = new DownloadManager(null);
    manager.downloaders = [];
    const {taken, onDisk} = manager.adopt(handOff, OLD);
    // The RAM's at once, the disk's while the player starts.
    expect(taken).toBe(2);
    expect(await onDisk).toBe(1);
    expect(ask(manager, seg(1)).stored).toBe(true);
    expect(ask(manager, seg(3)).stored).toBe(true);
    // The RAM ones are this player's RAM now, counted in its budget.
    expect(manager.blobStore.inRam.size).toBe(2);
    // The disk one moved into this player's session, the old session deleted.
    expect(manager.blobStore.adoptStoredFile).toHaveBeenCalledWith(expect.any(String), handOff.session, 'f7');
    expect(manager.blobStore.dropSession).toHaveBeenCalledWith(handOff.session);
    expect(handOff.session).not.toBe(manager.blobStore.opfsManager.sessionName);
  });

  it('hands over in its turn what it took back, a second reload in a row: its own session and names', async () => {
    const taker = new DownloadManager(null);
    taker.downloaders = [];
    const {onDisk} = taker.adopt(handOff, NEW);
    await onDisk;
    // One under the new link already (the player asked for it), the others as taken back.
    ask(taker, seg(1, NEW_SIG));
    const again = taker.handOff();
    expect(again.session).toBe(taker.blobStore.opfsManager.sessionName);
    expect(again.entries.map((e) => [e.url, e.blob ? 'ram' : e.file])).toEqual([
      [seg(2), 'ram'], [seg(3), taker.blobStore.names.get(taker.getIdentifier({url: seg(3), responseType: 'arraybuffer'}))],
      [seg(1, NEW_SIG), 'ram'],
    ]);
    // In RAM once each: the budget counts what it holds, no more.
    expect(taker.blobStore.inRam.size).toBe(2);
  });

  it('finds a file under the new link, its signature left out, and keeps it under the new address', async () => {
    const manager = new DownloadManager(null);
    manager.downloaders = [];
    await manager.adopt(handOff, NEW).onDisk;
    const {stored, entry} = ask(manager, seg(1, NEW_SIG));
    expect(stored).toBe(true);
    expect(entry.url).toBe(seg(1, NEW_SIG));
    // Under the new address alone, its data where the store has it.
    expect(manager.getEntry({url: seg(1), responseType: 'arraybuffer'})).toBeUndefined();
    expect(manager.getEntry({url: seg(1, NEW_SIG), responseType: 'arraybuffer'})).toBe(entry);
    manager.removeFile({url: seg(1, NEW_SIG), responseType: 'arraybuffer'});
    expect(manager.blobStore.deleteBlob).toHaveBeenCalledWith(manager.getIdentifier({url: seg(1), responseType: 'arraybuffer'}));
  });

  it('takes no other file for one: another segment, another range', async () => {
    const manager = new DownloadManager(null);
    manager.downloaders = [];
    await manager.adopt(handOff, NEW).onDisk;
    expect(ask(manager, seg(9, NEW_SIG)).stored).toBe(false);
    expect(manager.getFile({url: seg(2, NEW_SIG), rangeStart: 0, rangeEnd: 10, responseType: 'arraybuffer'},
        {}, 0).entry.status).not.toBe(DownloadStatus.DOWNLOAD_COMPLETE);
  });

  it('takes one file under two issues of the link once', async () => {
    // A FreshLink renewal downloaded segment 1 again under its new link; both were handed over.
    const twin = {url: seg(1, 't=CCC&s=150&e=43200'), rangeStart: undefined, rangeEnd: undefined,
      responseType: 'arraybuffer', dataSize: 3, blob: new Blob(['one'])};
    const manager = new DownloadManager(null);
    manager.downloaders = [];
    const {taken, onDisk} = manager.adopt({...handOff, entries: [...handOff.entries, twin]}, NEW);
    await onDisk;
    expect(taken).toBe(2);
    expect(manager.blobStore.inRam.size).toBe(2);
  });

  it('takes nothing for another link (host or path)', async () => {
    const manager = new DownloadManager(null);
    expect(manager.adopt(handOff, 'https://cdn.test/hls/y/master.m3u8?t=BBB').taken).toBe(0);
    expect(await manager.adopt(handOff, 'https://other.test/hls/x/master.m3u8?t=BBB').onDisk).toBe(0);
  });

  it('leaves out a disk file it could not move, and one for a store that keeps none on disk', async () => {
    const broken = {...handOff, entries: handOff.entries.map((e) => (e.file ? {...e, file: 'broken'} : e))};
    const manager = new DownloadManager(null);
    const {taken, onDisk} = manager.adopt(broken, OLD);
    expect(taken).toBe(2);
    expect(await onDisk).toBe(0);
    expect(manager.getEntry({url: seg(3), responseType: 'arraybuffer'})).toBeUndefined();
  });

  it('leaves a disk file the player asked for before its turn, and takes it no second time', async () => {
    const manager = new DownloadManager(null);
    manager.downloaders = [];
    const {onDisk} = manager.adopt(handOff, OLD);
    // The player asks for segment 3 before its file is moved: a download of its own.
    const asked = manager.getFile({url: seg(3), responseType: 'arraybuffer'}, {}, 0).entry;
    expect(await onDisk).toBe(0);
    expect(manager.getEntry({url: seg(3), responseType: 'arraybuffer'})).toBe(asked);
  });

  it('is gone with the next source\'s storage', async () => {
    const manager = new DownloadManager(null);
    manager.downloaders = [];
    await manager.adopt(handOff, NEW).onDisk;
    await manager.clearStorage();
    expect(ask(manager, seg(1, NEW_SIG)).stored).toBe(false);
  });
});

describe('DownloadManager.relink', () => {
  it('finds what was downloaded under the old link under a fresh one (FreshLink)', async () => {
    const manager = playerWithDownloads();
    await Promise.resolve();
    manager.relink(OLD, NEW);
    manager.keepStorageOnce();
    await manager.reset();
    manager.downloaders = [];
    let stored = false;
    manager.getFile({url: seg(2, NEW_SIG), responseType: 'arraybuffer'}, {onSuccess: () => {
      stored = true;
    }}, 0);
    expect(stored).toBe(true);
  });
});
