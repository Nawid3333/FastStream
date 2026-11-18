// @ts-check

/**
 * Says when to play a lower quality. Only steady playback counts: visible, about 1x (at 2x Firefox drops frames by design).
 */

/**
 * @typedef {Object} FrameSample
 * @property {number} now
 * @property {number} total
 * @property {number} dropped
 * @property {boolean} steady - Playing at about the normal speed, visible, not seeking or starving.
 * @property {string|number|null} levelId
 */

/**
 * @typedef {Object} WatchOptions
 * @property {number} [windowMs]
 * @property {number} [minFrames]
 * @property {number} [ratio]
 * @property {number} [warmupMs]
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
    /** @type {string|number|null} Chosen by hand: never stepped down from. */
    this.chosen = null;
    /** @type {string|number|null} */
    this.levelId = null;
    this.levelSince = 0;
    this.keepChoice = false;
  }

  /**
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

  /** The counts are the video's since it started: the stretch starts again at the next sample. */
  interrupt() {
    this.samples = [];
  }

  /** @param {string|number|null} levelId */
  userChose(levelId) {
    this.chosen = levelId;
    this.samples = [];
  }

  /** The next reset is the same video's (playPageQuality, recoverPlayer): the hand choice stays. */
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
 * The best of the next smaller height, else the same height at a lower frame rate.
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
 * Its height, with its frame rate when the video has that height at another rate (720p60, 720p30).
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
