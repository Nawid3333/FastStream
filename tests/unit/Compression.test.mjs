import zlib from 'node:zlib';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {VideoAligner} from '../../chrome/player/modules/analyzer/VideoAligner.mjs';
import {deflate, inflate} from '../../chrome/player/utils/Compression.mjs';

// The intro/outro finder's memory (VideoAligner) is kept by the background per tab, its hash
// and time buffers compressed. That was the vendored pako 3.0.2's deflate() and inflate(); it is
// Firefox's own CompressionStream('deflate') now, the same zlib format.

// pako 3.0.2's deflate() of these buffers, made before it was removed.
const HASH = new Uint32Array([0xdeadbeef, 0x01234567, 0x89abcdef, 0, 0xffffffff, 42, 7, 0x80000000]);
const PAKO_HASH = 'eJx7v2/tvXRXZcb3Z1d3MjAwMPz///+/FgMDAzsDGDQAAPfYC6Y=';
const TIME = new Uint16Array([0, 1, 2, 2, 5, 65535, 3, 1]);
const PAKO_TIME = 'eJxjYGBkYGJgYmBl+P+fmYGRAQALdQIN';

describe('Compression', () => {
  it('reads what pako wrote', async () => {
    expect(new Uint32Array((await inflate(Uint8Array.fromBase64(PAKO_HASH))).buffer)).toEqual(HASH);
    expect(new Uint16Array((await inflate(Uint8Array.fromBase64(PAKO_TIME))).buffer)).toEqual(TIME);
  });

  it('writes zlib, as pako did: another implementation reads it', async () => {
    // Not pako's bytes in Firefox (its compressor differs, measured), but the same format.
    for (const data of [HASH, TIME]) {
      const written = await deflate(data);
      expect(written[0]).toBe(0x78);
      expect(new Uint8Array(zlib.inflateSync(written))).toEqual(new Uint8Array(data.buffer));
    }
  });

  it('gets back what it compressed, over a buffer exactly as long', async () => {
    const data = new Uint8Array(100000).map((_, i) => (i * 7919) % 251);
    const back = await inflate(await deflate(data));
    expect(back).toEqual(data);
    expect(back.buffer.byteLength).toBe(data.length);
  });

  it('rejects what is not zlib', async () => {
    await expect(inflate(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow();
  });
});

describe('VideoAligner memory, saved and loaded again', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {createElement: () => ({getContext: () => ({})})});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('comes back as it was', async () => {
    const aligner = new VideoAligner();
    aligner.prepare('episode-1');
    aligner.prepare('episode-2');
    const sequence = (offset) => Array.from({length: 50}, (_, i) => ({
      time: 10 + i * 0.5 + offset,
      // A 16x8 dHash: 64 bits, two words.
      hash: new Uint32Array([0xffffffff - i * 3 - offset, 0x80000000 + i]),
    }));
    // Times as the aligner records them: whole hundredths (Uint16 steps between them).
    for (const [identifier, offset] of [['episode-1', 0], ['episode-2', 1]]) {
      const item = aligner.memory.get(identifier);
      item.sequence.push(...sequence(offset).map((entry) => ({...entry, time: Math.round(entry.time)})));
      item.matchStart = 12;
      item.matchEnd = 30;
    }

    const saved = await aligner.getMemoryForSave();
    expect(Object.keys(saved)).toEqual(['episode-1', 'episode-2']);
    expect(typeof saved['episode-1'].hashBuffer).toBe('string');

    const loaded = new VideoAligner();
    await loaded.loadMemoryFromSave(JSON.parse(JSON.stringify(saved)));
    for (const identifier of ['episode-1', 'episode-2']) {
      const before = aligner.memory.get(identifier);
      const after = loaded.memory.get(identifier);
      expect(after.sequence.map((entry) => entry.time)).toEqual(before.sequence.map((entry) => entry.time));
      expect(after.sequence.map((entry) => [...entry.hash])).toEqual(before.sequence.map((entry) => [...entry.hash]));
      expect([after.deleteIn, after.matchStart, after.matchEnd]).toEqual([before.deleteIn, 12, 30]);
    }
  });

  it('leaves the memory as it was when what was saved does not read', async () => {
    const aligner = new VideoAligner();
    aligner.prepare('episode-1');
    await expect(aligner.loadMemoryFromSave({
      'episode-1': {hashBuffer: 'AAAA', timeBuffer: 'AAAA', startTime: 0, deleteIn: 3, matchStart: -1, matchEnd: -1},
    })).rejects.toThrow();
    expect(aligner.memory.get('episode-1').sequence).toEqual([]);
  });
});
