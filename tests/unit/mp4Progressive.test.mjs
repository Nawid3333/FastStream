import {describe, expect, it, vi} from 'vitest';

// MP4Player gives mp4box a range's pieces while the range downloads (feedPiece): the first frame
// needs the moov and its own bytes, a seek its keyframe's, not the whole megabyte - a range went
// to mp4box only once all of it was in. These run feedPiece on a stand-in player whose mp4box
// records what it was given.

const {default: MP4Player} = await import('../../chrome/player/players/mp4/MP4Player.mjs');
const feedPiece = MP4Player.prototype.feedPiece;
const moovIsAfterMedia = MP4Player.prototype.moovIsAfterMedia;

/**
 * A range's own answer: a 206 and its Content-Range.
 * @param {{rangeStart: number, rangeEnd: number}} frag
 * @param {string} [total] - The file's length, '*' for none.
 * @return {Object}
 */
const answerFor = (frag, total = '5000000') => {
  const contentRange = `bytes ${frag.rangeStart}-${frag.rangeEnd - 1}/${total}`;
  return {status: 206, contentRange, headers: {'content-range': contentRange}};
};
// An MP4's first bytes: a box size and 'ftyp'.
const MP4_START = [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70];

/**
 * @param {{metaData?: boolean}} [state]
 * @return {Object} A stand-in player: its mp4box records each buffer's place and bytes.
 */
function player({metaData = true} = {}) {
  const fed = [];
  return {
    fed,
    fedRanges: new Map(),
    metaData: metaData ? {} : null,
    fileLength: metaData ? 5000000 : 0,
    initializeFragments: vi.fn(),
    mp4box: {appendBuffer: (buffer) => fed.push([buffer.fileStart, Array.from(new Uint8Array(buffer))])},
  };
}
const range = (sn, size = 10) => ({sn, rangeStart: sn * 1000000, rangeEnd: sn * 1000000 + size});
const bytes = (...values) => new Uint8Array(values);
/** Feeds a piece of frag, its own answer with it. */
const feed = (p, frag, chunk, offset, answer = answerFor(frag)) => feedPiece.call(p, frag, chunk, offset, answer);

