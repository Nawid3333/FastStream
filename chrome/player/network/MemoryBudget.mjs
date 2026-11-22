// @ts-check

export const DEFAULT_BUDGET_BYTES = 1e9;
// Over HIGH of its share a player frees down to LOW; the gap keeps it from flapping.
export const HIGH = 0.9;
export const LOW = 0.75;
export const WATCHED_WEIGHT = 4;
export const KEEP_ON_DISK_WINDOW = {behind: 10, ahead: 60};
export const KEEP_IN_RAM_ONLY_WINDOW = {behind: 5, ahead: 30};
// When the window alone exceeds the share, all but the next seconds may go.
export const KEEP_AT_LEAST = {behind: 0, ahead: 10};
// 0 RAM means straight to disk, not nothing ahead (in a private window it is nothing ahead).
export const DISK_ONLY_ROOM_BYTES = 64e6;

/**
 * @param {number} budget
 * @param {number} weight
 * @param {Array<{ramBytes: number, weight: number}>} peers
 * @return {number}
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
 * @param {boolean} watched
 * @return {number}
 */
export function weightOf(watched) {
  return watched ? WATCHED_WEIGHT : 1;
}

/**
 * @typedef {Object} HeldFragment
 * @property {number} start
 * @property {number} end
 * @property {number} bytes
 */

/**
 * @template {HeldFragment} F
 * @param {F[]} held
 * @param {number} time
 * @param {{behind: number, ahead: number}} keep
 * @param {number} bytes
 * @return {F[]}
 */
export function chooseToRelease(held, time, keep, bytes) {
  if (!(bytes > 0)) return [];
  const first = releaseOutside(held, time, keep, bytes);
  const freed = first.reduce((sum, fragment) => sum + fragment.bytes, 0);
  if (freed >= bytes || (keep.behind <= KEEP_AT_LEAST.behind && keep.ahead <= KEEP_AT_LEAST.ahead)) {
    return first;
  }
  const chosen = new Set(first);
  const rest = releaseOutside(held.filter((fragment) => !chosen.has(fragment)), time, KEEP_AT_LEAST, bytes - freed);
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
  // Not a fragment without times (-1): playback may need it next.
  const behind = held.filter((fragment) => fragment.end >= 0 && fragment.end < time - keep.behind)
      .sort((a, b) => a.end - b.end);
  const ahead = held.filter((fragment) => fragment.start >= 0 && fragment.start > time + keep.ahead)
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
 * @param {number} held
 * @param {number} leaving
 * @param {number} share
 * @param {boolean} wasFull
 * @return {boolean}
 */
export function isFull(held, leaving, share, wasFull) {
  if (held >= share * HIGH) return true;
  if (held - leaving <= share * LOW) return false;
  return wasFull;
}
