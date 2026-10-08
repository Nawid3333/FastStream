// @ts-check

// How far ahead of the playhead a player has its video, without a hole: what decides whether
// it is short of it (PlayerPeers) and how much of its stored video it may let go of.

/**
 * @typedef {Object} TimedFragment
 * @property {number} start - Seconds.
 * @property {number} end - Seconds.
 * @property {number} status - DownloadStatus.
 */

// DownloadStatus.DOWNLOAD_COMPLETE, without importing the enum into a pure module's tests.
const COMPLETE = 3;

/**
 * Seconds downloaded without a hole from a time on, in one track's fragments (in order,
 * holes allowed). A fragment that is not downloaded, or a gap between two, ends the count:
 * playback cannot get past it.
 * @param {Array<TimedFragment|undefined|null>|undefined|null} fragments
 * @param {number} time
 * @return {number}
 */
export function downloadedAhead(fragments, time) {
  if (!fragments || !Number.isFinite(time)) return 0;
  let reached = time;
  for (const fragment of fragments) {
    if (!fragment || !Number.isFinite(fragment.start) || !Number.isFinite(fragment.end)) continue;
    if (fragment.end <= reached) continue;
    // A small tolerance for the rounding between one fragment's end and the next's start.
    if (fragment.start > reached + 0.05) break;
    if (fragment.status !== COMPLETE) break;
    reached = fragment.end;
  }
  return reached - time;
}

/**
 * Seconds buffered without a hole from a time on, in a media element's buffered ranges.
 * @param {{length: number, start(i: number): number, end(i: number): number}|undefined|null} ranges
 * @param {number} time
 * @return {number}
 */
export function bufferedAhead(ranges, time) {
  if (!ranges || !Number.isFinite(time)) return 0;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= time + 0.1 && time < ranges.end(i)) {
      return ranges.end(i) - time;
    }
  }
  return 0;
}

/**
 * How far ahead a player has its video: the downloaded fragments of the video track and,
 * when there is one, the audio track (the shorter), or what the element has buffered,
 * whichever reaches further (a fragmented MP4's fragments have no times until parsed).
 * @param {Object} parts
 * @param {Array|undefined|null} parts.video - The video track's fragments.
 * @param {Array|undefined|null} [parts.audio] - The audio track's, if separate.
 * @param {*} [parts.buffered] - The element's buffered ranges.
 * @param {number} parts.time - The playhead.
 * @return {number}
 */
export function aheadOfPlayhead({video, audio, buffered, time}) {
  let fromFragments = downloadedAhead(video, time);
  if (audio && audio.length) {
    fromFragments = Math.min(fromFragments, downloadedAhead(audio, time));
  }
  return Math.max(fromFragments, bufferedAhead(buffered, time));
}
