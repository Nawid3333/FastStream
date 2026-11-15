// @ts-check
// How long MP4Player's main loop waits before its next round (MP4Player.mainLoop). Pure, so
// it can be tested without the player (which loads mp4box and the MediaSource code).

/** Playing with media ahead: a range that ends starts the next itself. */
export const STEADY_LOOP_MS = 50;
/** Paused or ended: a seek or a play wakes the loop. */
export const PAUSED_LOOP_MS = 250;
/** At once (Firefox makes 1 ms 4). */
export const URGENT_LOOP_MS = 1;
/**
 * How long a start (no first frame yet) keeps the urgent pace after its last progress: the
 * start, an append, the element's first frame data, a seek or a play. Each of those wakes the
 * loop itself; past this, a start that makes no progress - data the element cannot decode, a
 * file it refuses - waits at the steady pace. It woke the page 250 times a second for as long
 * as its tab stayed open (the review of 2026-11-13, "needsInit").
 */
export const INIT_URGENT_MS = 2000;

/**
 * @param {{ended: boolean, paused: boolean, seeking: boolean, readyState: number,
 *   needsInit: boolean, sinceProgress: number}} state - The element's state, whether the
 *   player still waits for its first frame, and the ms since the start's last progress.
 * @return {number} The ms until the loop's next round.
 */
export function loopDelay({ended, paused, seeking, readyState, needsInit, sinceProgress}) {
  if (ended) return PAUSED_LOOP_MS;
  // A start: urgent while it gets somewhere, playing or not; then steady, playing or not (a
  // video set to play that never gets its first frame is out of media for good).
  if (needsInit) return sinceProgress < INIT_URGENT_MS ? URGENT_LOOP_MS : STEADY_LOOP_MS;
  if (seeking || (!paused && readyState < 3)) return URGENT_LOOP_MS;
  return paused ? PAUSED_LOOP_MS : STEADY_LOOP_MS;
}
