// @ts-check

/**
 * Watches for a video this computer cannot decode in time, and says when to play a lower
 * quality (his wish, 2026-10-24: step down when Firefox drops frames, and always say so).
 * Firefox counts the frames it decoded too late to show (getVideoPlaybackQuality's
 * droppedVideoFrames); a version too heavy for the machine drops a share of them for as long
 * as it plays. Only steady playback counts: playing, not seeking or starving, in a visible
 * tab (a hidden one shows no frames), and at about the normal speed, since at 2x and more
 * Firefox drops frames by design to keep up. After a switch the new version gets a few
 * seconds before it is judged.
 */

/**
 * @typedef {Object} FrameSample
 * @property {number} now - Date.now().
 * @property {number} total - getVideoPlaybackQuality().totalVideoFrames.
 * @property {number} dropped - getVideoPlaybackQuality().droppedVideoFrames.
 * @property {boolean} steady - Playing at about the normal speed, visible, not seeking or starving.
 * @property {string|number|null} levelId - The version playing.
 */

/**
 * @typedef {Object} WatchOptions
 * @property {number} [windowMs] - How long a stretch of steady playback is judged.
 * @property {number} [minFrames] - Frames the stretch must have, for a share that means something.
 * @property {number} [ratio] - The share of dropped frames that steps down.
 * @property {number} [warmupMs] - What a version gets after it starts, before it is judged.
 */

export class DroppedFrameWatch {
  /** @param {WatchOptions} [options] */
  constructor({windowMs = 10000, minFrames = 100, ratio = 0.2, warmupMs = 4000} = {}) {
    this.windowMs = windowMs;
    this.minFrames = minFrames;
    this.ratio = ratio;
    this.warmupMs = warmupMs;
    /** @type {Array<FrameSample>} */
    this.samples = [];
    /** @type {string|number|null} The version the user chose by hand: never stepped down from. */
    this.chosen = null;
    /** @type {string|number|null} */
    this.levelId = null;
    this.levelSince = 0;
    // The next reset is the same video's (keepChoiceOnce).
    this.keepChoice = false;
  }

  /**
   * One more sample. A step down is due when the stretch it ends dropped too much.
   * @param {FrameSample} sample
   * @return {?{ratio: number, frames: number}} The share dropped and the frames counted, when due.
   */
  sample(sample) {
    if (sample.levelId !== this.levelId) {
      // Another version: its own count, after its warm-up.
      this.levelId = sample.levelId;
      this.levelSince = sample.now;
      this.samples = [];
    }
    if (!sample.steady || sample.now - this.levelSince < this.warmupMs || sample.levelId === this.chosen) {
      this.samples = [];
      return null;
    }
    const last = this.samples.at(-1);
    // A count that went back is a new video element's: start over.
    if (last && (sample.total < last.total || sample.dropped < last.dropped)) this.samples = [];
    this.samples.push(sample);
    while (this.samples.length > 1 && sample.now - this.samples[1].now >= this.windowMs) this.samples.shift();
    const first = this.samples[0];
    if (sample.now - first.now < this.windowMs) return null;
    const frames = sample.total - first.total;
    const dropped = sample.dropped - first.dropped;
    if (frames < this.minFrames || dropped / frames < this.ratio) return null;
    this.samples = [];
    return {ratio: dropped / frames, frames};
  }

  /**
   * A seek, a change of speed or a stall: the counts are the video's since it started, and
   * one that came and went between two samples would be counted in the stretch, with the
   * frames dropped by design while it lasted. The stretch starts again at the next sample.
   */
  interrupt() {
    this.samples = [];
  }

  /**
   * The user chose this version by hand: it plays as chosen, whatever it drops.
   * @param {string|number|null} levelId
   */
  userChose(levelId) {
    this.chosen = levelId;
    this.samples = [];
  }

  /**
   * The next reset is the same video's, in a player built anew: another of the page's files
   * (playPageQuality), or a player rebuilt after an error (recoverPlayer). The version chosen
   * by hand stays chosen through it.
   */
  keepChoiceOnce() {
    this.keepChoice = true;
  }

  /** A new video: nothing counted, nothing chosen (but see keepChoiceOnce). */
  reset() {
    this.samples = [];
    if (!this.keepChoice) this.chosen = null;
    this.keepChoice = false;
    this.levelId = null;
    this.levelSince = 0;
  }
}

/**
 * @typedef {{id: string|number, height: number, width?: number, bitrate?: number, frameRate?: number}} QualityLevel
 */

/**
 * The version to step down to: the best of the next smaller height, or, with none smaller,
 * the same height at a lower frame rate. Null when there is nothing lighter.
 * @param {Array<QualityLevel>} levels
 * @param {QualityLevel} current
 * @return {?QualityLevel}
 */
export function lowerLevel(levels, current) {
  const smaller = levels.filter((level) => level.height > 0 && level.height < current.height);
  if (smaller.length) {
    const height = Math.max(...smaller.map((level) => level.height));
    return best(smaller.filter((level) => level.height === height));
  }
  const slower = levels.filter((level) => level.height === current.height && level.id !== current.id &&
    (level.frameRate || 0) > 0 && (current.frameRate || 0) > 0 && /** @type {number} */ (level.frameRate) < /** @type {number} */ (current.frameRate));
  if (!slower.length) return null;
  const rate = Math.max(...slower.map((level) => /** @type {number} */ (level.frameRate)));
  return best(slower.filter((level) => level.frameRate === rate));
}

/**
 * How the status line names a version: its height, and its frame rate too when the video has
 * that height at another rate (720p60 and 720p30), so the version to choose again is the one
 * named.
 * @param {Array<QualityLevel>} levels
 * @param {QualityLevel} level
 * @return {string}
 */
export function qualityLabel(levels, level) {
  const rate = Math.round(level.frameRate || 0);
  const another = rate > 0 && levels.some((other) => other.height === level.height &&
    Math.round(other.frameRate || 0) > 0 && Math.round(/** @type {number} */ (other.frameRate)) !== rate);
  return `${level.height}p${another ? rate : ''}`;
}

/**
 * @param {Array<QualityLevel>} levels - Of one height (and rate).
 * @return {QualityLevel}
 */
function best(levels) {
  return levels.reduce((a, b) => ((b.bitrate || 0) > (a.bitrate || 0) ? b : a));
}
