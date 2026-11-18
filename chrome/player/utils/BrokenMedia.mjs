// @ts-check

// A decode error rebuilds the player at the same place (Firefox bug 2069633); the same place
// failing again right after is a broken segment, and the rebuild starts past it.

export const SAME_PLACE_S = 1.5;
// A later error at the same place is a new failure (the rebuilt player fails within ~1 s).
export const AGAIN_WITHIN_MS = 20000;
// Firefox decodes ahead: the failed segment may begin this soon after the error's time.
export const DECODED_AHEAD_S = 1;
// Past a place with no fragment known there.
export const BLIND_SKIP_S = 2;

/**
 * Whether an error is the <video> element's MEDIA_ERR_DECODE; the audio decoder's counts too,
 * since a muxed segment fails in whichever decoder trips first. Never throws.
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
 * @param {?{url: string, time: number, at: number}} last - The decode error before.
 * @param {string} url - The source's URL.
 * @param {number} time - This error's time.
 * @param {number} now - Date.now().
 * @return {boolean}
 */
export function isSamePlace(last, url, time, now) {
  return !!last && last.url === url && Number.isFinite(time) && Math.abs(time - last.time) <= SAME_PLACE_S &&
    now - last.at <= AGAIN_WITHIN_MS;
}

/**
 * Where to play on past the segment that keeps failing: the end of the segment beginning within
 * DECODED_AHEAD_S after the time, else of the one playing.
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
