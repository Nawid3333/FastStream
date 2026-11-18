// @ts-check

/**
 * @typedef {Object} TimedFragment
 * @property {number} start
 * @property {number} end
 * @property {number} status
 */

// DownloadStatus.DOWNLOAD_COMPLETE, not imported: a pure module.
const COMPLETE = 3;

/**
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
 * The further of the fragments (an MP4's have no times until parsed) and the element's buffer.
 * @param {Object} parts
 * @param {Array<TimedFragment|undefined|null>|undefined|null} parts.video
 * @param {Array<TimedFragment|undefined|null>|undefined|null} [parts.audio]
 * @param {*} [parts.buffered]
 * @param {number} parts.time
 * @return {number}
 */
export function aheadOfPlayhead({video, audio, buffered, time}) {
  const hasVideo = !!video && video.length > 0;
  const hasAudio = !!audio && audio.length > 0;
  let fromFragments = 0;
  if (hasVideo && hasAudio) {
    fromFragments = Math.min(downloadedAhead(video, time), downloadedAhead(audio, time));
  } else if (hasVideo || hasAudio) {
    fromFragments = downloadedAhead(hasVideo ? video : audio, time);
  }
  return Math.max(fromFragments, bufferedAhead(buffered, time));
}
