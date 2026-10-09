// @ts-check

// A segment that cannot be decoded, and the player built again for it (FastStreamClient.
// recoverPlayer). The first decode error at a place builds the player again at the same time:
// Firefox can fail to decode what a seek appended late (bug 2069633), the segment is fine,
// and a new MediaSource plays it. The same place failing again right after is the media's
// fault: built once more, the player then starts past that segment - a few seconds lost,
// where before the video ended for good. Measured on a DASH stream with one segment whose
// sample sizes were garbage: three rebuilds in 1.5 s at 3.64 s, then "Failed to load video!".
// dash.js's own recovery skips such a segment only when the SourceBuffer reports the error
// (it blacklists the segment appended last); a decode error on the <video> element only
// resets its MediaSource, and the same segment fails again.

// Two decode errors this close (seconds of the video) are at the same place.
export const SAME_PLACE_S = 1.5;
// Firefox decodes a little ahead: the segment that failed may begin this soon after the time
// the error came at (3.64 s for a segment from 4 s on, measured).
export const DECODED_AHEAD_S = 1;
// Past a place with no fragment known there.
export const BLIND_SKIP_S = 2;

/**
 * Whether an error is the <video> element's decode error (MEDIA_ERR_DECODE), as the players
 * pass it on: the element's error event. Never throws.
 * @param {*} reason
 * @return {boolean}
 */
export function isDecodeError(reason) {
  try {
    return reason?.target?.error?.code === 3;
  } catch (e) {
    return false;
  }
}

/**
 * Whether a decode error is again at the place of the one before, for the same source.
 * @param {?{url: string, time: number}} last - The decode error before.
 * @param {string} url - The source's URL.
 * @param {number} time - This error's time.
 * @return {boolean}
 */
export function isSamePlace(last, url, time) {
  return !!last && last.url === url && Number.isFinite(time) && Math.abs(time - last.time) <= SAME_PLACE_S;
}

/**
 * Where to play on past the segment that keeps failing to decode: the end of the segment that
 * begins within DECODED_AHEAD_S after the time (decoded ahead), else of the one playing.
 * @param {Array<?{start: number, end: number}>} fragments - The level's fragments.
 * @param {number} time - The time of the error.
 * @return {number}
 */
export function pastBrokenMedia(fragments, time) {
  /** @type {?{start: number, end: number}} */
  let playing = null;
  for (const fragment of fragments || []) {
    if (!fragment || !Number.isFinite(fragment.start) || !Number.isFinite(fragment.end)) continue;
    if (fragment.start > time && fragment.start - time <= DECODED_AHEAD_S) {
      return fragment.end;
    }
    if (fragment.start <= time && time < fragment.end) {
      playing = fragment;
    }
  }
  return playing ? playing.end : time + BLIND_SKIP_S;
}
