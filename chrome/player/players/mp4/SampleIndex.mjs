// @ts-check
import {Utils} from '../../utils/Utils.mjs';

/**
 * mp4box's moov.trak, as far as this file reads it.
 * @typedef {Object} Trak
 * @property {Sample[]|undefined} samples - Filled only as a moof holding the track is parsed.
 * @property {number} samples_duration
 * @property {{mdhd: {timescale: number}}} mdia
 * @property {{elst?: {entries?: Array<{media_time: number}>}}} [edts]
 */

/**
 * mp4box's sample, as far as this file reads it.
 * @typedef {Object} Sample
 * @property {number} timescale
 * @property {number} cts
 * @property {number} [dts]
 * @property {number} [duration]
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
 * longest track. A track without samples yet counts for nothing. The samples' summed lengths
 * leave out where the first moof starts (its tfdt): a file cut from a longer recording starts
 * at 10 s and plays to 12 s, and the sum said 2. The last sample's end counts too, less the
 * edit list's start, which Firefox's demuxer takes off the times as well.
 * @param {Trak[]} traks - mp4box's moov.traks.
 * @return {number} Seconds; 0 while no track has samples.
 */
export function sampledDuration(traks) {
  return traks.reduce((duration, trak) => {
    const samples = trak.samples;
    if (!samples?.length) return duration;
    const last = samples[samples.length - 1];
    const start = trak.edts?.elst?.entries?.find((entry) => entry.media_time >= 0)?.media_time ?? 0;
    const end = Math.max(trak.samples_duration, (last.dts ?? 0) + (last.duration ?? 0) - start);
    return Math.max(duration, end / trak.mdia.mdhd.timescale);
  }, 0);
}

/**
 * How far one track is, in seconds, where the other's first sample lies in the file: 0 for a
 * file that interleaves its tracks (a second or less between them in most). A file that stores
 * all its audio after all its video says its whole length. The player's ranges take their
 * times from the video, and it reads no further than maxBufferLength (5 s at the least) past
 * the playhead: the audio of the first seconds was never read, and nothing played (Codex
 * review, 2026-11-17).
 * @param {Array<Pick<Sample, 'cts'|'offset'|'timescale'>>} a - A track's samples, in decode order.
 * @param {Array<Pick<Sample, 'cts'|'offset'|'timescale'>>} b
 * @return {number} Seconds; 0 if either has no samples.
 */
export function apartBy(a, b) {
  if (!a.length || !b.length) return 0;
  /** @type {(samples: Array<Pick<Sample, 'cts'|'offset'|'timescale'>>, offset: number) => number} */
  const reached = (samples, offset) => samples.reduce((time, sample) =>
    sample.offset < offset ? Math.max(time, sample.cts / sample.timescale) : time, 0);
  return Math.max(reached(a, b[0].offset), reached(b, a[0].offset));
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

/**
 * The earliest composition time of the samples whose byte offsets lie in a range, its end
 * included: where a range of the file starts in time (MP4Player.setFragmentTimes). Finds the
 * range's first sample by a binary search, so it reads `samples` as sorted by offset.
 * @param {Sample[]} samples - One track's samples; not empty.
 * @param {number} offset - The range's first byte.
 * @param {number} end - The range's end.
 * @return {?number} Seconds; null when no sample lies in the range.
 */
export function minTimeIn(samples, offset, end) {
  let index = Utils.binarySearch(samples, offset, /** @param {number} offset @param {Sample} sample */ (offset, sample) => {
    return offset - sample.offset;
  });

  if (index < 0) {
    index = Math.max(-1 - index, 0);
  }

  let minTime = Infinity;
  for (let i = index; i < samples.length; i++) {
    if (samples[i].offset > end) {
      break;
    }
    minTime = Math.min(minTime, samples[i].cts);
  }

  if (minTime !== Infinity) {
    return minTime / samples[0].timescale;
  } else {
    return null;
  }
}

/**
 * What minTimeIn gives for each range of a file, kept per range and worked out again only for
 * the ranges new samples fall in. A fragmented file's samples come one moof at a time, and
 * setFragmentTimes worked out every range's time from every sample again at each one: 10 ms a
 * call on a 2-hour file, once for each megabyte read.
 *
 * Kept only while the list stays sorted by offset, which minTimeIn's search takes it to be:
 * then a range's time changes only when a sample in it comes. A list that gets an earlier
 * part after a later one (a seek back, parsed after the part played) is worked out whole each
 * time from then on, as before, so the times are always what minTimeIn gives.
 */
export class RangeTimes {
  constructor() {
    /**
     * Per sample list: how many samples were seen, whether they are sorted by offset, and each
     * range's time with the bounds it was worked out for.
     * @type {WeakMap<Sample[], {count: number, sorted: boolean, byOffset?: Sample[], ranges: Map<object, {start: number, end: number, time: ?number}>}>}
     */
    this.lists = new WeakMap();
  }

  /**
   * @param {Sample[]} samples - One track's samples (mp4box only appends to it); not empty.
   * @param {Array<{rangeStart: number, rangeEnd: number}>} ranges
   * @return {Array<?number>} minTimeIn(samples, range.rangeStart, range.rangeEnd) for each.
   */
  times(samples, ranges) {
    let list = this.lists.get(samples);
    if (!list) {
      list = {count: 0, sorted: true, ranges: new Map()};
      this.lists.set(samples, list);
    }
    if (samples.length !== list.count) {
      // A shorter list is no longer the one the times were made from.
      if (samples.length < list.count) {
        list.sorted = false;
      }
      let low = Infinity;
      let high = -Infinity;
      for (let i = list.count; i < samples.length && list.sorted; i++) {
        const offset = samples[i].offset;
        if (i > 0 && !(offset > samples[i - 1].offset)) {
          list.sorted = false;
        }
        low = Math.min(low, offset);
        high = Math.max(high, offset);
      }
      list.count = samples.length;
      if (!list.sorted) {
        list.ranges.clear();
      } else {
        // Every kept range the new samples fall in, the ones not asked for this time too.
        for (const [range, kept] of list.ranges) {
          if (!(high < kept.start || low > kept.end)) {
            list.ranges.delete(range);
          }
        }
      }
    }
    if (!list.sorted) {
      // minTimeIn searches by offset: a copy sorted by it, made again when samples come.
      if (list.byOffset?.length !== samples.length) {
        list.byOffset = samples.slice().sort((a, b) => a.offset - b.offset);
      }
      const byOffset = list.byOffset;
      return ranges.map((range) => minTimeIn(byOffset, range.rangeStart, range.rangeEnd));
    }
    // Only the ranges asked for are kept: one the player dropped (the file's end found) is not
    // held on to, and one asked for again later is worked out again.
    const kept = list.ranges;
    list.ranges = new Map();
    return ranges.map((range) => {
      let entry = kept.get(range);
      if (!entry || entry.start !== range.rangeStart || entry.end !== range.rangeEnd) {
        entry = {start: range.rangeStart, end: range.rangeEnd, time: minTimeIn(samples, range.rangeStart, range.rangeEnd)};
      }
      list.ranges.set(range, entry);
      return entry.time;
    });
  }
}
