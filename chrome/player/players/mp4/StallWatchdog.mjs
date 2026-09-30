// A video that says it is playing, with this much buffered ahead of it, is stuck once its
// time has not moved for STALL_TIMEOUT_MS; it is then nudged forward STALL_NUDGE seconds,
// one step further each time, at most STALL_MAX_NUDGES times until it moves again. The
// numbers are hls.js's for the same nudge (highBufferWatchdogPeriod, nudgeOffset,
// nudgeMaxRetry).
const STALL_MIN_AHEAD = 1;
const STALL_TIMEOUT_MS = 2000;
const STALL_NUDGE = 0.1;
const STALL_MAX_NUDGES = 3;

/**
 * Firefox sometimes stops a video that says it is playing: after a seek back into what is
 * buffered, the element is not paused and not seeking, at readyState 2 with minutes
 * buffered ahead, and its time and frame count stay where they are. play() gets it going,
 * but at the time its clock has run on to, a minute later; a seek starts it where it was
 * sought to. So a stuck video is sought a little forward, as hls.js does for its streams.
 * MP4Player's main loop runs check() about every millisecond.
 */
export class StallWatchdog {
  /**
   * @param {function(number): void} [onStuck] - Called once, with the time, when the video is
   *   still stuck after the last nudge; again only after it has played on. The video stayed
   *   frozen after the nudges ran out, with no error to show.
   */
  constructor(onStuck = null) {
    // The time last seen and since when, how many nudges there have been, and where the
    // last one went (NaN: none).
    this.time = null;
    this.since = 0;
    this.nudges = 0;
    this.nudgedTo = NaN;
    this.onStuck = onStuck;
    this.reported = false;
  }

  /**
   * Nudges the video on if it is stuck.
   * @param {HTMLMediaElement} video
   */
  check(video) {
    const time = video.currentTime;
    const now = performance.now();
    if (time !== this.time) {
      // It moved. A nudge moves it too, and counts as moving only once it plays on from there.
      // Firefox keeps whole microseconds, so where a nudge lands can differ in the last digits.
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
 * How far the buffered range that holds a time runs past it.
 * @param {TimeRanges} buffered
 * @param {number} time - Seconds.
 * @return {number} Seconds; 0 when the time is not buffered.
 */
export function bufferedAhead(buffered, time) {
  for (let i = 0; i < buffered.length; i++) {
    if (time >= buffered.start(i) && time <= buffered.end(i)) {
      return buffered.end(i) - time;
    }
  }
  return 0;
}
