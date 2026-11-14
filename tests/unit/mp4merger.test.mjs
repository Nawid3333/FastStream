import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {fragment, initSegment, videoTrack} from './helpers/fmp4.mjs';
import {find, readDuration, readMp4} from './helpers/mp4boxes.mjs';

// The merger (MP4Merger), which joins a DASH or fMP4 HLS stream's fragments into one MP4
// with mp4box (the patched npm build: see vitest.config.mjs), and the file it writes read
// back box by box.

// Every blob store made, to see which were closed.
const stores = [];

vi.mock('../../chrome/player/modules/FSBlob.mjs', () => ({
  FSBlob: class {
    constructor() {
      stores.push(this);
      this.blobs = new Map();
      this.next = 0;
      this.closed = false;
      // Without OPFS finalize() builds the file as a Blob.
      this.opfsManager = globalThis.mergerOpfs ?? null;
    }
    saveBlob(blob) {
      const id = `blob${this.next++}`;
      this.blobs.set(id, blob);
      return id;
    }
    getBlob(id) {
      return this.blobs.get(id);
    }
    close(removeFiles) {
      this.closed = true;
      this.removedFiles = !!removeFiles;
    }
  },
}));

vi.mock('../../chrome/player/utils/BlobManager.mjs', () => ({
  BlobManager: {
    getDataFromBlob: async (blob) => blob.arrayBuffer(),
  },
}));

const {MP4Merger} = await import('../../chrome/player/modules/dash2mp4/mp4merger.mjs');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete globalThis.mergerOpfs;
});

/**
 * Merges a video-only stream and reads the file back.
 * @param {Object} track from videoTrack()
 * @param {Blob[]} fragments
 * @param {number} duration in seconds
 * @return {Promise<Object>} readMp4() of the file
 */
async function merge(track, fragments, duration) {
  const zipped = fragments.map((data) => ({track: 0, getEntry: async () => ({getData: async () => data, getDataFromBlob: async () => data.arrayBuffer()})}));
  const blob = await new MP4Merger().convert(duration, initSegment(track), 0, null, zipped);
  return readMp4(new Uint8Array(await blob.arrayBuffer()));
}

describe('MP4Merger: what it writes', () => {
  it('writes negative composition offsets into a signed (version 1) ctts', async () => {
    // A CMAF stream with B pictures: trun version 1, the reordered pictures shown before
    // they are decoded. The ctts was always version 0, which is unsigned: -3000 read as
    // 4294964296, nearly 13 hours at 90 kHz.
    const track = videoTrack({timescale: 90000});
    const samples = [
      {duration: 3000, cts: 0, key: true},
      {duration: 3000, cts: 3000},
      {duration: 3000, cts: -3000},
      {duration: 3000, cts: 3000},
      {duration: 3000, cts: -3000},
    ];
    const {tracks} = await merge(track, [fragment(track, 1, 0, samples)], 15000 / 90000);

    expect(tracks.vide.ctts.version).toBe(1);
    expect(tracks.vide.ctts.offsets).toEqual(samples.map((sample) => sample.cts));
  });

  it('keeps a version 0 ctts when no offset is negative', async () => {
    const track = videoTrack({timescale: 90000});
    const samples = [
      {duration: 3000, cts: 3000, key: true},
      {duration: 3000, cts: 6000},
      {duration: 3000, cts: 0},
    ];
    const {tracks} = await merge(track, [fragment(track, 1, 0, samples)], 9000 / 90000);

    expect(tracks.vide.ctts.version).toBe(0);
    expect(tracks.vide.ctts.offsets).toEqual([3000, 6000, 0]);
  });

  it('writes an edit longer than 2^32 ticks of the movie timescale in full', async () => {
    // A 10 MHz video timescale (common in DASH made from Smooth Streaming) runs past 2^32
    // after 7 minutes 9 s. The movie timescale is the video's, and the edit was 32-bit: an
    // 8 minute save had an edit of 1 minute 10 s, and players that follow edit lists
    // stopped there.
    const timescale = 10000000;
    const track = videoTrack({timescale});
    const minute = 60 * timescale;
    const samples = Array.from({length: 8}, (_, i) => ({duration: minute, cts: 0, key: i === 0}));
    const {tracks} = await merge(track, [fragment(track, 1, 0, samples)], 8 * 60);

    expect(tracks.vide.elst.version).toBe(1);
    expect(tracks.vide.editEnd).toBe(8 * 60);
    expect(tracks.vide.mediaEnd).toBe(8 * 60);
  });

  it('keeps a version 0 edit list when it fits', async () => {
    const track = videoTrack({timescale: 90000});
    const samples = [{duration: 3000, cts: 0, key: true}, {duration: 3000, cts: 0}];
    const {tracks} = await merge(track, [fragment(track, 1, 0, samples)], 6000 / 90000);

    expect(tracks.vide.elst.version).toBe(0);
    expect(tracks.vide.editEnd).toBeCloseTo(6000 / 90000, 6);
  });
});

