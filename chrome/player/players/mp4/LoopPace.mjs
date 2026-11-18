// @ts-check
// How long MP4Player's main loop waits before its next round. Pure, for tests without mp4box.

/** Playing with media ahead: a range that ends starts the next itself. */
export const STEADY_LOOP_MS = 50;
/** Paused or ended: a seek or a play wakes the loop. */
export const PAUSED_LOOP_MS = 250;
/** At once (Firefox makes 1 ms 4). */
export const URGENT_LOOP_MS = 1;
/**
 * How long a start keeps the urgent pace after its last progress; then one that gets nowhere waits steadily.
 */
export const INIT_URGENT_MS = 2000;

/**
 * @param {{ended: boolean, paused: boolean, seeking: boolean, readyState: number,
 *   needsInit: boolean, sinceProgress: number}} state
 * @return {number} Ms.
 */
export function loopDelay({ended, paused, seeking, readyState, needsInit, sinceProgress}) {
  if (ended) return PAUSED_LOOP_MS;
  // A start: urgent while it gets somewhere, then steady (one that never gets its first frame is stuck for good).
  if (needsInit) return sinceProgress < INIT_URGENT_MS ? URGENT_LOOP_MS : STEADY_LOOP_MS;
  if (seeking || (!paused && readyState < 3)) return URGENT_LOOP_MS;
  return paused ? PAUSED_LOOP_MS : STEADY_LOOP_MS;
}
