// @ts-check

// How far apart (px on the progress bar) a frame may be from the pointer's place and still show there.
export const NearPx = 30;
// A seek still running this long is not waited for: the next place goes at once.
export const SeekLostMs = 1000;

/**
 * The seek preview's seeks, and whether its frame may show.
 *
 * One seek at a time while the pointer moves on: a seek on every pointer move cancelled the last one, so a sweep
 * showed 3-4 frames in 3 s. After a jump (a step farther than NearPx) the new place is sought at once. The frame on screen (the
 * place of the last seek that ended) shows only at the pointer's place, near it, or during the same pointer movement
 * (a step farther than NearPx starts the next one): a sweep's frames come a little behind the pointer, and after a
 * quick move from one place to another the old place's frame showed at the new one until the new frame came.
 */
export class PreviewSeeks {
  constructor() {
    /** @type {?number} The pointer's place. */
    this.pointer = null;
    /** @type {?number} The place the element is seeking to. */
    this.running = null;
    this.runningSince = 0;
    /** @type {?number} The place to seek to when the running seek ends. */
    this.pending = null;
    /** @type {?number} The place of the frame on screen. */
    this.onScreen = null;
    // The pointer's movement now, the running seek's, and the frame on screen's (null: not known).
    this.motion = 0;
    /** @type {?number} */
    this.runningMotion = null;
    /** @type {?number} */
    this.onScreenMotion = null;
  }

  /**
   * The pointer is on a place.
   * @param {number} time
   * @param {(a: number, b: number) => number} pxApart - How far apart two times are on the progress bar.
   * @param {number} now
   * @return {?number} The place to seek to now; null to wait for the running seek.
   */
  request(time, pxApart, now) {
    const jump = this.pointer === null || pxApart(this.pointer, time) > NearPx;
    if (jump) this.motion++;
    this.pointer = time;
    if (this.running !== null && now - this.runningSince < SeekLostMs && !jump) {
      this.pending = time === this.running ? null : time;
      return null;
    }
    this.pending = null;
    this.running = time;
    this.runningSince = now;
    this.runningMotion = this.motion;
    return time;
  }

  /**
   * Whether the seek just asked for runs: a player may hold it, or there was nothing to seek.
   * @param {boolean} seeking - The element's seeking, right after its currentTime was set.
   */
  sent(seeking) {
    if (!seeking) this.running = null;
  }

  /**
   * The element's seek ended.
   * @param {number} now
   * @param {number} landed - The element's time now: where a seek it ran went.
   * @return {?number} The next place to seek to.
   */
  seeked(now, landed) {
    this.onScreenMotion = this.running === null ? null : this.runningMotion;
    this.onScreen = this.running ?? landed;
    this.running = null;
    const next = this.pending;
    this.pending = null;
    if (next === null || next === this.onScreen) return null;
    this.running = next;
    this.runningSince = now;
    this.runningMotion = this.motion;
    return next;
  }

  /**
   * The running seek has not ended for SeekLostMs, and the pointer is somewhere else.
   * @param {number} now
   * @return {?number} The place to seek to now.
   */
  overdue(now) {
    if (this.running === null || this.pending === null || now - this.runningSince < SeekLostMs) return null;
    const next = this.pending;
    this.pending = null;
    this.running = next;
    this.runningSince = now;
    this.runningMotion = this.motion;
    return next;
  }

  /**
   * @param {(a: number, b: number) => number} pxApart
   * @return {boolean} The frame on screen belongs at the pointer's place.
   */
  fits(pxApart) {
    if (this.onScreen === null || this.pointer === null) return false;
    return this.onScreen === this.pointer || pxApart(this.onScreen, this.pointer) <= NearPx ||
      (this.onScreenMotion !== null && this.onScreenMotion === this.motion);
  }

  /** A new preview player: nothing on screen yet. */
  reset() {
    this.pointer = null;
    this.running = null;
    this.pending = null;
    this.onScreen = null;
    this.runningMotion = null;
    this.onScreenMotion = null;
  }
}
