// Builds fragmented MP4 (an init segment and moof/mdat fragments) for the merger's tests,
// with the writer the saves themselves use (MP4Generator), which has every box a fragment
// needs. Its trun is version 1 for video, so composition offsets may be negative, as CMAF
// packagers write them.

import {MP4} from '../../../chrome/player/modules/hls2mp4/MP4Generator.mjs';
import {ParameterSets} from './mpegts.mjs';

/**
 * @param {Uint8Array[]} parts
 * @return {Uint8Array}
 */
function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Builds the generator's box type table, which it otherwise does on its first file. */
function ready() {
  if (!MP4.types) {
    MP4.init();
  }
}

/**
 * A video track description, H.264 with real parameter sets.
 * @param {Object} options
 * @param {number} options.timescale
 * @param {number} [options.id]
 * @return {Object}
 */
export function videoTrack({timescale, id = 1}) {
  return {
    type: 'video',
    id,
    timescale,
    movieTimescale: timescale,
    duration: 0,
    width: 64,
    height: 64,
    pixelRatio: [1, 1],
    sps: [ParameterSets.H264.sps],
    pps: [ParameterSets.H264.pps],
    samples: [],
    chunks: [],
    elst: [],
  };
}

/**
 * The init segment for a track: ftyp, then a moov whose mvex makes it fragmented.
 * @param {Object} track from videoTrack()
 * @return {ArrayBuffer}
 */
export function initSegment(track) {
  ready();
  const moov = MP4.box(MP4.types.moov, MP4.mvhd(track.timescale, 0), MP4.trak({...track}), MP4.mvex([track]));
  return concat([MP4.FTYP, moov]).buffer;
}

/**
 * One fragment: a moof describing the samples, and an mdat with a byte per sample.
 * @param {Object} track from videoTrack()
 * @param {number} sequence the fragment's number
 * @param {number} baseDecodeTime in the track's timescale
 * @param {Array<{duration: number, cts: number, key?: boolean}>} samples cts is the
 *     composition offset, which may be negative
 * @return {Blob}
 */
export function fragment(track, sequence, baseDecodeTime, samples) {
  ready();
  const written = samples.map(({duration, cts, key}) => ({
    duration,
    size: 1,
    cts,
    flags: {
      isLeading: 0,
      isDependedOn: 0,
      hasRedundancy: 0,
      degradPrio: 0,
      paddingValue: 0,
      dependsOn: key ? 2 : 1,
      isNonSync: key ? 0 : 1,
    },
  }));
  const moof = MP4.moof(sequence, baseDecodeTime, {...track, samples: written});
  const mdat = MP4.mdat(new Uint8Array(samples.length).fill(0xab));
  return new Blob([moof, mdat]);
}
