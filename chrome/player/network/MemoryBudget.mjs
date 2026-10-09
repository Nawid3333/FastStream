// @ts-check

// How much of the RAM budget a player may hold, and what it lets go of first.
//
// Downloaded fragments are kept in RAM (fast: a 1.5 MB piece reads in 0.24 ms from RAM,
// 1.5 ms from OPFS, 5.6 ms from the Cache API, measured in Firefox 157) up to a budget the
// user sets, 2 GB by default, for all FastStream players together: Firefox tells an extension
// nothing of the computer's RAM (no navigator.deviceMemory). A player over its share writes
// what it holds furthest from the playhead to disk (a normal window), or lets it go to be
// downloaded again when needed (a private window, which keeps nothing on disk, as Firefox
// keeps a private window's media in RAM). Behind the playhead goes first: watched footage is
// the least likely to be wanted again.

export const DEFAULT_BUDGET_BYTES = 2e9;
// Over HIGH of its share, a player lets go of fragments until it is down to LOW, and starts
// no downloads ahead until then; the gap keeps it from starting and stopping each second.
export const HIGH = 0.9;
export const LOW = 0.75;
// A player the user watches and that plays weighs this much more than one in a background tab.
export const WATCHED_WEIGHT = 4;
// What is never let go of: around the playhead, what playback needs next.
export const KEEP_ON_DISK_WINDOW = {behind: 10, ahead: 60};
export const KEEP_IN_RAM_ONLY_WINDOW = {behind: 5, ahead: 30};
// When the window alone holds more than the share (a high bitrate, a small budget), all but
// the next seconds may go: a window bigger than the budget let RAM grow without a bound.
export const KEEP_AT_LEAST = {behind: 0, ahead: 10};

/**
 * A player's share of the budget: its weight's part of it, or all that the other players
 * leave free, whichever is more (a lone player may use the whole budget).
 * @param {number} budget - Bytes, for all players.
 * @param {number} weight - This player's.
 * @param {Array<{ramBytes: number, weight: number}>} peers - The others'.
 * @return {number} Bytes.
 */
export function shareOf(budget, weight, peers) {
  let totalWeight = weight;
  let peersBytes = 0;
  for (const peer of peers) {
    totalWeight += peer.weight;
    peersBytes += Math.max(0, peer.ramBytes || 0);
  }
  const fair = budget * weight / totalWeight;
  const free = budget - peersBytes;
  return Math.max(fair, Math.min(budget, free));
}

/**
 * @param {boolean} watched - Seen by the user and playing.
 * @return {number}
 */
export function weightOf(watched) {
  return watched ? WATCHED_WEIGHT : 1;
}

/**
 * @typedef {Object} HeldFragment
 * @property {number} start
 * @property {number} end
 * @property {number} bytes - What it holds in RAM.
 */

/**
 * The fragments to let go of to free a number of bytes: outside the window around the
 * playhead; first those behind it, the oldest first, then those ahead, the furthest first.
 * @template {HeldFragment} F
 * @param {F[]} held - Fragments held in RAM that may be let go of.
 * @param {number} time - The playhead.
 * @param {{behind: number, ahead: number}} keep - The window never let go of.
 * @param {number} bytes - How much to free.
 * @return {F[]}
 */
export function chooseToRelease(held, time, keep, bytes) {
  if (!(bytes > 0)) return [];
  const first = releaseOutside(held, time, keep, bytes);
  const freed = first.reduce((sum, fragment) => sum + fragment.bytes, 0);
  if (freed >= bytes || (keep.behind <= KEEP_AT_LEAST.behind && keep.ahead <= KEEP_AT_LEAST.ahead)) {
    return first;
  }
  const rest = releaseOutside(held.filter((fragment) => !first.includes(fragment)), time, KEEP_AT_LEAST, bytes - freed);
  return [...first, ...rest];
}

/**
 * @template {HeldFragment} F
 * @param {F[]} held
 * @param {number} time
 * @param {{behind: number, ahead: number}} keep
 * @param {number} bytes
 * @return {F[]}
 */
function releaseOutside(held, time, keep, bytes) {
  const behind = held.filter((fragment) => fragment.end < time - keep.behind)
      .sort((a, b) => a.end - b.end);
  const ahead = held.filter((fragment) => fragment.start > time + keep.ahead)
      .sort((a, b) => b.start - a.start);
  /** @type {F[]} */
  const chosen = [];
  let freed = 0;
  for (const fragment of [...behind, ...ahead]) {
    if (freed >= bytes) break;
    chosen.push(fragment);
    freed += fragment.bytes;
  }
  return chosen;
}

/**
 * Whether a player is out of RAM for downloads ahead: from HIGH of its share until it is
 * back down to LOW (what is on its way to disk counts as gone).
 * @param {number} held - Bytes it holds in RAM.
 * @param {number} leaving - Bytes on their way to disk.
 * @param {number} share - Its share of the budget.
 * @param {boolean} wasFull
 * @return {boolean}
 */
export function isFull(held, leaving, share, wasFull) {
  if (held >= share * HIGH) return true;
  if (held - leaving <= share * LOW) return false;
  return wasFull;
}
