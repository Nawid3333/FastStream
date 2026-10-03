import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {StreamTypes, TS_CLOCK, audioUnits, h264AccessUnit, muxSegment, videoUnits} from './helpers/mpegts.mjs';
import {readMp4} from './helpers/mp4boxes.mjs';

// The HLS save (HLS2MP4) on transport streams, through the real hls.js demuxer and remuxer
// (the patched npm build: see vitest.config.mjs), with the file it writes read back box by
// box. The streams are made by helpers/mpegts.mjs with the timestamps each test needs.

vi.mock('../../chrome/player/modules/FSBlob.mjs', () => ({
  FSBlob: class {
    constructor() {
      this.blobs = new Map();
      this.next = 0;
      this.closed = false;
    }
    saveBlob(blob) {
      const id = `blob${this.next++}`;
      this.blobs.set(id, blob);
      return id;
    }
    getBlob(id) {
      return this.blobs.get(id);
    }
    close() {
      this.closed = true;
    }
  },
}));

// What hls.js asks the browser about: Firefox's MSE takes MP3 in MP4, not bare MPEG audio.
globalThis.MediaSource = {isTypeSupported: (type) => type !== 'audio/mpeg'};

const {HLS2MP4} = await import('../../chrome/player/modules/hls2mp4/hls2mp4.mjs');

const FRAME = TS_CLOCK / 25;
const RATE = 48000;
const AUDIO_FRAME = 1024 / RATE;

