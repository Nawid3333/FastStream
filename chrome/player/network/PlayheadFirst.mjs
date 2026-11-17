// @ts-check

// What a player downloads first when it is short of video: the next seconds, and little else.
//
// A player downloads ahead on up to six connections at once, and parallel downloads share the
// line: the fragment playback needs next arrived no sooner than the two after it (measured on
// MP4 with background players: a 3 s stall right after starting). Apple advises against
// fetching successive segments in parallel for this reason ("later segments will delay
// earlier segments"), and hls.js and dash.js load one segment per track at a time; RX-Player
// cancels downloads far ahead when one near the playhead is urgent. So while a player has less
// than SHORT_S ahead, it runs at most URGENT_PARALLEL downloads, only within KEEP_AHEAD_S, and
// cancels what runs outside that window; from HEALTHY_S on, it downloads ahead in parallel as
// before. The gap between the two keeps it from switching back and forth.

export const SHORT_S = 10;
export const HEALTHY_S = 20;
export const URGENT_PARALLEL = 2;
export const KEEP_AHEAD_S = 30;
export const KEEP_BEHIND_S = 5;

// DownloadStatus.DOWNLOAD_INITIATED, without importing the enum into a pure module's tests.
const INITIATED = 2;

/**
 * Whether a player should download only its next seconds now.
 * @param {number} ahead - Seconds of video ahead of the playhead (BufferAhead).
 * @param {boolean} wasConcentrating - What it did until now.
 * @return {boolean}
 */
export function shouldConcentrate(ahead, wasConcentrating) {
  if (ahead < SHORT_S) return true;
  if (ahead >= HEALTHY_S) return false;
  return wasConcentrating;
}

/**
 * The fragments being downloaded that lie outside a window around the playhead, with known
 * times (a fragmented MP4's fragments have none until parsed: they stay).
 * @template {{start: number, end: number, status: number}} F
 * @param {Array<F|undefined|null>|undefined|null} fragments
 * @param {number} time
 * @param {number} behind - Seconds kept before the playhead.
 * @param {number} ahead - Seconds kept after it.
 * @return {F[]}
 */
export function downloadingOutside(fragments, time, behind, ahead) {
  if (!fragments || !Number.isFinite(time)) return [];
  /** @type {F[]} */
  const outside = [];
  for (const fragment of fragments) {
    // Known means not negative: a fragment keeps -1 until its times are parsed, and -1 is
    // finite - the first fragment of an MP4 resumed later in read as behind the playhead.
    if (fragment && fragment.status === INITIATED &&
        fragment.start >= 0 && fragment.end >= 0 &&
        (fragment.end < time - behind || fragment.start > time + ahead)) {
      outside.push(fragment);
    }
  }
  return outside;
}

/**
 * The downloads to cancel while a seek waits for the fragments the playhead is in, on a line
 * the downloads share: every running one of the given tracks that does not hold the playhead.
 * Inside the new place's window they were spared (downloadingOutside with the window), and on a
 * 3 Mbit/s line the next fragment, started before the seek, kept half the line from the seek's
 * own: an MP4 seek 3.6 -> 4.6 s. One a save or the analyzer holds (canFree false)
 * is theirs to finish. The caller cancels through DownloadManager.cancelIfCheap, which leaves
 * playback's own requests.
 * @template {{start: number, end: number, status: number, canFree: () => boolean}} F
 * @param {Array<Array<F|undefined|null>|undefined|null>} tracks - Each track's fragments.
 * @param {number} time - The playhead.
 * @return {F[]}
 */
export function besidePlayhead(tracks, time) {
  return tracks.flatMap((fragments) => downloadingOutside(fragments, time, 0, 0.1))
      .filter((fragment) => fragment.canFree());
}
