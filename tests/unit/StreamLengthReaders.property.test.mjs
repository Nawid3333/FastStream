import fc from 'fast-check';
import {describe, expect, it} from 'vitest';

import {PIECE_LENGTH, StreamLength} from '../../chrome/player/utils/StreamLength.mjs';

// What a server sends, as the background's length reads get it (StreamLengths.mjs): the first
// 64 KB of a file, read up to three times, and a manifest's text up to 4 MB. They run in the
// event page that serves every tab, with no catch of their own around the parse. None may
// throw, each answers in the shape its caller reads, and none takes long on the most a server
// can send (the review round of 2026-11-15).

/**
 * An MP4 box: its size (any, also 0, 1 for a 64-bit size, or more than there is), its type,
 * and what is in it.
 * @param {number} depth - How many more levels may nest.
 * @return {fc.Arbitrary<Uint8Array>}
 */
function box(depth) {
  const type = fc.constantFrom('ftyp', 'moov', 'mvhd', 'trak', 'mdia', 'mdhd', 'moof', 'mdat', 'mvex', 'mehd', 'sidx', 'free', 'abcd');
  const body = depth > 0 ?
    fc.oneof(fc.uint8Array({maxLength: 40}), fc.array(box(depth - 1), {maxLength: 3}).map(concat)) :
    fc.uint8Array({maxLength: 40});
  return fc.tuple(type, body, fc.oneof(fc.constant(null), fc.constantFrom(0, 1, 7, 8, 0xffffffff), fc.nat()),
      fc.boolean(), fc.nat({max: 2}), fc.oneof(fc.constant(0), fc.nat(), fc.constant(0xffffffff))).map(([name, inner, size, wide, version, high]) => {
    const head = new Uint8Array(wide ? 16 : 8);
    const view = new DataView(head.buffer);
    const full = (name === 'mvhd' || name === 'mdhd' || name === 'mehd') ? concat([Uint8Array.of(version, 0, 0, 0), inner]) : inner;
    const real = head.length + full.length;
    view.setUint32(0, wide ? 1 : (size ?? real) >>> 0);
    for (let i = 0; i < 4; i++) head[4 + i] = name.charCodeAt(i);
    if (wide) {
      view.setUint32(8, high >>> 0);
      view.setUint32(12, (size ?? real) >>> 0);
    }
    return concat([head, full]);
  });
}

/** @param {Uint8Array[]} parts @return {Uint8Array} */
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const mp4 = fc.array(box(3), {maxLength: 6}).map(concat);
// EBML: an ID, a size as a variable-length integer (also the "unknown" all-ones), and data.
const ebml = fc.array(fc.tuple(
    fc.constantFrom([0x1a, 0x45, 0xdf, 0xa3], [0x18, 0x53, 0x80, 0x67], [0x15, 0x49, 0xa9, 0x66], [0x2a, 0xd7, 0xb1], [0x44, 0x89], [0xec]),
    fc.oneof(fc.constant([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), fc.constant([0xff]), fc.nat({max: 127}).map((n) => [0x80 | n]),
        fc.constant([0x40, 0x00]), fc.constant([0x00])),
    fc.uint8Array({maxLength: 24}),
).map(([id, size, data]) => concat([Uint8Array.from(id), Uint8Array.from(size), data])), {maxLength: 8}).map(concat);

const HLS_LINES = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720', '#EXT-X-STREAM-INF:', 'v.m3u8', '',
  '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"', '#EXT-X-KEY:METHOD=AES-128,URI="k"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="a.m3u8"', '#EXTINF:4,', 'seg.ts', '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES', 'A="', ',,,', '=""=', '#EXT-X-STREAM-INF:__proto__=1,constructor=2,BANDWIDTH=1e999\r', 'v.m3u8\r', '#EXT-X-STREAM-INF:BANDWIDTH=-5,RESOLUTION=0x-1'];
const hlsText = fc.oneof(fc.string({maxLength: 300}), fc.array(fc.oneof(fc.constantFrom(...HLS_LINES), fc.string({maxLength: 30})), {maxLength: 40})
    .map((lines) => lines.join('\n')));
const DASH_PARTS = ['<MPD>', '</MPD>', '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>',
  '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>', '<!--', '-->', '<', '"', 'cenc:default_KID="x"'];
const dashText = fc.oneof(fc.string({maxLength: 300}), fc.array(fc.oneof(fc.constantFrom(...DASH_PARTS), fc.string({maxLength: 30})), {maxLength: 40})
    .map((parts) => parts.join('')));

