// @ts-check
import {Utils} from '../../utils/Utils.mjs';

/**
 * mp4box's moov.trak, as far as this file reads it.
 * @typedef {Object} Trak
 * @property {Sample[]|undefined} samples - Filled only as a moof holding the track is parsed.
 * @property {number} samples_duration
 * @property {{mdhd: {timescale: number}}} mdia
 */

/**
 * mp4box's sample, as far as this file reads it.
 * @typedef {Object} Sample
 * @property {number} timescale
 * @property {number} cts
 * @property {number} offset
 */

// MP4Player's arithmetic on mp4box's sample lists, kept apart from MP4Player so that unit
// tests can run it (MP4Player imports the vendored mp4box, which unit tests do not have).
//
// mp4box fills a fragmented file's track with samples only as a moof holding that track is
// parsed. A track can therefore have none at all for a while: a subtitle or text track, a
// file whose moofs hold one track each and whose first video moof lies beyond the first
// range read, a moof cut in two by the end of a range. Both calculations below read
// samples[0] of every track, and a track with none threw: the duration on parsing the
// metadata (the player never started, and said nothing), the keyframe on each turn of the
// main loop (which then stopped for good, again with nothing said).

/**
 * How long a fragmented file without a mehd box is, as far as its samples are known: its
 * longest track. A track without samples yet counts for nothing.
 * @param {Trak[]} traks - mp4box's moov.traks.
 * @return {number} Seconds; 0 while no track has samples.
 */
export function sampledDuration(traks) {
  return traks.reduce((duration, trak) => {
    if (!trak.samples?.length) return duration;
    return Math.max(duration, trak.samples_duration / trak.mdia.mdhd.timescale);
  }, 0);
}

/**
 * The byte offset of the last keyframe at or before a time, in one track's keyframes.
 * @param {Sample[]} samples - The keyframes, sorted by time; not empty.
 * @param {number} time - Seconds.
 * @return {number}
 */
export function keyframeOffsetIn(samples, time) {
  let index = Utils.binarySearch(samples, time * samples[0].timescale, /** @type {(time: number, sample: Sample) => number} */ ((time, sample) => {
    return time - sample.cts;
  }));

  if (index < 0) {
    index = Math.max(-1 - index - 1, 0);
  }

  return samples[index].offset;
}

/**
 * Where to read from to play a time: the lowest of the tracks' keyframe offsets for it.
 * Tracks without a keyframe yet are left out.
 * @param {Sample[][]} sampleLists - Each track's keyframes, sorted by time.
 * @param {number} time - Seconds.
 * @return {?number} Null while no track has a keyframe.
 */
export function keyframeOffset(sampleLists, time) {
  /** @type {number|null} */
  let offset = null;
  for (const samples of sampleLists) {
    if (!samples.length) continue;
    const found = keyframeOffsetIn(samples, time);
    if (offset === null || found < offset) {
      offset = found;
    }
  }
  return offset;
}
