import {StreamLength} from './StreamLength.mjs';

// A video's length and a stream's match within this many seconds, or this share of the
// length when that is more. Both come from the same manifest or movie header: an MSE player
// (hls.js, Shaka, dash.js) sets its video's length from the manifest's total, and the media
// it appends may run a little past it. Another episode is seconds shorter or longer.
const MATCH_S = 3;
const MATCH_SHARE = 0.0025;

// When a stream this many times as long as the page's video plays, or any longer one while
// the video runs less than SHORT_S, the video is as likely as not an ad, a trailer or a
// preview (they run a few minutes at most), and the longest decides, as it did before.
const DWARF_RATIO = 5;
const SHORT_S = 180;

/**
 * Which of a page's streams its video plays: the one FastStream replaced, or the one the
 * user started. The player plays that stream, not the page's longest, when it can tell: a
 * page may load the next episode, or another stream as long, beside the video the user
 * watches. Never over a far longer stream, nor a short video over any longer one: then
 * the longest plays, as it did before.
 */
export class StreamPick {
  /**
   * The streams the page's video plays.
   * @template {{url: string, duration?: number|null}} T
   * @param {T[]} sources - Detected sources, each with its length in seconds, when known.
   * @param {?{src?: string, duration?: number|null}} video - What the video plays: its URL,
   *   for a file it plays itself (not a blob:), and its length in seconds (content.js).
   * @return {T[]|null} Those of the sources, or null when the video tells none of them:
   *   then the longest play, as StreamLength.longest tells them.
   */
  static played(sources, video) {
    if (!video) {
      return null;
    }

    const src = typeof video.src === 'string' && /^https?:\/\//i.test(video.src) ? video.src : '';
    let length = StreamPick.lengthOf(video.duration);
    let played = src ? sources.filter((source) => source.url === src) : [];
    if (played.length > 0) {
      // Its file: the length read from it, when there is one.
      length = StreamPick.lengthOf(played[0].duration) ?? length;
    } else if (length !== null) {
      played = sources.filter((source) => StreamPick.sameLength(source.duration, length));
    }
    if (played.length === 0) {
      return null;
    }

    if (length === null) {
      // How long it runs is not known: it decides only among the longest.
      const longest = StreamLength.longest(sources);
      played = played.filter((source) => longest.includes(source));
      return played.length > 0 ? played : null;
    }

    // Nothing runs longer than a live stream.
    if (length === Infinity) {
      return played;
    }
    const best = Math.max(...sources.map((source) => StreamLength.rankLength(source.duration)));
    if (best >= length * DWARF_RATIO) {
      return null;
    }
    if (length < SHORT_S && best > length && !StreamPick.sameLength(best, length)) {
      return null;
    }
    return played;
  }

  /**
   * Whether a stream's length is a video's.
   * @param {number|null|undefined} duration - The stream's length in seconds, when known.
   * @param {number} length - The video's (a number over 0, or Infinity when live).
   * @return {boolean} Whether they match.
   */
  static sameLength(duration, length) {
    if (StreamPick.lengthOf(duration) === null) {
      return false;
    }
    if (duration === Infinity || length === Infinity) {
      return duration === length;
    }
    return Math.abs(duration - length) <= Math.max(MATCH_S, length * MATCH_SHARE);
  }

  /**
   * A length, when it is one.
   * @param {*} value - Seconds, maybe.
   * @return {number|null} The seconds (a number over 0, or Infinity), or null.
   */
  static lengthOf(value) {
    return typeof value === 'number' && value > 0 ? value : null;
  }
}
