import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ParameterSets, StreamTypes, TS_CLOCK, audioUnits, h264AccessUnit, hevcAccessUnit, mp3Frame, muxSegment,
  videoUnits,
} from './helpers/mpegts.mjs';
import {find, readBoxes, readMp4, readSampleEntry} from './helpers/mp4boxes.mjs';

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

// The transmuxer used to ask MSE what to produce. A browser that takes everything, bare MPEG
// audio included, is the case that broke a save (the MP3 test below).
globalThis.MediaSource = {isTypeSupported: () => true};

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

describe('HLS2MP4: damaged input', () => {
  it('saves a segment with a damaged packet, as hls.js plays it', async () => {
    // hls.js reports a packet that does not start with 0x47 through the logger it was
    // given, and carries on. The transmuxer gave TSDemuxer none, so the report threw a
    // TypeError and the save failed.
    const segment = muxSegment({
      video: {
        type: StreamTypes.H264,
        units: videoUnits({start: ticks(1.4), count: 25, frame: FRAME, picture: h264AccessUnit}),
      },
      audio: {type: StreamTypes.AAC, units: audioUnits({start: ticks(1.4), count: 47, sampleRate: RATE})},
    });
    // The last packet, an audio one (the queue is in time order and the audio ends last).
    segment[segment.length - 188] = 0x00;
    const {tracks} = await save([fragment(0, {sn: 0, cc: 0, start: 0}, segment)]);

    expect(tracks.vide.durations).toHaveLength(25);
    expect(tracks.soun.durations.length).toBeGreaterThan(40);
  });
});

describe('HLS2MP4: sample entries', () => {
  /**
   * @param {Uint8Array} haystack
   * @param {Uint8Array} needle
   * @return {boolean}
   */
  const contains = (haystack, needle) => Buffer.from(haystack).indexOf(Buffer.from(needle)) !== -1;

  it('describes HEVC video as hvc1 with its VPS, SPS and PPS', async () => {
    // hls.js demuxes HEVC from a transport stream; the save wrote it under an avc1 entry
    // with an avcC made of HEVC parameter sets, which nothing decodes.
    const segment = muxSegment({
      video: {
        type: StreamTypes.HEVC,
        units: videoUnits({start: ticks(1.4), count: 25, frame: FRAME, picture: hevcAccessUnit}),
      },
      audio: {type: StreamTypes.AAC, units: audioUnits({start: ticks(1.4), count: 47, sampleRate: RATE})},
    });
    const {tracks} = await save([fragment(0, {sn: 0, cc: 0, start: 0}, segment)]);

    const {type, entry} = readSampleEntry(find(tracks.vide.trak.children, 'mdia/minf/stbl/stsd'));
    expect(type).toBe('hvc1');
    // The sample entry's 78 bytes, then its boxes.
    const hvcC = find(readBoxes(entry, 86), 'hvcC');
    expect(hvcC).toBeDefined();
    const config = new Uint8Array(hvcC.body.buffer, hvcC.body.byteOffset, hvcC.body.byteLength);
    expect(config[0]).toBe(1);
    // Four-byte NAL lengths, as the samples are written.
    expect(config[21] & 3).toBe(3);
    for (const parameterSet of [ParameterSets.HEVC.vps, ParameterSets.HEVC.sps, ParameterSets.HEVC.pps]) {
      expect(contains(config, parameterSet)).toBe(true);
    }
    expect(tracks.vide.durations).toHaveLength(25);
  });

  it('writes MP3 audio as MP3 in MP4, whatever MSE in the browser takes', async () => {
    // hls.js remuxes MP3 into bare MPEG audio when the browser's MSE takes 'audio/mpeg'.
    // The transmuxer asked the browser, so in one that does the save got audio with no
    // mdat around it and an entry that is not MP3's: the file's boxes did not add up.
    const frames = Array.from({length: 40}, (_, i) => ({
      pts: ticks(1.4) + Math.round(i * 1152 * TS_CLOCK / 44100),
      data: mp3Frame(),
    }));
    const segment = muxSegment({
      video: {
        type: StreamTypes.H264,
        units: videoUnits({start: ticks(1.4), count: 25, frame: FRAME, picture: h264AccessUnit}),
      },
      audio: {type: StreamTypes.MP3, units: frames},
    });
    const {boxes, tracks} = await save([fragment(0, {sn: 0, cc: 0, start: 0}, segment)]);

    expect(readSampleEntry(find(tracks.soun.trak.children, 'mdia/minf/stbl/stsd')).type).toBe('.mp3');
    expect(tracks.soun.durations).toHaveLength(40);
    expect(tracks.soun.timescale).toBe(44100);
    // Each sample where the chunk table says: the first audio chunk starts with a frame.
    const stco = find(tracks.soun.trak.children, 'mdia/minf/stbl/stco').body;
    const file = new Uint8Array(boxes.at(-1).body.buffer);
    expect([...file.subarray(stco.getUint32(8), stco.getUint32(8) + 4)]).toEqual([0xff, 0xfb, 0x90, 0x44]);
  });

  it('still describes H.264 video as avc1', async () => {
    const segment = muxSegment({video: {
      type: StreamTypes.H264,
      units: videoUnits({start: ticks(1.4), count: 25, frame: FRAME, picture: h264AccessUnit}),
    }});
    const {tracks} = await save([fragment(0, {sn: 0, cc: 0, start: 0}, segment)]);

    const {type, entry} = readSampleEntry(find(tracks.vide.trak.children, 'mdia/minf/stbl/stsd'));
    expect(type).toBe('avc1');
    expect(find(readBoxes(entry, 86), 'avcC')).toBeDefined();
  });
});
