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
 * @property {boolean} is_sync
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
 * A track's keyframes, by composition time (stable: of two at the same time, the one first in
 * the list comes first).
 * @template {Pick<Sample, 'cts'|'is_sync'>} T
 * @param {T[]} samples
 * @return {T[]} A new array.
 */
export function sortKeyframes(samples) {
  return samples.filter((sample) => sample.is_sync).sort((a, b) => a.cts - b.cts);
}

/**
 * A track's keyframes brought up to date with the samples mp4box added to its list since
 * `count` (a fragmented file's, one moof at a time): what sortKeyframes(samples) gives, with
 * only the new ones sorted. Sorting the whole list again for every range took 7.7 ms a range
 * on a 2-hour file (338,000 audio samples, each a keyframe). New keyframes that all come at or
 * after the last one, as they do while a file plays on, go onto the end of `sorted` itself;
 * those of an earlier part (read after a seek back) are merged in, into a new array. mp4box
 * only appends to a track's list (it builds it once, at the moov).
 * @template {Pick<Sample, 'cts'|'is_sync'>} T
 * @param {T[]} sorted - sortKeyframes(samples.slice(0, count)).
 * @param {T[]} samples - The track's samples, `count` of them known before.
 * @param {number} count
 * @return {T[]} `sorted` itself or a new array.
 */
export function addKeyframes(sorted, samples, count) {
  const added = sortKeyframes(samples.slice(count));
  if (!added.length) return sorted;
  if (!sorted.length || sorted[sorted.length - 1].cts <= added[0].cts) {
    for (const sample of added) sorted.push(sample);
    return sorted;
  }
  // Of two at the same time the one from before comes first, as in a sort of the whole list.
  const merged = new Array(sorted.length + added.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < sorted.length && j < added.length) {
    merged[k++] = sorted[i].cts <= added[j].cts ? sorted[i++] : added[j++];
  }
  while (i < sorted.length) merged[k++] = sorted[i++];
  while (j < added.length) merged[k++] = added[j++];
  return merged;
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
