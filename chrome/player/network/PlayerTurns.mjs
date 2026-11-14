// @ts-check

// Whose turn the network is, among the FastStream players open in this browser.
//
// Every player downloads its whole video ahead, on up to six connections, and until
// 2026-11-14 all of them did so at once unless the watched one was nearly out of video
// (PlayerPeers.shouldYield). On a line they share, the tab the user looks at then got one
// part in as many as there were players (the numbers: docs/notes/player.md, "Players in
// several tabs take turns"; tools/bench-ab.mjs --scenarios tabs measures it). So players in
// background tabs take turns:
//
// - A player the user can see never waits.
// - One in a background tab waits while a player that goes before it still downloads and
//   does not leave room: the visible ones first, then one that plays unseen (music), then the
//   rest, the one seen last first (the tab just left is the likeliest to be come back to),
//   and of those never seen the oldest (tabs opened in a row, in that order).
// - A player leaves room when its line is fast: it downloads at JOIN_FACTOR times the rate
//   its video plays at, or more. The next one then downloads beside it, and goes on until the
//   first falls under LEAVE_FACTOR times (the gap keeps them from starting and stopping). A
//   player the user sees asks twice as much of its line (SEEN_FACTOR) before it shares it. On
//   a fast line everyone downloads at once; on a slow one, one after the other.
// - A player whose server limits each connection (the speed test's verdict) leaves room for
//   players on other hosts: its speed is the server's, not the line's, and another host's
//   connections take nothing from it. On the same host they share Firefox's six connections,
//   so there they still take turns.
//
// Waiting is soft: the downloads already running finish, no new ones ahead are started, and
// what the player's own playback asks for still goes. (Stepping aside for a watched player
// that is short of video is the hard rule, PlayerPeers.shouldYield: that cancels.)
//
// No player can hold the others for good: "still downloads" ends when it has its video, when
// its RAM is full, when the user pauses its downloads, and when nothing has arrived for
// PlayerPeers.STUCK_MS (a dead server). The order is total (rank, seen, born, id), so of the
// players that want the network, the first never waits.

/** A player downloading this many times faster than its video plays leaves room for the next. */
export const JOIN_FACTOR = 4;
/** ...and the next goes on beside it until it is down to this. */
export const LEAVE_FACTOR = 2;
/** A player the user sees keeps this many times as much before it shares its line. */
export const SEEN_FACTOR = 2;

/**
 * What a player tells the others, as far as turns go.
 * @typedef {Object} TurnState
 * @property {string} id
 * @property {boolean} visible - The user can see it.
 * @property {boolean} playing
 * @property {boolean} [wants] - It has video to download ahead, and its downloads get somewhere.
 * @property {number} [speed] - Bytes a second it downloads at.
 * @property {number} [rate] - Bytes a second its video plays at; 0 when unknown.
 * @property {number} [seen] - When the user last saw it (0: never).
 * @property {number} [born] - When it started.
 * @property {boolean} [shared] - Its downloads share one line; false when its server limits
 *   each connection (the speed test's verdict).
 * @property {string} [host] - The host it downloads from.
 */

/**
 * @param {unknown} value
 * @return {number} The number, 0 for anything else.
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
 * Whether a player's turn comes before another's. A total order for players with different
 * ids: of two, exactly one goes before the other.
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
 * Whether a player that downloads leaves room for another to download beside it.
 * @param {TurnState} peer - The one whose turn it is.
 * @param {TurnState} own - The one that would download beside it.
 * @param {boolean} waiting - Whether `own` waits now (it joins at JOIN_FACTOR, and stays
 *   until LEAVE_FACTOR).
 * @return {boolean}
 */
export function leavesRoom(peer, own, waiting) {
  const rate = number(peer.rate);
  const factor = (waiting ? JOIN_FACTOR : LEAVE_FACTOR) * (peer.visible ? SEEN_FACTOR : 1);
  if (rate > 0 && number(peer.speed) >= factor * rate) return true;
  return peer.shared === false && !!peer.host && !!own.host && peer.host !== own.host;
}

/**
 * Whether a player waits for its turn to download ahead.
 * @param {TurnState} own
 * @param {TurnState[]} peers - The other players heard from lately.
 * @param {boolean} waiting - Whether it waits now.
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
