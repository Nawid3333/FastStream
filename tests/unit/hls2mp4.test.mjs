import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ParameterSets, StreamTypes, TS_CLOCK, ac3Frame, audioUnits, h264AccessUnit, hevcAccessUnit, mp3Frame,
  muxSegment, videoUnits,
} from './helpers/mpegts.mjs';
import {find, readBoxes, readMp4, readSampleEntry} from './helpers/mp4boxes.mjs';

// The HLS save (HLS2MP4) on transport streams, through the real hls.js demuxer and remuxer
// (the patched npm build: see vitest.config.mjs), with the file it writes read back box by
// box. The streams are made by helpers/mpegts.mjs with the timestamps each test needs.

// Every blob store made, to see which were closed.
const stores = [];

vi.mock('../../chrome/player/modules/FSBlob.mjs', () => ({
  FSBlob: class {
    constructor() {
      stores.push(this);
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

  it('keeps the time of a segment that is missing from a partial save, as the DASH save does', async () => {
    // Segment 1 was never downloaded. The samples after the hole were written straight after
    // the ones before it: a 4 s file whose third second was the stream's fifth. The last
    // sample before the hole now lasts over it (#224).
    const {tracks} = await save([
      fragment(0, {sn: 0, cc: 0, start: 0}, muxed(1.4)),
      fragment(0, {sn: 2, cc: 0, start: 4}, muxed(5.4)),
    ]);

    expect(decodedAt(tracks.vide, 50)).toBeCloseTo(4, 3);
    expect(decodedAt(tracks.soun, 94)).toBeCloseTo(4, 3);
    for (const track of [tracks.vide, tracks.soun]) {
      expect(track.editEnd - track.firstShown).toBeCloseTo(track.mediaEnd, 2);
      expect(track.mediaEnd).toBeCloseTo(6, 1);
    }
  });

  it('keeps the audio rendition in step with the video when only the video has a hole', async () => {
    // The level's segment 1 is missing, the audio rendition has all three. The video after
    // the hole came 2 s early against the audio, to the end of the file.
    const video = (start) => muxSegment({video: {
      type: StreamTypes.H264,
      units: videoUnits({start: ticks(start), count: 50, frame: FRAME, picture: h264AccessUnit}),
    }});
    const audio = (start) => muxSegment({audio: {
      type: StreamTypes.AAC,
      units: audioUnits({start: ticks(start), count: 94, sampleRate: RATE}),
    }});
    const audioLength = 94 * AUDIO_FRAME;
    const {tracks} = await save([
      fragment(0, {sn: 0, cc: 0, start: 0}, video(1.4)),
      fragment(1, {sn: 0, cc: 0, start: 0}, audio(1.4)),
      fragment(1, {sn: 1, cc: 0, start: 2}, audio(1.4 + audioLength)),
      fragment(0, {sn: 2, cc: 0, start: 4}, video(5.4)),
      fragment(1, {sn: 2, cc: 0, start: 4}, audio(1.4 + 2 * audioLength)),
    ], {audioRendition: true});

    // The first picture after the hole is shown 4 s after the first, where the stream has it,
    // and the audio frame under it plays then too.
    expect(tracks.vide.firstShown + decodedAt(tracks.vide, 50)).toBeCloseTo(4, 3);
    expect(tracks.soun.firstShown + decodedAt(tracks.soun, 188)).toBeCloseTo(2 * audioLength, 3);

    // And the other way round: the rendition's segment 1 is missing, the level has all three.
    const audioHole = await save([
      fragment(0, {sn: 0, cc: 0, start: 0}, video(1.4)),
      fragment(1, {sn: 0, cc: 0, start: 0}, audio(1.4)),
      fragment(0, {sn: 1, cc: 0, start: 2}, video(3.4)),
      fragment(0, {sn: 2, cc: 0, start: 4}, video(5.4)),
      fragment(1, {sn: 2, cc: 0, start: 4}, audio(1.4 + 2 * audioLength)),
    ], {audioRendition: true});
    expect(audioHole.tracks.vide.firstShown + decodedAt(audioHole.tracks.vide, 100)).toBeCloseTo(4, 3);
    expect(audioHole.tracks.soun.firstShown + decodedAt(audioHole.tracks.soun, 94)).toBeCloseTo(2 * audioLength, 3);
  });

  it('does not pad across an EXT-X-DISCONTINUITY, where the clock starts over', async () => {
    // A segment missing just before an ad break: the break's timestamps say nothing about
    // how long the hole was.
    const {tracks} = await save([
      fragment(0, {sn: 0, cc: 0, start: 0}, muxed(1.4)),
      fragment(0, {sn: 2, cc: 1, start: 4}, muxed(9.4)),
    ]);

    expect(decodedAt(tracks.vide, 50)).toBeCloseTo(2, 3);
    expect(tracks.vide.mediaEnd).toBeLessThan(4.2);
  });

  it('pads nothing when a fragment starts before the one before it ended', async () => {
    // Fragments that overlap by a frame: the samples stay as they are.
    const {tracks} = await save([
      fragment(0, {sn: 0, cc: 0, start: 0}, muxed(1.4)),
      fragment(0, {sn: 2, cc: 0, start: 4}, muxed(3.36)),
    ]);

    expect(decodedAt(tracks.vide, 50)).toBeCloseTo(2, 3);
  });
});

/**
 * @param {Object} track describeTrack() of a track
 * @param {number} index a sample
 * @return {number} when the sample is decoded, in seconds from the track's first sample
 */
function decodedAt(track, index) {
  return track.durations.slice(0, index).reduce((sum, duration) => sum + duration, 0) / track.timescale;
}

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

describe('HLS2MP4: the blob store of a save', () => {
  it('keeps the store the saved file is made of until release()', async () => {
    // It closed two minutes after the save, and a closed OPFS session is deleted by the
    // next player or save that starts. SaveManager releases it once nothing reads the file.
    vi.useFakeTimers();
    try {
      const segment = muxSegment({video: {
        type: StreamTypes.H264,
        units: videoUnits({start: ticks(1.4), count: 25, frame: FRAME, picture: h264AccessUnit}),
      }});
      const converter = new HLS2MP4();
      await save([fragment(0, {sn: 0, cc: 0, start: 0}, segment)], {converter});
      const store = stores.at(-1);

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(store.closed).toBe(false);
      converter.release();
      expect(store.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('HLS2MP4: a save that does not finish', () => {
  const segment = () => muxSegment({video: {
    type: StreamTypes.H264,
    units: videoUnits({start: ticks(1.4), count: 25, frame: FRAME, picture: h264AccessUnit}),
  }});

  it('closes its blob store when a fragment fails', async () => {
    // The fragments it kept (on disk, with OPFS) and the store's worker stayed until the tab
    // closed; only a cancel closed the store.
    const failed = {
      track: 0,
      fragment: {sn: 1, cc: 0, start: 1},
      getEntry: async () => {
        throw new Error('Bad status code: 404');
      },
    };
    const converter = new HLS2MP4();
    await expect(save([fragment(0, {sn: 0, cc: 0, start: 0}, segment()), failed], {converter}))
        .rejects.toThrow('Bad status code: 404');

    expect(stores.at(-1).closed).toBe(true);
  });

  it('closes its blob store when it is cancelled', async () => {
    let cancel;
    const converter = new HLS2MP4((fn) => {
      cancel = fn;
    });
    const cancelling = {
      track: 0,
      fragment: {sn: 1, cc: 0, start: 1},
      getEntry: async () => {
        cancel();
        return {getDataFromBlob: async () => segment().buffer};
      },
    };
    await expect(save([cancelling, fragment(0, {sn: 2, cc: 0, start: 2}, segment())], {converter}))
        .rejects.toThrow('Cancelled');

    expect(stores.at(-1).closed).toBe(true);
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

  /**
   * Saves a second of H.264 with AC-3 audio and reads the audio track back.
   * @param {Object} header the AC-3 frame header, as ac3Frame() takes it
   * @param {number} sampleRate what fscod says
   * @return {Promise<Object>} the audio track and its sample entry's bytes
   */
  const saveAc3 = async (header, sampleRate) => {
    const frames = Array.from({length: 20}, (_, i) => ({
      pts: ticks(1.4) + Math.round(i * 1536 * TS_CLOCK / sampleRate),
      data: ac3Frame(header),
    }));
    const segment = muxSegment({
      video: {
        type: StreamTypes.H264,
        units: videoUnits({start: ticks(1.4), count: 25, frame: FRAME, picture: h264AccessUnit}),
      },
      audio: {type: StreamTypes.AC3, units: frames},
    });
    const {tracks} = await save([fragment(0, {sn: 0, cc: 0, start: 0}, segment)]);
    expect(tracks.soun).toBeDefined();
    const {type, entry} = readSampleEntry(find(tracks.soun.trak.children, 'mdia/minf/stbl/stsd'));
    return {track: tracks.soun, type, entry};
  };

  it.each([
    // dac3 is fscod(2) bsid(5) bsmod(3) acmod(3) lfeon(1) bit_rate_code(5) reserved(5), where
    // bit_rate_code is frmsizecod >> 1 (ETSI TS 102 366, F.4).
    // 0b00 01000 000 111 1 01010 00000
    ['5.1 at 48 kHz, 192 kbit/s', {fscod: 0, frmsizecod: 20, bsid: 8, bsmod: 0, acmod: 7, lfeon: 1}, 48000, [0x10, 0x3d, 0x40]],
    // 0b01 00110 001 010 0 01110 00000
    ['stereo at 44.1 kHz, 384 kbit/s', {fscod: 1, frmsizecod: 28, bsid: 6, bsmod: 1, acmod: 2, lfeon: 0}, 44100, [0x4c, 0x51, 0xc0]],
  ])('writes the dac3 of an AC-3 frame header (%s)', async (name, header, sampleRate, dac3) => {
    // hls.js left AC-3 out of a transport stream unless told the output takes it, so the
    // save had no sound; with it and no ac-3 entry, the audio was written as mp4a.
    const {type, entry} = await saveAc3(header, sampleRate);

    expect(type).toBe('ac-3');
    // The audio sample entry's 28 bytes, then its boxes.
    const box = find(readBoxes(entry, 36), 'dac3');
    expect([...new Uint8Array(box.body.buffer, box.body.byteOffset, box.body.byteLength)]).toEqual(dac3);
  });

  it('writes AC-3 audio as an ac-3 track: its channels, its rate, a sample per 1536', async () => {
    const {track, entry} = await saveAc3({fscod: 0, frmsizecod: 20, bsid: 8, bsmod: 0, acmod: 7, lfeon: 1}, 48000);
    const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);

    // channelcount, then the sample rate as 16.16 fixed point.
    expect(view.getUint16(24)).toBe(6);
    expect(view.getUint16(32)).toBe(48000);
    expect(track.timescale).toBe(48000);
    expect(track.durations).toEqual(new Array(20).fill(1536));
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
