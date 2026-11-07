import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';

// The save's fallback (remux/remuxer.mjs): what MP4Merger cannot join - a WebM, fMP4 it does
// not know - is copied into an MP4 by Mediabunny, packet by packet, nothing decoded. The
// e2e saves (save-fmp4.e2e.mjs) cover it in Firefox; this runs the real Mediabunny and
// MP4Writer here, on the e2e suite's WebM (VP9, 60 frames, no sound), with an in-memory blob store, and reads the MP4
// back: every packet, at its time.

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

const WEBM = path.resolve(import.meta.dirname, '../e2e/fixtures/sample.webm');

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
    const webm = new Blob([fs.readFileSync(WEBM)]);
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
    expect(before.video.times.length).toBeGreaterThan(0);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const type of Object.keys(before)) {
      expect(after[type].codec).toBe(before[type].codec);
      expect(after[type].times.length).toBe(before[type].times.length);
      // The MP4's timescale rounds a time a little.
      after[type].times.forEach((time, i) => expect(time).toBeCloseTo(before[type].times[i], 3));
    }
    expect(progress.at(-1)).toBe(1);
  });

  it('says which codec it cannot save, rather than writing a broken file', async () => {
    const remuxer = new Remuxer(() => {});
    const garbage = new Blob([new Uint8Array(4096).fill(7)]);
    await expect(remuxer.convert(null, 10, null, null, 0, null,
        [{track: 0, getEntry: async () => ({getData: async () => garbage})}])).rejects.toThrow();
  });
});