describe('MP4Merger: cancelling', () => {
  it('stops while it writes the file to OPFS', async () => {
    // With OPFS, every fragment's media goes into one file (as it is read, since the media
    // copied at the end after the progress reached 100 % could not be read any more); for
    // a large video that takes a while. It did not look at the cancel, so a cancelled save
    // still finished and downloaded.
    let cancel;
    const opfs = {
      saveBegin: vi.fn(async () => {}),
      saveAppend: vi.fn(async () => {
        // The user cancels while the writes run.
        if (opfs.saveAppend.mock.calls.length === 2) cancel();
      }),
      saveEnd: vi.fn(async () => {}),
      getSavedFile: vi.fn(async () => new Blob(['file'])),
      saveAbort: vi.fn(async () => {}),
    };
    globalThis.mergerOpfs = opfs;
    const track = videoTrack({timescale: 90000});
    const fragments = [0, 1, 2, 3].map((i) => fragment(track, i + 1, i * 6000,
        [{duration: 3000, cts: 0, key: true}, {duration: 3000, cts: 0}]));
    const zipped = fragments.map((data) => ({track: 0, getEntry: async () => ({getData: async () => data, getDataFromBlob: async () => data.arrayBuffer()})}));
    const merger = new MP4Merger((fn) => {
      cancel = fn;
    });

    await expect(merger.convert(24000 / 90000, initSegment(track), 0, null, zipped)).rejects.toThrow('Cancelled');
    expect(opfs.saveAbort).toHaveBeenCalledTimes(1);
    expect(opfs.getSavedFile).not.toHaveBeenCalled();
  });
});

describe('MP4Merger: the blob store of a save', () => {
  it('keeps the store the saved file reads from until release()', async () => {
    // It closed two minutes after the save, and a closed OPFS session is deleted by the
    // next player or save that starts: a longer download, or the same file saved again,
    // lost it. SaveManager releases it once nothing will read the file.
    vi.useFakeTimers();
    const track = videoTrack({timescale: 90000});
    const data = fragment(track, 1, 0, [{duration: 3000, cts: 0, key: true}]);
    const merger = new MP4Merger();
    await merger.convert(3000 / 90000, initSegment(track), 0, null,
        [{track: 0, getEntry: async () => ({getData: async () => data, getDataFromBlob: async () => data.arrayBuffer()})}]);
    const store = stores.at(-1);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(store.closed).toBe(false);
    merger.release();
    expect(store.closed).toBe(true);
    // Its files stay: SaveManager does not know that the download is over.
    expect(store.removedFiles).toBe(false);
  });

  it('deletes its files with the store when released after the download is over', async () => {
    const track = videoTrack({timescale: 90000});
    const data = fragment(track, 1, 0, [{duration: 3000, cts: 0, key: true}]);
    const merger = new MP4Merger();
    await merger.convert(3000 / 90000, initSegment(track), 0, null,
        [{track: 0, getEntry: async () => ({getDataFromBlob: async () => data.arrayBuffer()})}]);
    merger.release(true);
    expect(stores.at(-1).removedFiles).toBe(true);
  });

  it('closes the store at once when the save fails', async () => {
    const merger = new MP4Merger();
    const broken = {track: 0, getEntry: async () => ({getData: async () => new Blob(['not an mp4']), getDataFromBlob: async () => new Blob(['not an mp4']).arrayBuffer()})};
    const track = videoTrack({timescale: 90000});
    await expect(merger.convert(1, initSegment(track), 0, null, [broken])).rejects.toThrow();

    expect(stores.at(-1).closed).toBe(true);
    // Nothing will read them.
    expect(stores.at(-1).removedFiles).toBe(true);
  });
});