describe('MP4Player.feedPiece', () => {
  it('gives mp4box each piece at its place in the file, as it comes', () => {
    const p = player();
    const frag = range(2);
    feed(p, frag, bytes(1, 2, 3), 0);
    feed(p, frag, bytes(4, 5), 3);
    expect(p.fed).toEqual([[2000000, [1, 2, 3]], [2000003, [4, 5]]]);
    expect(p.fedRanges.get(frag).bytes).toBe(5);
  });

  it('never gives a byte twice: a retried download starts over', () => {
    const p = player();
    const frag = range(2);
    feed(p, frag, bytes(1, 2, 3), 0);
    feed(p, frag, bytes(1, 2), 0);
    feed(p, frag, bytes(3, 4, 5), 2);
    expect(p.fed).toEqual([[2000000, [1, 2, 3]], [2000003, [4, 5]]]);
  });

  it('stops at a hole, and at the range\'s end: the rest goes when the range is in', () => {
    const p = player();
    const frag = range(2, 6);
    feed(p, frag, bytes(1, 2), 0);
    feed(p, frag, bytes(5, 6), 4);
    feed(p, frag, bytes(3, 4), 2);
    expect(p.fed).toEqual([[2000000, [1, 2]]]);
    expect(p.fedRanges.get(frag)).toMatchObject({bytes: 2, off: true});
    // More than the range (a server's longer answer): only the range's bytes.
    const q = player();
    feed(q, range(1, 3), bytes(1, 2, 3, 4, 5), 0);
    expect(q.fed).toEqual([[1000000, [1, 2, 3]]]);
  });

  it('takes nothing from an answer that is not this range from its start', () => {
    const p = player();
    const frag = range(2);
    // A Content-Range that starts elsewhere would put its bytes at the wrong place (glm's review).
    feed(p, frag, bytes(1, 2, 3), 0, answerFor(range(0)));
    feed(p, frag, bytes(4), 3);
    expect(p.fed).toEqual([]);
    expect(p.fedRanges.get(frag)).toMatchObject({bytes: 0, off: true});
  });

  it('counts a piece fed only once mp4box took it', () => {
    const p = player();
    const frag = range(2);
    p.mp4box.appendBuffer = () => {
      throw new Error('mp4box refused it');
    };
    expect(() => feed(p, frag, bytes(1, 2, 3), 0)).toThrow();
    // Not counted: it goes again with the rest when the range is in.
    expect(p.fedRanges.get(frag).bytes).toBe(0);
  });

  it('takes nothing from a download joined on the way, its start missed', () => {
    const p = player();
    feed(p, range(2), bytes(4, 5), 3);
    expect(p.fed).toEqual([]);
    expect(p.fedRanges.size).toBe(0);
  });

  it('before the moov: only an MP4\'s first range, its length from the answer first', () => {
    const p = player({metaData: false});
    const first = range(0, 100);
    feed(p, first, bytes(...MP4_START, 9), 0);
    // mp4box needs the file's length before it parses the moov (onMetadataParsed).
    expect(p.fileLength).toBe(5000000);
    expect(p.initializeFragments).toHaveBeenCalledTimes(1);
    expect(p.fed).toEqual([[0, [...MP4_START, 9]]]);
    expect(p.fedRanges.get(first).hadMetaData).toBe(false);

    // Another range before the moov (the moov at the file's end): whole when it is in.
    const later = player({metaData: false});
    feed(later, range(3), bytes(...MP4_START), 0);
    // Not an MP4 (a Matroska file served as video/mp4): whole, where the player's checks are.
    const mkv = player({metaData: false});
    feed(mkv, range(0), bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0), 0);
    // No length in the answer (a Content-Range without one).
    const noLength = player({metaData: false});
    feed(noLength, range(0), bytes(...MP4_START), 0, answerFor(range(0), '*'));
    for (const q of [later, mkv, noLength]) {
      expect(q.fed).toEqual([]);
      expect(q.fileLength).toBe(0);
    }
  });
});

describe('a moov in a later piece than the media', () => {
  /**
   * @param {boolean} metaDataAfterFirst - Whether the first piece brings the moov.
   * @return {Object} A stand-in player whose moov comes with the piece the test says.
   */
  const fedTwice = (metaDataAfterFirst) => {
    const stand = player({metaData: false});
    let pieces = 0;
    stand.mp4box.appendBuffer = () => {
      pieces++;
      if (metaDataAfterFirst || pieces === 2) stand.metaData = {};
    };
    const frag = range(0, 16);
    const answer = answerFor(frag);
    feedPiece.call(stand, frag, bytes(...MP4_START), 0, answer);
    feedPiece.call(stand, frag, bytes(...MP4_START), 8, answer);
    return stand.fedRanges.get(frag);
  };

  it('remembers a moov that came with the first piece: nothing before it was parsed without it', () => {
    expect(fedTwice(true).moovInFirstPiece).toBe(true);
  });

  it('remembers one that came later', () => {
    const state = fedTwice(false);
    expect(state.moovInFirstPiece).toBe(false);
    expect(state.bytes).toBe(16);
  });

  it('tells media before the moov from a moov at the start', () => {
    const file = (moovStart, ...mdatStarts) => ({mp4box: {moov: {start: moovStart}, mdats: mdatStarts.map((start) => ({start}))}});
    expect(moovIsAfterMedia.call(file(80680, 36))).toBe(true);
    expect(moovIsAfterMedia.call(file(36, 500000))).toBe(false);
    expect(moovIsAfterMedia.call(file(36))).toBe(false);
    expect(moovIsAfterMedia.call({mp4box: {mdats: []}})).toBe(false);
  });
});
