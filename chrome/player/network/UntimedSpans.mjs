// @ts-check
// Where a fragment without times (an MP4 range not parsed yet) lies in the video, about.

/** @typedef {{start: number, end: number}} Span */

/**
 * @param {{start: number, end: number}} fragment
 * @return {boolean}
 */
export function isTimed(fragment) {
  return Number.isFinite(fragment.start) && Number.isFinite(fragment.end) && fragment.start >= 0 && fragment.end >= 0;
}

/**
 * @param {Array<{start: number, end: number}|null|undefined>} fragments
 * @return {Map<number, Span>}
 */
export function untimedSpans(fragments) {
  /** @type {Map<number, Span>} */
  const spans = new Map();
  /** @type {number[]} */
  const timed = [];
  for (let i = 0; i < fragments.length; i++) {
    const fragment = fragments[i];
    if (fragment && isTimed(fragment)) timed.push(i);
  }
  if (timed.length < 2) return spans;
  const first = timed[0];
  const last = timed[timed.length - 1];
  const startOf = (/** @type {number} */ i) => /** @type {{start: number}} */ (fragments[i]).start;
  const pace = (startOf(last) - startOf(first)) / (last - first);
  if (!(pace > 0)) return spans;

  let before = -1;
  let next = 0;
  for (let i = 0; i < fragments.length; i++) {
    const fragment = fragments[i];
    while (next < timed.length && timed[next] <= i) {
      before = timed[next];
      next++;
    }
    if (!fragment || before === i) continue;
    let start;
    let length = pace;
    if (before === -1) {
      start = Math.max(0, startOf(first) - (first - i) * pace);
    } else if (next < timed.length) {
      const after = timed[next];
      length = (startOf(after) - startOf(before)) / (after - before);
      start = startOf(before) + (i - before) * length;
    } else {
      start = startOf(before) + (i - before) * pace;
    }
    spans.set(i, {start, end: start + Math.max(0, length)});
  }
  return spans;
}