// A save read a fragment from the store, converted it, and only then read the next: the
// store's read and the conversion each waited for the other. The next one is read while this
// one converts now; a read that fails still fails the save, in its turn, and nothing is left
// unhandled.
describe('MP4Merger: reading the next fragment while one converts', () => {
  /**
   * A merger whose reads and conversions are recorded, each held until let go.
   * @param {number} count - Fragments.
   * @param {number} [failing] - The fragment whose read fails.
   * @return {Object}
   */
  function recorded(count, failing = -1) {
    const merger = new MP4Merger();
    const events = [];
    merger.setup = () => {};
    merger.videoTrack = {};
    merger.finalize = async () => 'file';
    merger.readFragment = async (fragData) => {
      events.push(`read ${fragData.n}`);
      await Promise.resolve();
      if (fragData.n === failing) throw new Error(`read ${fragData.n} failed`);
      return {data: fragData.n, blob: null};
    };
    merger.pushFragment = async (track, fragData, read) => {
      events.push(`convert ${read.data}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`converted ${read.data}`);
    };
    const zipped = Array.from({length: count}, (_, n) => ({n, track: 0}));
    return {merger, events, zipped};
  }

  it('starts the next fragment\'s read before the conversion of this one ends, in order', async () => {
    const {merger, events, zipped} = recorded(3);
    expect(await merger.convert(10, null, 0, null, zipped)).toBe('file');
    expect(events.indexOf('read 1')).toBeLessThan(events.indexOf('converted 0'));
    expect(events.indexOf('read 2')).toBeLessThan(events.indexOf('converted 1'));
    expect(events.filter((e) => e.startsWith('convert '))).toEqual(['convert 0', 'convert 1', 'convert 2']);
  });

  it('fails the save with a read that failed while the fragment before converted', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const {merger, events, zipped} = recorded(3, 1);
      await expect(merger.convert(10, null, 0, null, zipped)).rejects.toThrow('read 1 failed');
      expect(events).toContain('converted 0');
      expect(events).not.toContain('convert 1');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

// The merger kept a slice of each fragment's own Blob (the player's store: in RAM, or a File
// of its OPFS session) until the end, and wrote the file only then. The player lets go of a
// fragment once the save has read it, and frees it when it no longer needs it (a quality
// change, the buffer moving on): the slice of an OPFS File then read nothing, the copy
// failed, and its fallback handed over a Blob of the same dead slices - "Save complete", and
// the download failed. Slices of RAM Blobs kept the whole video in RAM past the budget. Each
// fragment's media goes into the save's own file as it is read now, as the HLS save does.
describe('MP4Merger: a save written as it goes, holding nothing of the player\'s store', () => {
  const track = videoTrack({timescale: 90000});
  const fragments = () => [0, 1, 2, 3].map((i) => fragment(track, i + 1, i * 6000,
      [{duration: 3000, cts: 0, key: true}, {duration: 3000, cts: 0}]));
  /**
   * A fragment as the player's store hands it over: read while the save pins it, and let go
   * of once read (getEntry). Its stored File reads nothing after that: the player freed it.
   * @param {Blob} data
   * @param {string[]} [log]
   * @return {Object}
   */
  const freedOnceRead = (data, log) => ({track: 0, getEntry: async () => {
    log?.push('read');
    const gone = () => Promise.reject(new DOMException('A requested file or directory could not be found', 'NotFoundError'));
    const file = {size: data.size, slice: () => ({size: data.size, arrayBuffer: gone}), arrayBuffer: gone};
    return {getData: async () => file, getDataFromBlob: async () => data.arrayBuffer()};
  }});
  const alive = (data) => ({track: 0, getEntry: async () => ({getData: async () => data, getDataFromBlob: async () => data.arrayBuffer()})});
  /**
   * An OPFS manager in memory.
   * @param {{failAppend?: number, log?: string[]}} [options] - failAppend: that append (from
   *   1) rejects, as when the disk or the quota is full.
   * @return {Object}
   */
  const fakeOpfs = ({failAppend = 0, log = []} = {}) => {
    const files = new Map();
    let appends = 0;
    return {
      files,
      log,
      saveBegin: async (id) => {
        files.set(id, []);
        log.push('begin');
      },
      saveAppend: async (id, data) => {
        log.push('append');
        if (++appends === failAppend) throw new Error('QuotaExceededError');
        files.get(id).push(new Uint8Array(data));
      },
      saveEnd: async () => {
        log.push('end');
      },
      getSavedFile: async (id) => new Blob(files.get(id)),
      saveAbort: async (id) => {
        files.delete(id);
        log.push('abort');
      },
    };
  };
  const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
  const convert = (zipped) => new MP4Merger().convert(24000 / 90000, initSegment(track), 0, null, zipped);

  it('writes each fragment to disk as it is read, and the file needs none of them later', async () => {
    const expected = await bytesOf(await convert(fragments().map(alive)));
    const log = [];
    globalThis.mergerOpfs = fakeOpfs({log});
    const saved = await bytesOf(await convert(fragments().map((data) => freedOnceRead(data, log))));
    expect(saved).toEqual(expected);
    // The first fragment's media was on its way to the file before the last was read.
    expect(log.indexOf('append')).toBeLessThan(log.lastIndexOf('read'));
    expect(log.filter((step) => step === 'append')).toHaveLength(4);
    expect(log.at(-1)).toBe('end');
  });

  it('keeps its own copy of each fragment where there is no OPFS (a private window)', async () => {
    const expected = await bytesOf(await convert(fragments().map(alive)));
    const saved = await bytesOf(await convert(fragments().map((data) => freedOnceRead(data))));
    expect(saved).toEqual(expected);
    expect(stores.at(-1).blobs.size).toBe(4);
  });

  it('fails the save when a piece it kept is gone, rather than handing over a broken file', async () => {
    const merger = new MP4Merger();
    const getBlob = merger.blobManager.getBlob.bind(merger.blobManager);
    merger.blobManager.getBlob = (id) => (id === 'blob2' ? undefined : getBlob(id));
    await expect(merger.convert(24000 / 90000, initSegment(track), 0, null, fragments().map(alive))).rejects.toThrow();
  });

  it('fails the save when the disk refuses a piece, and drops the file', async () => {
    let opfs;
    globalThis.mergerOpfs = opfs = fakeOpfs({failAppend: 2});
    await expect(convert(fragments().map(alive))).rejects.toThrow('QuotaExceededError');
    expect(opfs.log.at(-1)).toBe('abort');
    expect(opfs.files.size).toBe(0);
    expect(stores.at(-1).closed).toBe(true);
  });

  it('drops the file on disk when a fragment fails, as the HLS save does', async () => {
    let opfs;
    globalThis.mergerOpfs = opfs = fakeOpfs();
    const failed = {track: 0, getEntry: async () => {
      throw new Error('Bad status code: 404');
    }};
    await expect(convert([...fragments().map(alive), failed])).rejects.toThrow('Bad status code: 404');
    expect(opfs.log.at(-1)).toBe('abort');
    expect(opfs.files.size).toBe(0);
    expect(stores.at(-1).closed).toBe(true);
  });
});

// A partial save (Alt-click: what is downloaded) wrote the whole stream's length into the
// file's headers - the DASH period's, hls.js's total duration - and Firefox, which takes a
// video's duration from the moov, said a 10 minute save of an hour-long stream lasted an hour.
describe('MP4Merger: the length a partial save says it has', () => {
  it('is the length of the fragments saved, in mdhd, tkhd and mvhd', async () => {
    const track = videoTrack({timescale: 90000});
    const fragments = [0, 1, 2, 3, 4].map((i) => fragment(track, i + 1, i * 6000,
        [{duration: 3000, cts: 0, key: true}, {duration: 3000, cts: 0}]));
    const zipped = fragments.slice(0, 3).map((data) => ({track: 0, getEntry: async () => ({getDataFromBlob: async () => data.arrayBuffer()})}));
    // The period: all five fragments.
    const blob = await new MP4Merger().convert(5 * 6000 / 90000, initSegment(track), 0, null, zipped);
    const {boxes, tracks} = readMp4(new Uint8Array(await blob.arrayBuffer()));
    const trak = tracks.vide.trak;
    expect(readDuration(find(trak.children, 'mdia/mdhd')) / tracks.vide.timescale).toBeCloseTo(0.2, 6);
    expect(readDuration(find(trak.children, 'tkhd')) / tracks.vide.movieTimescale).toBeCloseTo(0.2, 6);
    expect(readDuration(find(boxes, 'moov/mvhd')) / tracks.vide.movieTimescale).toBeCloseTo(0.2, 6);
  });
});