describe('The length reads of what a server sends', () => {
  it('fromFile: any start of a file is a length, where to read next, or nothing', () => {
    fc.assert(fc.property(fc.oneof(mp4, fc.uint8Array({maxLength: 200})), fc.nat({max: 1e9}), fc.boolean(), (bytes, offset, ended) => {
      const result = StreamLength.fromFile(bytes, offset, ended);
      if (result === null) return;
      if ('duration' in result) {
        // Seconds, or PIECE_LENGTH: the file is a piece of a stream (a moof first).
        expect(result.duration === PIECE_LENGTH || (Number.isFinite(result.duration) && result.duration > 0)).toBe(true);
      } else {
        // A place in the file. The caller reads on only from a later one (StreamLengths stops
        // at next <= offset: nothing to read at offset, such as no bytes at all, answers offset).
        expect(Number.isInteger(result.next) && result.next >= 0).toBe(true);
      }
    }), {numRuns: 3000});
  });

  it('fromWebm: any start of a file is a length or nothing', () => {
    fc.assert(fc.property(fc.oneof(ebml, fc.uint8Array({maxLength: 200})), fc.boolean(), (bytes, ended) => {
      const result = StreamLength.fromWebm(bytes, ended);
      if (result !== null) {
        // Seconds, or PIECE_LENGTH for an init segment.
        expect(result === PIECE_LENGTH || (Number.isFinite(result) && result > 0)).toBe(true);
      }
    }), {numRuns: 3000});
  });

  it('hlsVariants, hlsProtected, hlsAttributes: any playlist text answers in its shape', () => {
    fc.assert(fc.property(hlsText, (text) => {
      const parsed = StreamLength.hlsVariants(text);
      if (parsed !== null) {
        expect(Array.isArray(parsed.variants)).toBe(true);
        for (const variant of parsed.variants) {
          expect(typeof variant.uri).toBe('string');
          expect(Number.isFinite(variant.bandwidth) && variant.bandwidth >= 0).toBe(true);
          expect(Number.isFinite(variant.height) && variant.height >= 0).toBe(true);
        }
      }
      expect(typeof StreamLength.hlsProtected(text)).toBe('boolean');
      const attributes = StreamLength.hlsAttributes(text);
      expect(attributes && typeof attributes).toBe('object');
      for (const value of Object.values(attributes)) expect(typeof value).toBe('string');
      expect(Object.getPrototypeOf(attributes) === Object.prototype || Object.getPrototypeOf(attributes) === null).toBe(true);
      expect(({}).polluted).toBeUndefined();
    }), {numRuns: 3000});
  });

  it('dashProtected: any manifest text is protected or not', () => {
    fc.assert(fc.property(dashText, (text) => {
      expect(typeof StreamLength.dashProtected(text)).toBe('boolean');
    }), {numRuns: 3000});
  });

  it('none takes long on the most a server can send', () => {
    const chunk = 64 * 1024;
    const text = 4 * 1024 * 1024;
    // Boxes of 8 bytes, the smallest, as many as fit; boxes claiming more than there is;
    // EBML elements of unknown size; text built of the characters the readers look for.
    const tinyBoxes = new Uint8Array(chunk);
    for (let at = 0; at + 8 <= chunk; at += 8) tinyBoxes.set([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65], at);
    const nested = new Uint8Array(chunk);
    for (let at = 0; at + 8 <= chunk; at += 8) nested.set([0x00, 0x00, 0xff, 0xff, 0x6d, 0x6f, 0x6f, 0x76], at);
    const unknownSizes = new Uint8Array(chunk);
    for (let at = 0; at + 5 <= chunk; at += 5) unknownSizes.set([0x1a, 0x45, 0xdf, 0xa3, 0xff], at);
    const inputs = [
      () => StreamLength.fromFile(tinyBoxes, 0, false),
      () => StreamLength.fromFile(nested, 0, true),
      () => StreamLength.fromWebm(unknownSizes, false),
      () => StreamLength.fromWebm(new Uint8Array(chunk).fill(0x01), true),
      () => StreamLength.hlsVariants('#EXT-X-STREAM-INF:' + 'A="'.repeat(text / 3)),
      () => StreamLength.hlsVariants(('#EXT-X-STREAM-INF:BANDWIDTH=1\nv\n').repeat(text / 32)),
      () => StreamLength.hlsProtected('#EXT-X-KEY:' + ',METHOD='.repeat(text / 8)),
      () => StreamLength.hlsAttributes('A='.repeat(text / 2)),
      () => StreamLength.hlsAttributes('A="'.repeat(text / 3)),
      () => StreamLength.dashProtected('<ContentProtection '.repeat(text / 19)),
      () => StreamLength.dashProtected('<!--'.repeat(text / 4)),
    ];
    for (const [i, read] of inputs.entries()) {
      const start = performance.now();
      read();
      expect(performance.now() - start, `input ${i}`).toBeLessThan(1500);
    }
  });
});
