// @ts-check
import {Utils} from '../../utils/Utils.mjs';

/**
 * @typedef {Object} Trak
 * @property {Sample[]|undefined} samples - Filled only as a moof holding the track is parsed.
 * @property {number} samples_duration
 * @property {{mdhd: {timescale: number}}} mdia
 * @property {{elst?: {entries?: Array<{media_time: number}>}}} [edts]
 */

/**
 * @typedef {Object} Sample
 * @property {number} timescale
 * @property {number} cts
 * @property {number} [dts]
 * @property {number} [duration]
 * @property {number} offset
 * @property {boolean} is_sync
 */

// A fragmented file's track has samples only once a moof holding it is parsed: it may have none.

/**
 * A fragmented file's length without a mehd: its longest track, from its first tfdt, less the edit list's start.
 * @param {Trak[]} traks
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
 * How far apart the tracks lie in the file, in seconds: 0 when interleaved, the whole length when all audio follows.
 * @param {Array<Pick<Sample, 'cts'|'offset'|'timescale'>>} a
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
 * A track's keyframes by composition time (a stable sort).
 * @template {Pick<Sample, 'cts'|'is_sync'>} T
 * @param {T[]} samples
 * @return {T[]} A new array.
 */
export function sortKeyframes(samples) {
  return samples.filter((sample) => sample.is_sync).sort((a, b) => a.cts - b.cts);
}

/**
 * sortKeyframes(samples), sorting only what mp4box added since count; later ones go onto sorted itself.
 * @template {Pick<Sample, 'cts'|'is_sync'>} T
 * @param {T[]} sorted - sortKeyframes(samples.slice(0, count)).
 * @param {T[]} samples
 * @param {number} count
 * @return {T[]} sorted itself or a new array.
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
 * The lowest of the tracks' keyframe offsets for a time; tracks without a keyframe yet are left out.
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
 * Where a range starts in time. A binary search: samples must be sorted by offset.
 * @param {Sample[]} samples - Not empty.
 * @param {number} offset
 * @param {number} end
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

/** minTimeIn per range, worked out again only for ranges new samples fall in, while sorted by offset. */
export class RangeTimes {
  constructor() {
    /**
     * @type {WeakMap<Sample[], {count: number, sorted: boolean, byOffset?: Sample[], ranges: Map<object, {start: number, end: number, time: ?number}>}>}
     */
    this.lists = new WeakMap();
  }

  /**
   * @param {Sample[]} samples - mp4box only appends to it; not empty.
   * @param {Array<{rangeStart: number, rangeEnd: number}>} ranges
   * @return {Array<?number>}
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
    // Only the ranges asked for are kept.
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
