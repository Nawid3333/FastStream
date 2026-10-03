import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {fragment, initSegment, videoTrack} from './helpers/fmp4.mjs';
import {readMp4} from './helpers/mp4boxes.mjs';

// The merger (MP4Merger), which joins a DASH or fMP4 HLS stream's fragments into one MP4
// with mp4box (the patched npm build: see vitest.config.mjs), and the file it writes read
// back box by box.

// Every blob store made, to see which were closed.
const stores = [];

vi.mock('../../chrome/player/modules/FSBlob.mjs', () => ({
  FSBlob: class {
    constructor() {
      stores.push(this);
      this.closed = false;
      // Without OPFS finalize() builds the file as a Blob.
      this.opfsManager = globalThis.mergerOpfs ?? null;
    }
    close() {
      this.closed = true;
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
  const zipped = fragments.map((data) => ({track: 0, getEntry: async () => ({getData: async () => data})}));
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
  it('stops while it copies the finished file to OPFS', async () => {
    // With OPFS, finalize() copies every fragment's media into one file after the progress
    // has reached 100 %; for a large video that takes a while. It did not look at the
    // cancel, so a cancelled save still finished and downloaded.
    let cancel;
    const opfs = {
      saveBegin: vi.fn(async () => {}),
      saveAppend: vi.fn(async () => {
        // The user cancels while the copy runs.
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
    const zipped = fragments.map((data) => ({track: 0, getEntry: async () => ({getData: async () => data})}));
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
        [{track: 0, getEntry: async () => ({getData: async () => data})}]);
    const store = stores.at(-1);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(store.closed).toBe(false);
    merger.release();
    expect(store.closed).toBe(true);
  });

  it('closes the store at once when the save fails', async () => {
    const merger = new MP4Merger();
    const broken = {track: 0, getEntry: async () => ({getData: async () => new Blob(['not an mp4'])})};
    const track = videoTrack({timescale: 90000});
    await expect(merger.convert(1, initSegment(track), 0, null, [broken])).rejects.toThrow();

    expect(stores.at(-1).closed).toBe(true);
  });
});
