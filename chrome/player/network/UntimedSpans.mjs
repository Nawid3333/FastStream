// @ts-check
// Where a fragment without times lies in the video, about.
//
// A fragmented MP4 is downloaded in ranges of bytes, and a range has its times only once the
// player has parsed it (MP4Player.setFragmentTimes): the ranges downloaded ahead of the parser
// have none (start and end -1). The download window - how far ahead of the playhead a player
// downloads when it does not keep the whole video (a private window, "download all" off, a
// video too large for the disk) - compares times, and took such a range for one long behind
// the playhead once that was past 19 s (-1 < currentTime - bufferBehind): it started no
// download ahead any more, and let go of every range it had downloaded ahead, each tick. The
// file then came on the player's own connection only.
//
// A range without times is placed between its neighbours that have them, or past the last of
// those at the pace the ranges before it had: the file's bytes for a second, so far.

/**
 * @typedef {{start: number, end: number}} Span - Seconds.
 */

/**
 * Whether a fragment has its times.
 * @param {{start: number, end: number}} fragment
 * @return {boolean}
 */
export function isTimed(fragment) {
  return Number.isFinite(fragment.start) && Number.isFinite(fragment.end) && fragment.start >= 0 && fragment.end >= 0;
}

/**
 * Where the fragments of one level without times lie, about.
 * @param {Array<{start: number, end: number}|null|undefined>} fragments - A level's, by sn.
 * @return {Map<number, Span>} By place in the list: only the fragments without times that
 *   could be placed. None when fewer than two of the level have their times, or they tell
 *   no pace (all at the same time).
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
  // Seconds a fragment, over all that is known.
  const pace = (startOf(last) - startOf(first)) / (last - first);
  if (!(pace > 0)) return spans;

  let before = -1; // the last timed one before i
  let next = 0; // timed[next]: the first timed one after i
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
      // Before the first with times: back from it, at the pace.
      start = Math.max(0, startOf(first) - (first - i) * pace);
    } else if (next < timed.length) {
      // Between two with times: evenly between them.
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
