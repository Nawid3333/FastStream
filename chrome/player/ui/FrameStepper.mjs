/** The frame length a frame step assumes until playback has shown two frames: the old fixed step. */
export const FALLBACK_FRAME_DURATION = 1 / 30;

// Gaps outside these are not one frame: timestamp noise below, a stall above.
const MIN_FRAME_DURATION = 1 / 240;
const MAX_FRAME_DURATION = 1;

// How far before a frame start a position still counts as in that frame. mediaTime, which
// the anchor comes from, is rounded to whole microseconds, so currentTime on the anchor
// frame can read a fraction of one below it; float division adds its own error on top.
// 10 us covers both and is far below a frame (1/240 s is over 4000 us).
const FRAME_START_TOLERANCE = 1e-5;

// Events after which the next presented frame is no playback frame: a seek, and the start
// or end of playback, present a frame stamped with the playback position, not its own.
const DISTURBANCES = ['seeking', 'play', 'pause'];

/**
 * Where to seek to show the next (1) or previous (-1) frame.
 *
 * Frames are taken to start every frameDuration from anchor, the start of a frame playback
 * presented. The target is the middle of the neighbouring frame, so a timestamp that rounds
 * either way, or a length slightly off, still lands on it.
 * @param {number} currentTime - The playback position; the frame on screen contains it.
 * @param {number} frameDuration - The length of one frame.
 * @param {number} direction - 1 forward, -1 back.
 * @param {number} [anchor] - The start of any frame.
 * @return {number} The time to seek to, never below 0.
 */
export function frameStepTarget(currentTime, frameDuration, direction, anchor = 0) {
  // The nudge keeps a position on a frame start, or rounded just below it, in that frame.
  const index = Math.floor((currentTime - anchor + FRAME_START_TOLERANCE) / frameDuration);
  const start = anchor + index * frameDuration;
  return Math.max(0, start + direction * frameDuration + frameDuration / 2);
}

/**
 * Learns how long a frame of the playing video is, so a frame step moves exactly one frame
 * the way mpv's frame-step does, instead of a fixed 1/30 s that skips or repeats frames on
 * 24, 25 or 60 fps video.
 *
 * requestVideoFrameCallback reports each presented frame's timestamp (mediaTime). Measured
 * on Firefox 156: during playback that is the frame's own start, but while paused it is the
 * position the video was seeked to, anywhere inside the frame. So only playback frames
 * count: the length is the shortest gap between two frames presented one after the other,
 * and the last of them anchors the frame grid. A frame dropped at high speed only makes a
 * gap longer, which the shortest gap ignores.
 */
export class FrameStepper {
  constructor() {
    this.video = null;
    this.detach = null;
    this.forget();
  }

  forget() {
    this.shortestGap = null;
    this.anchor = null;
    this.last = null;
    this.skipNext = false;
  }

  /**
   * Starts following a video, and stops following the one before.
   * @param {HTMLVideoElement} video
   */
  watch(video) {
    if (video === this.video) {
      return;
    }
    this.detach?.();
    this.detach = null;
    this.video = video;
    this.forget();
    if (!video) {
      return;
    }

    const disturbed = () => {
      this.last = null;
      this.skipNext = true;
    };
    for (const type of DISTURBANCES) {
      video.addEventListener?.(type, disturbed);
    }
    this.detach = () => {
      for (const type of DISTURBANCES) {
        video.removeEventListener?.(type, disturbed);
      }
    };

    if (typeof video.requestVideoFrameCallback !== 'function') {
      return;
    }
    const onFrame = (now, metadata) => {
      if (this.video !== video) {
        return;
      }
      this.presented(metadata.mediaTime, metadata.presentedFrames);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  /**
   * Records a presented frame.
   * @param {number} mediaTime - Its timestamp.
   * @param {number} presentedFrames - How many frames the video has presented, this one included.
   */
  presented(mediaTime, presentedFrames) {
    if (this.skipNext) {
      this.skipNext = false;
      return;
    }
    if (this.last && presentedFrames - this.last.count === 1) {
      const gap = mediaTime - this.last.time;
      if (gap >= MIN_FRAME_DURATION && gap <= MAX_FRAME_DURATION && (this.shortestGap === null || gap < this.shortestGap)) {
        this.shortestGap = gap;
      }
    }
    this.last = {time: mediaTime, count: presentedFrames};
    this.anchor = mediaTime;
  }

  /** @return {number} The length of one frame in seconds. */
  get frameDuration() {
    return this.shortestGap ?? FALLBACK_FRAME_DURATION;
  }

  /**
   * @param {number} currentTime - The playback position.
   * @param {number} direction - 1 forward, -1 back.
   * @return {number} The time to seek to for one frame that way.
   */
  step(currentTime, direction) {
    return frameStepTarget(currentTime, this.frameDuration, direction, this.anchor ?? 0);
  }
}
