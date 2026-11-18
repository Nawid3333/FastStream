// @ts-check

// Whose turn the network is, among the FastStream players open in this browser.

/** A player downloading this many times faster than its video plays leaves room for the next. */
export const JOIN_FACTOR = 4;
/** ...and the next goes on beside it until it is down to this. */
export const LEAVE_FACTOR = 2;
/** A player the user sees keeps this many times as much before it shares its line. */
export const SEEN_FACTOR = 2;

/**
 * @typedef {Object} TurnState
 * @property {string} id
 * @property {boolean} visible
 * @property {boolean} playing
 * @property {boolean} [wants]
 * @property {number} [speed]
 * @property {number} [rate] - 0 when unknown.
 * @property {number} [seen] - 0: never.
 * @property {number} [born]
 * @property {boolean} [shared] - False when its server limits each connection.
 * @property {string} [host]
 */

/**
 * @param {unknown} value
 * @return {number}
 */
function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {TurnState} player
 * @return {number} 2 seen, 1 playing unseen, 0 neither.
 */
export function rankOf(player) {
  if (player.visible) return 2;
  return player.playing ? 1 : 0;
}

/**
 * @param {TurnState} a
 * @param {TurnState} b
 * @return {boolean}
 */
export function goesBefore(a, b) {
  const rankA = rankOf(a);
  const rankB = rankOf(b);
  if (rankA !== rankB) return rankA > rankB;
  const seenA = number(a.seen);
  const seenB = number(b.seen);
  if (seenA !== seenB) return seenA > seenB;
  const bornA = number(a.born);
  const bornB = number(b.born);
  if (bornA !== bornB) return bornA < bornB;
  return String(a.id) < String(b.id);
}

/**
 * @param {TurnState} peer
 * @param {TurnState} own
 * @param {boolean} waiting
 * @return {boolean}
 */
export function leavesRoom(peer, own, waiting) {
  const rate = number(peer.rate);
  const factor = (waiting ? JOIN_FACTOR : LEAVE_FACTOR) * (peer.visible ? SEEN_FACTOR : 1);
  if (rate > 0 && number(peer.speed) >= factor * rate) return true;
  return peer.shared === false && !!peer.host && !!own.host && peer.host !== own.host;
}

/**
 * @param {TurnState} own
 * @param {TurnState[]} peers
 * @param {boolean} waiting
 * @return {boolean}
 */
export function mustWait(own, peers, waiting) {
  if (own.visible) return false;
  for (const peer of peers) {
    if (peer && peer.wants === true && peer.id !== own.id && goesBefore(peer, own) && !leavesRoom(peer, own, waiting)) {
      return true;
    }
  }
  return false;
}
