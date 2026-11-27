// @ts-check
import {NearPx} from './PreviewSeeks.mjs';

// Thumbnails on the progress bar no closer than this (px): a denser cache shows no other picture.
export const MinSpacingPx = 8;

/** @typedef {{time: number, image: {close: () => void}, bytes: number}} Thumbnail */

/**
 * The seek preview's pictures of keyframes, kept by time within a byte budget.
 *
 * Over budget the picture whose neighbours lie closest goes: the rest stay spread over the video.
 */
export class PreviewThumbnails {
  /** @param {number} budget - Bytes all pictures may take together. */
  constructor(budget) {
    this.budget = budget;
    /** @type {Thumbnail[]} By time. */
    this.list = [];
    this.bytes = 0;
  }

  /**
   * @param {number} time
   * @return {number} The index of the first picture at or after the time.
   */
  indexAt(time) {
    let low = 0;
    let high = this.list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.list[mid].time < time) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  /**
   * @param {number} time
   * @return {?Thumbnail}
   */
  nearest(time) {
    const index = this.indexAt(time);
    const after = this.list[index];
    const before = this.list[index - 1];
    if (!before) return after ?? null;
    if (!after) return before;
    return time - before.time <= after.time - time ? before : after;
  }

  /**
   * @param {number} time
   * @return {number} Seconds from the time to the nearest picture; Infinity with none.
   */
  gap(time) {
    const nearest = this.nearest(time);
    return nearest ? Math.abs(nearest.time - time) : Infinity;
  }

  /**
   * The picture for the pointer's place: the nearest, if it is near enough to belong there (NearPx).
   * @param {number} time
   * @param {(a: number, b: number) => number} pxApart - How far apart two times are on the progress bar.
   * @return {?Thumbnail}
   */
  near(time, pxApart) {
    const nearest = this.nearest(time);
    return nearest && pxApart(nearest.time, time) <= NearPx ? nearest : null;
  }

  /**
   * @param {number} time
   * @param {{close: () => void}} image
   * @param {number} bytes
   * @return {Thumbnail}
   */
  add(time, image, bytes) {
    const index = this.indexAt(time);
    const same = this.list[index];
    /** @type {Thumbnail} */
    const thumbnail = {time, image, bytes};
    if (same && same.time === time) {
      same.image.close();
      this.bytes -= same.bytes;
      this.list[index] = thumbnail;
    } else {
      this.list.splice(index, 0, thumbnail);
    }
    this.bytes += bytes;
    while (this.bytes > this.budget && this.list.length > 1) {
      this.thin();
    }
    return thumbnail;
  }

  /** Drops the picture whose neighbours lie closest together (an end one: its one neighbour). */
  thin() {
    const list = this.list;
    let drop = 0;
    let narrowest = Infinity;
    for (let i = 0; i < list.length; i++) {
      const before = list[i - 1]?.time ?? list[i].time;
      const after = list[i + 1]?.time ?? list[i].time;
      const span = (after - before) * (i === 0 || i === list.length - 1 ? 2 : 1);
      if (span < narrowest) {
        narrowest = span;
        drop = i;
      }
    }
    const [dropped] = list.splice(drop, 1);
    dropped.image.close();
    this.bytes -= dropped.bytes;
  }

  clear() {
    this.list.forEach((thumbnail) => thumbnail.image.close());
    this.list = [];
    this.bytes = 0;
  }
}

/**
 * Seconds between pictures: MinSpacingPx on the bar, or wider where the budget holds fewer pictures than that.
 * @param {{duration: number, width: number, bytesEach: number, budget: number}} bar - The video's length, the
 *   bar's width in px, and the bytes of one picture.
 * @return {number} Seconds; Infinity where the bar cannot be measured.
 */
export function thumbnailSpacing({duration, width, bytesEach, budget}) {
  if (!(duration > 0) || !Number.isFinite(duration) || !(width > 0)) return Infinity;
  const fits = Math.max(1, Math.floor(budget / Math.max(1, bytesEach)));
  return Math.max(MinSpacingPx, width / fits) * duration / width;
}

/**
 * The keyframe to decode next, or none when the pictures are dense enough.
 *
 * The pointer's place first, when a keyframe lies nearer to it than any picture and near enough to show there.
 * Then the keyframe farthest from every picture: the first pictures spread over the whole video, the next fill in.
 * @template {{time: number}} T
 * @param {T[]} candidates - Keyframes of downloaded parts with no picture tried yet.
 * @param {PreviewThumbnails} thumbnails
 * @param {{spacing: number, near: number, pointer: ?number, playhead: number}} at - spacing: seconds between
 *   pictures (thumbnailSpacing); near: the seconds NearPx stands for; pointer: its place on the bar, or null.
 * @return {?T}
 */
export function nextKeyframe(candidates, thumbnails, {spacing, near, pointer, playhead}) {
  if (pointer !== null) {
    const shown = thumbnails.gap(pointer);
    if (shown > spacing / 2) {
      let best = null;
      let bestGap = Math.min(shown, near + 1e-9);
      for (const candidate of candidates) {
        const gap = Math.abs(candidate.time - pointer);
        if (gap < bestGap) {
          best = candidate;
          bestGap = gap;
        }
      }
      if (best) return best;
    }
  }
  let best = null;
  let bestGap = spacing;
  let bestFromPlayhead = Infinity;
  for (const candidate of candidates) {
    const gap = thumbnails.gap(candidate.time);
    const fromPlayhead = Math.abs(candidate.time - playhead);
    if (gap > bestGap || (gap === bestGap && best && fromPlayhead < bestFromPlayhead)) {
      best = candidate;
      bestGap = gap;
      bestFromPlayhead = fromPlayhead;
    }
  }
  return best;
}