beforeEach(() => {
  // hls.js and the transmuxer log every step.
  for (const method of ['log', 'debug', 'info', 'warn']) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * One fragment as HLSPlayer.saveVideo hands it over.
 * @param {number} track 0 for the level, 1 for the audio rendition
 * @param {Object} fragment {sn, cc, start}
 * @param {Uint8Array} data the segment
 * @return {Object}
 */
function fragment(track, fragment, data) {
  return {
    track,
    fragment,
    getEntry: async () => ({getDataFromBlob: async () => data.buffer}),
  };
}

/**
 * Saves fragments and reads the file back.
 * @param {Object[]} fragments in the order zipTimedFragments gives them
 * @param {Object} [options]
 * @param {boolean} [options.audioRendition] whether an audio rendition is selected
 * @param {Object} [options.converter] the HLS2MP4 to use
 * @return {Promise<Object>} readMp4() of the file
 */
async function save(fragments, {audioRendition = false, converter = new HLS2MP4()} = {}) {
  const level = {details: {totalduration: 10}, audioCodec: 'mp4a.40.2', videoCodec: 'avc1.42c014'};
  const audioLevel = audioRendition ? {audioCodec: 'mp4a.40.2'} : undefined;
  const blob = await converter.convert(level, null, audioLevel, null, fragments);
  return readMp4(new Uint8Array(await blob.arrayBuffer()));
}

/**
 * @param {number} seconds
 * @return {number} 90 kHz ticks
 */
const ticks = (seconds) => Math.round(seconds * TS_CLOCK);

describe('HLS2MP4: a level with a separate audio rendition', () => {
  // The video is decoded from `videoDts` and shown one frame later (it has B pictures),
  // each segment 2 s; the audio rendition starts where it starts. Each transmuxer used to
  // count its stream from its own first timestamp, so the file lined both up at 0 whatever
  // the stream said.
  const videoSegment = (videoDts) => muxSegment({video: {
    type: StreamTypes.H264,
    units: videoUnits({start: ticks(videoDts) + FRAME, count: 50, frame: FRAME, bFrames: true, picture: h264AccessUnit}),
  }});
  const audioSegment = (audioStart, count = 94) => muxSegment({audio: {
    type: StreamTypes.AAC,
    units: audioUnits({start: ticks(audioStart), count, sampleRate: RATE}),
  }});

  it.each([
    ['before the video', 10, 9.9],
    ['after the video', 10, 10.5],
    ['with the video', 1.4, 1.4],
  ])('keeps audio that starts %s where the stream has it', async (name, videoDts, audioStart) => {
    const firstPicture = videoDts + FRAME / TS_CLOCK;
    const {tracks} = await save([
      fragment(0, {sn: 0, cc: 0, start: 0}, videoSegment(videoDts)),
      fragment(1, {sn: 0, cc: 0, start: 0}, audioSegment(audioStart)),
    ], {audioRendition: true});

    expect(tracks.vide.firstShown - tracks.soun.firstShown).toBeCloseTo(firstPicture - audioStart, 3);
    // The earlier of the two starts the file.
    expect(Math.min(tracks.vide.firstShown, tracks.soun.firstShown)).toBeCloseTo(0, 3);
  });

  it('lines up a partial save whose first audio segment is earlier than its first video segment', async () => {
    // Saved from what was downloaded: video from its fourth segment (6 s in), audio from its
    // third (4 s in). The audio starts 2 s and a frame before the first picture.
    const {tracks} = await save([
      fragment(1, {sn: 2, cc: 0, start: 4}, audioSegment(1.4 + 4)),
      fragment(0, {sn: 3, cc: 0, start: 6}, videoSegment(1.4 + 6)),
      fragment(1, {sn: 3, cc: 0, start: 6}, audioSegment(1.4 + 4 + 94 * AUDIO_FRAME)),
    ], {audioRendition: true});

    expect(tracks.vide.firstShown - tracks.soun.firstShown).toBeCloseTo(2 + FRAME / TS_CLOCK, 3);
  });

  it('keeps the offset when the stream clock wraps between the audio and the video', async () => {
    // The 33-bit clock wraps at 2^33 ticks (26.5 hours). The audio starts 0.2 s before the
    // wrap and the video is decoded from 0.5 s after it.
    const wrap = 2 ** 33 / TS_CLOCK;
    const {tracks} = await save([
      fragment(0, {sn: 0, cc: 0, start: 0}, videoSegment(0.5)),
      fragment(1, {sn: 0, cc: 0, start: 0}, audioSegment(wrap - 0.2)),
    ], {audioRendition: true});

    expect(tracks.vide.firstShown - tracks.soun.firstShown).toBeCloseTo(0.2 + 0.5 + FRAME / TS_CLOCK, 3);
  });

  it('takes the audio from the rendition only, when the level carries audio of its own', async () => {
    // hls.js plays the rendition and drops the level's own audio. The save put both into one
    // audio track, one after the other.
    const level = muxSegment({
      video: {
        type: StreamTypes.H264,
        units: videoUnits({start: ticks(1.4), count: 50, frame: FRAME, picture: h264AccessUnit}),
      },
      audio: {type: StreamTypes.AAC, units: audioUnits({start: ticks(1.4), count: 94, sampleRate: RATE})},
    });
    const {tracks} = await save([
      fragment(0, {sn: 0, cc: 0, start: 0}, level),
      fragment(1, {sn: 0, cc: 0, start: 0}, audioSegment(1.4, 60)),
    ], {audioRendition: true});

    expect(tracks.soun.durations).toHaveLength(60);
  });

  it('still saves the level\'s own audio when the selected rendition has no segments of its own', async () => {
    // An EXT-X-MEDIA rendition without a URI is the audio in the level itself.
    const level = muxSegment({
      video: {
        type: StreamTypes.H264,
        units: videoUnits({start: ticks(1.4), count: 50, frame: FRAME, picture: h264AccessUnit}),
      },
      audio: {type: StreamTypes.AAC, units: audioUnits({start: ticks(1.4), count: 94, sampleRate: RATE})},
    });
    const {tracks} = await save([fragment(0, {sn: 0, cc: 0, start: 0}, level)], {audioRendition: true});

    expect(tracks.soun.durations).toHaveLength(94);
  });
});

describe('HLS2MP4: discontinuities', () => {
  /**
   * A muxed segment of 50 pictures and the audio under them.
   * @param {number} start where its timestamps start, in seconds
   * @return {Uint8Array}
   */
  const muxed = (start) => muxSegment({
    video: {
      type: StreamTypes.H264,
      units: videoUnits({start: ticks(start) + FRAME, count: 50, frame: FRAME, bFrames: true, picture: h264AccessUnit}),
    },
    audio: {type: StreamTypes.AAC, units: audioUnits({start: ticks(start), count: 94, sampleRate: RATE})},
  });

  it('shows every piece when the timestamps start over at an EXT-X-DISCONTINUITY', async () => {
    // Two 2 s pieces (a programme and an ad break, say), both stamped from 1.4 s, as two
    // separately made streams are. The samples go into the file one after the other; the
    // edit list was worked out from the raw timestamps and showed the first 2 s only.
    const {tracks} = await save([
      fragment(0, {sn: 0, cc: 0, start: 0}, muxed(1.4)),
      fragment(0, {sn: 1, cc: 1, start: 2}, muxed(1.4)),
    ]);

    for (const track of [tracks.vide, tracks.soun]) {
      expect(track.mediaEnd).toBeGreaterThan(3.99);
      // Down to the movie's rounding of the two ends.
      expect(track.editEnd - track.firstShown).toBeGreaterThanOrEqual(track.mediaEnd - 1 / track.movieTimescale);
    }
  });

  it('does not stretch the edit over a segment that is missing from a partial save', async () => {
    // Segment 1 was never downloaded: the file has 4 s of media, the stream's clock ran 6 s.
    const {tracks} = await save([
      fragment(0, {sn: 0, cc: 0, start: 0}, muxed(1.4)),
      fragment(0, {sn: 2, cc: 0, start: 4}, muxed(5.4)),
    ]);

    for (const track of [tracks.vide, tracks.soun]) {
      expect(track.editEnd - track.firstShown).toBeCloseTo(track.mediaEnd, 2);
      expect(track.editEnd).toBeLessThan(4.2);
    }
  });
});
