// @ts-check
// hls.js's numbers for the same nudge (highBufferWatchdogPeriod, nudgeOffset, nudgeMaxRetry).
const STALL_MIN_AHEAD = 1;
const STALL_TIMEOUT_MS = 2000;
const STALL_NUDGE = 0.1;
const STALL_MAX_NUDGES = 3;

/**
 * Firefox sometimes stops a playing video after a seek back into the buffer: a small seek forward frees it.
 */
export class StallWatchdog {
  /**
   * @param {((time: number) => void)|null} [onStuck] - Called once when still stuck after the last nudge; again only after it played on.
   */
  constructor(onStuck = null) {
  /** @type {number|null} */
    this.time = null;
    this.since = 0;
    this.nudges = 0;
    this.nudgedTo = NaN;
    this.onStuck = onStuck;
    this.reported = false;
  }

  /** @param {HTMLMediaElement} video */
  check(video) {
    const time = video.currentTime;
    const now = performance.now();
    if (time !== this.time) {
      // A nudge counts as moving only once it plays on. Firefox keeps whole microseconds.
      if (!(Math.abs(time - this.nudgedTo) < 0.001)) {
        this.nudges = 0;
        this.reported = false;
      }
      this.time = time;
      this.since = now;
      return;
    }

    if (video.paused || video.seeking || video.ended || !video.playbackRate || video.readyState < 2 ||
        bufferedAhead(video.buffered, time) < STALL_MIN_AHEAD) {
      // Not meant to move, or waiting for media, which is the player's loading to fix.
      this.since = now;
      return;
    }

    if (now - this.since < STALL_TIMEOUT_MS) {
      return;
    }
    if (this.nudges >= STALL_MAX_NUDGES) {
      if (!this.reported) {
        this.reported = true;
        console.error(`Playback still stuck at ${time} after ${STALL_MAX_NUDGES} nudges`);
        if (this.onStuck) this.onStuck(time);
      }
      return;
    }
    this.nudges++;
    this.since = now;
    this.nudgedTo = time + STALL_NUDGE * this.nudges;
    console.warn(`Playback stuck at ${time} with media buffered ahead, nudging it to ${this.nudgedTo}`);
    video.currentTime = this.nudgedTo;
  }
}

/**
 * @param {TimeRanges} buffered
 * @param {number} time - Seconds.
 * @return {number} Seconds; 0 when not buffered.
 */
export function bufferedAhead(buffered, time) {
  for (let i = 0; i < buffered.length; i++) {
    if (time >= buffered.start(i) && time <= buffered.end(i)) {
      return buffered.end(i) - time;
    }
  }
  return 0;
}
