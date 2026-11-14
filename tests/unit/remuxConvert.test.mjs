import {describe, expect, it, vi} from 'vitest';

// The save's fallback (remux/remuxer.mjs): what MP4Merger cannot join - a WebM, fMP4 it does
// not know - is copied into an MP4 by Mediabunny, packet by packet, nothing decoded. The
// e2e saves (save-fmp4.e2e.mjs) cover it in Firefox; this runs the real Mediabunny and
// MP4Writer here, on a WebM of its own (below), with an in-memory blob store, and reads the
// MP4 back: every packet, at its time.

vi.mock('../../chrome/player/modules/FSBlob.mjs', () => ({
  FSBlob: class {
    constructor() {
      this.blobs = new Map();
      this.next = 0;
    }
    createBlob(data) {
      const id = 'piece' + this.next++;
      this.blobs.set(id, new Blob([data]));
      return id;
    }
    getBlob(id) {
      return this.blobs.get(id);
    }
    close() {}
  },
}));

const {Remuxer} = await import('../../chrome/player/modules/remux/remuxer.mjs');
const {ALL_FORMATS, BlobSource, EncodedPacketSink, Input} = await import('../../chrome/player/modules/remux/mediabunny.mjs');

// Half a second of VP9 (16x16, 5 frames) and Opus (26 packets), 2.7 KB; the e2e fixtures are
// built by ffmpeg in the e2e jobs only. Made with: ffmpeg -f lavfi -i testsrc=size=16x16:rate=10
// -f lavfi -i sine=frequency=440:sample_rate=48000 -t 0.5 -c:v libvpx-vp9 -b:v 8k -g 3
// -cpu-used 8 -c:a libopus -b:a 6k -ac 1 -fflags +bitexact -map_metadata -1 tiny.webm
const WEBM = [
  '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',
].join('');

/**
 * Each track's codec and its packets' times, in seconds, in decode order.
 * @param {Blob} blob - A media file.
 * @return {Promise<Object<string, {codec: string, times: number[]}>>}
 */
async function packetsOf(blob) {
  const input = new Input({source: new BlobSource(blob), formats: ALL_FORMATS});
  try {
    const out = {};
    for (const track of [await input.getPrimaryVideoTrack(), await input.getPrimaryAudioTrack()]) {
      if (!track) continue;
      const times = [];
      for await (const packet of new EncodedPacketSink(track).packets()) times.push(packet.timestamp);
      out[track.type] = {codec: await track.getCodec(), times};
    }
    return out;
  } finally {
    input.dispose();
  }
}

describe('Remuxer, a WebM saved as an MP4', () => {
  it('copies every packet, at its time', async () => {
    const webm = new Blob([Buffer.from(WEBM, 'base64')]);
    const progress = [];
    const remuxer = new Remuxer(() => {});
    remuxer.on('progress', (p) => progress.push(p));
    const mp4 = await remuxer.convert(null, 10, null, null, 0, null,
        [{track: 0, getEntry: async () => ({getData: async () => webm})}]);
    remuxer.release();

    const head = new Uint8Array(await mp4.slice(0, 12).arrayBuffer());
    expect(new TextDecoder().decode(head.subarray(4, 8))).toBe('ftyp');
    const before = await packetsOf(webm);
    const after = await packetsOf(mp4);
    expect([before.video.times.length, before.audio.times.length]).toEqual([5, 26]);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    // The WebM's Opus starts 7 ms before 0 (its codec delay); the MP4 starts at 0. Every track
    // moves by that one shift, so sound and picture stay together.
    const shift = -Math.min(before.video.times[0], before.audio.times[0]);
    expect(shift).toBeCloseTo(0.007, 3);
    for (const type of Object.keys(before)) {
      expect(after[type].codec).toBe(before[type].codec);
      expect(after[type].times.length).toBe(before[type].times.length);
      // The MP4's timescale rounds a time a little.
      after[type].times.forEach((time, i) => expect(time).toBeCloseTo(before[type].times[i] + shift, 3));
    }
    expect(progress.at(-1)).toBe(1);
  });

  it('asks the player to keep each fragment it reads until the save is over', async () => {
    // Its inputs are the player's stored Blobs, read as the file is written: one let go of
    // once read could be freed, its File on disk deleted, before Mediabunny read it.
    const webm = new Blob([Buffer.from(WEBM, 'base64')]);
    const getEntry = vi.fn(async () => ({getData: async () => webm}));
    const remuxer = new Remuxer(() => {});
    await remuxer.convert(null, 10, null, null, 0, null, [{track: 0, getEntry}]);
    remuxer.release();
    expect(getEntry).toHaveBeenCalledWith({keepPinned: true});
  });

  it('says which codec it cannot save, rather than writing a broken file', async () => {
    const remuxer = new Remuxer(() => {});
    const garbage = new Blob([new Uint8Array(4096).fill(7)]);
    await expect(remuxer.convert(null, 10, null, null, 0, null,
        [{track: 0, getEntry: async () => ({getData: async () => garbage})}])).rejects.toThrow();
  });
});
