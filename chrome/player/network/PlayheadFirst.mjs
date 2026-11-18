// @ts-check

// Short of video, a player downloads only its next seconds: parallel downloads share the line.

export const SHORT_S = 10;
export const HEALTHY_S = 20;
export const URGENT_PARALLEL = 2;
export const KEEP_AHEAD_S = 30;
export const KEEP_BEHIND_S = 5;

// DownloadStatus.DOWNLOAD_INITIATED, not imported: a pure module.
const INITIATED = 2;

/**
 * @param {number} ahead
 * @param {boolean} wasConcentrating
 * @return {boolean}
 */
export function shouldConcentrate(ahead, wasConcentrating) {
  if (ahead < SHORT_S) return true;
  if (ahead >= HEALTHY_S) return false;
  return wasConcentrating;
}

/**
 * @template {{start: number, end: number, status: number}} F
 * @param {Array<F|undefined|null>|undefined|null} fragments
 * @param {number} time
 * @param {number} behind
 * @param {number} ahead
 * @return {F[]}
 */
export function downloadingOutside(fragments, time, behind, ahead) {
  if (!fragments || !Number.isFinite(time)) return [];
  /** @type {F[]} */
  const outside = [];
  for (const fragment of fragments) {
    // -1 (times not parsed yet) is finite, so known means not negative.
    if (fragment && fragment.status === INITIATED &&
        fragment.start >= 0 && fragment.end >= 0 &&
        (fragment.end < time - behind || fragment.start > time + ahead)) {
      outside.push(fragment);
    }
  }
  return outside;
}

/**
 * Running downloads that do not hold the playhead: a seek cancels them to have the line.
 * @template {{start: number, end: number, status: number, canFree: () => boolean}} F
 * @param {Array<Array<F|undefined|null>|undefined|null>} tracks
 * @param {number} time
 * @return {F[]}
 */
export function besidePlayhead(tracks, time) {
  return tracks.flatMap((fragments) => downloadingOutside(fragments, time, 0, 0.1))
      .filter((fragment) => fragment.canFree());
}
