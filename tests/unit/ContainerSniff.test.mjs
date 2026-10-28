import {describe, expect, it} from 'vitest';

import {startsLikeMp4} from '../../chrome/player/utils/ContainerSniff.mjs';

// A hoster's Matroska file came as video/mp4 from an .mp4 URL: MP4Player gave it to mp4box,
// which stopped at its first bytes, and the player failed on a file the page's own <video>
// played. MP4Player now hands a file that cannot be an MP4 to Firefox's own player.

const bytes = (...parts) => new Uint8Array(parts.flatMap((part) => typeof part === 'string' ?
  [...part].map((c) => c.charCodeAt(0)) : part));
const size = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

describe('startsLikeMp4', () => {
  it.each([
    ['ftyp', bytes(size(32), 'ftypisom', [0, 0, 2, 0])],
    ['a media segment\'s styp', bytes(size(24), 'stypmsdh')],
    ['moov first', bytes(size(4096), 'moov', size(108), 'mvhd')],
    ['mdat first, its size to the file\'s end', bytes(size(0), 'mdat')],
    ['a 64-bit size', bytes(size(1), 'mdat', [0, 0, 0, 1, 0, 0, 0, 0])],
    ['QuickTime\'s wide and free', bytes(size(8), 'wide'), bytes(size(8), 'free')],
    ['QuickTime\'s preview', bytes(size(20), 'pnot')],
  ])('takes %s for an MP4', (name, ...starts) => {
    for (const start of starts) expect(startsLikeMp4(start)).toBe(true);
  });

  it.each([
    ['Matroska', bytes([0x1A, 0x45, 0xDF, 0xA3, 0xA3, 0x42, 0x86, 0x81, 0x01])],
    ['WebM', bytes([0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81, 0x01])],
    ['Ogg', bytes('OggS', [0, 2, 0, 0, 0, 0, 0, 0])],
    ['FLAC', bytes('fLaC', [0, 0, 0, 0x22])],
    ['MP3 with an ID3 tag', bytes('ID3', [4, 0, 0, 0, 0, 0x23, 0x76])],
    ['WAV', bytes('RIFF', [0x24, 0xA3, 0x1B, 0x00], 'WAVE')],
    ['FLV', bytes('FLV', [1, 5, 0, 0, 0, 9])],
    ['MPEG-TS', bytes([0x47, 0x40, 0x00, 0x10, 0x00, 0x00, 0xB0, 0x0D])],
    ['a box too short for its own head', bytes(size(4), 'ftyp')],
  ])('does not take %s for an MP4', (name, start) => {
    expect(startsLikeMp4(start)).toBe(false);
  });

  it('cannot tell from fewer than 8 bytes, and leaves those to mp4box', () => {
    expect(startsLikeMp4(new Uint8Array(0))).toBe(true);
    expect(startsLikeMp4(bytes([0x1A, 0x45, 0xDF, 0xA3]))).toBe(true);
  });

  it('reads the bytes where a view of a larger buffer starts', () => {
    const buffer = bytes([0, 0, 0, 0], [0x1A, 0x45, 0xDF, 0xA3, 0xA3, 0x42, 0x86, 0x81]).buffer;
    expect(startsLikeMp4(new Uint8Array(buffer, 4, 8))).toBe(false);
    const mp4 = bytes([0x1A, 0x45, 0xDF, 0xA3], size(32), 'ftyp').buffer;
    expect(startsLikeMp4(new Uint8Array(mp4, 4, 8))).toBe(true);
  });
});
