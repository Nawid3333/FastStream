// @ts-check
import {PlayerModes} from '../enums/PlayerModes.mjs';
import {STILLS_LENGTH, StreamLength} from './StreamLength.mjs';

const STREAMING_MODES = [PlayerModes.ACCELERATED_HLS, PlayerModes.ACCELERATED_DASH];

// The media an MSE player appends may run a little past the manifest's total; another
// episode is seconds shorter or longer.
const MATCH_S = 3;
const MATCH_SHARE = 0.0025;

// Beside a stream this many times as long, or a short video beside any longer one, the video
// is as likely an ad or a trailer: the longest decides.
const DWARF_RATIO = 5;
export const SHORT_S = 180;

/**
 * Which of a page's streams its video plays: a page may load the next episode, or another
 * stream as long, beside the video the user watches.
 */
export class StreamPick {
  /**
   * @template {{url: string, duration?: number|null}} T
   * @param {T[]} sources - Each with its length in seconds, when known.
   * @param {?{src?: string, duration?: number|null}|undefined} video - Its URL (not a blob:)
   *   and its length in seconds (content.js).
   * @return {T[]|null} Null when the video tells none of them: then the longest play.
   */
  static played(sources, video) {
    if (!video) {
      return null;
    }

    const src = typeof video.src === 'string' && /^https?:\/\//i.test(video.src) ? video.src : '';
    let length = StreamPick.lengthOf(video.duration);
    let played = src ? sources.filter((source) => source.url === src) : [];
    if (played.length > 0) {
      length = StreamPick.lengthOf(played[0].duration) ?? length;
    } else if (length !== null) {
      played = sources.filter((source) => StreamPick.sameLength(source.duration, /** @type {number} */ (length)));
    }
    if (played.length === 0) {
      return null;
    }

    if (length === null) {
      // Length unknown: it decides only among the longest.
      const longest = StreamLength.longest(sources);
      played = played.filter((source) => longest.includes(source));
      return played.length > 0 ? played : null;
    }

    return StreamPick.outrun(sources, length) ? null : played;
  }

  /**
   * Whether a video of this length is as likely an ad or a trailer beside the sources.
   * @param {Array<{duration?: number|null}>} sources
   * @param {number|null} length - The video's length in seconds; null when not known.
   * @return {boolean}
   */
  static outrun(sources, length) {
    if (length === null || length === Infinity) {
      return false;
    }
    const best = Math.max(...sources.map((source) => StreamLength.rankLength(source.duration)));
    if (best >= length * DWARF_RATIO) {
      return true;
    }
    return length < SHORT_S && best > length && !StreamPick.sameLength(best, length);
  }

  /**
   * Whether a stream is plainly another video: both lengths known, finite and apart.
   * @param {?{duration?: number|null}} video - What the video plays (content.js).
   * @param {number|null|undefined} length - The stream's length in seconds, when read.
   * @return {boolean}
   */
  static conflicts(video, length) {
    const duration = StreamPick.lengthOf(video ? video.duration : null);
    const known = StreamPick.lengthOf(length);
    if (duration === null || known === null || duration === Infinity || known === Infinity) {
      return false;
    }
    return !StreamPick.sameLength(known, duration);
  }

  /**
   * The one at the lowest depth, a streaming one over a file there, else the first the page
   * loaded; an MP4 file is the newest MP4 at the lowest depth.
   * @template {{mode: string, depth?: number, time?: number}} T
   * @param {T[]} candidates - Not empty.
   * @return {T}
   */
  static pick(candidates) {
    let picked = candidates.reduce((result, curr) => {
      if (/** @type {number} */ (result.depth) > /** @type {number} */ (curr.depth)) {
        return curr;
      }
      if (/** @type {number} */ (result.depth) < /** @type {number} */ (curr.depth)) {
        return result;
      }
      if (!STREAMING_MODES.includes(result.mode) && STREAMING_MODES.includes(curr.mode)) {
        return curr;
      }
      return result;
    }, candidates[0]);

    if (picked && picked.mode === PlayerModes.ACCELERATED_MP4) {
      const files = candidates.filter((item) => item.mode === PlayerModes.ACCELERATED_MP4);
      files.sort((a, b) => {
        if (a.depth !== b.depth) {
          return /** @type {number} */ (a.depth) - /** @type {number} */ (b.depth);
        }
        return /** @type {number} */ (b.time) - /** @type {number} */ (a.time);
      });
      picked = files[0];
    }
    return picked;
  }

  /**
   * The streams to try should the pick fail: only the others it was picked from (a shorter
   * one is likelier an ad), never stills; lowest depth, then streaming ones, first.
   * @template {{mode: string, depth?: number, duration?: number|null}} T
   * @param {T[]} candidates - The streams the pick chose among (played, else longest).
   * @param {T} picked
   * @return {T[]}
   */
  static fallbacks(candidates, picked) {
    /** @type {(source: T) => number} */
    const streaming = (source) => STREAMING_MODES.includes(source.mode) ? 0 : 1;
    return candidates
        .filter((source) => source !== picked && source.duration !== STILLS_LENGTH)
        .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || streaming(a) - streaming(b));
  }

  /**
   * @param {number|null|undefined} duration - The stream's length in seconds, when known.
   * @param {number} length - The video's (a number over 0, or Infinity when live).
   * @return {boolean}
   */
  static sameLength(duration, length) {
    if (StreamPick.lengthOf(duration) === null) {
      return false;
    }
    if (duration === Infinity || length === Infinity) {
      return duration === length;
    }
    return Math.abs(/** @type {number} */ (duration) - length) <= Math.max(MATCH_S, length * MATCH_SHARE);
  }

  /**
   * @param {*} value - Seconds, maybe.
   * @return {number|null} The seconds (a number over 0, or Infinity), or null.
   */
  static lengthOf(value) {
    return typeof value === 'number' && value > 0 ? value : null;
  }
}
