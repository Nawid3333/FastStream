// @ts-check

/**
 * Gives the MediaSource MP4Player's duration, which the video element seeks within: a seek
 * past the element's duration lands on that duration.
 *
 * The MediaSource takes a new duration only while none of its SourceBuffers is updating;
 * otherwise the setter throws an InvalidStateError. MP4Player sets it right after each
 * append, and an append starts at once when its queue is idle, so the setter threw nearly
 * every time. The player's own duration had moved on all the same: on a long fragmented file
 * it showed 268 s while the element still had 168 s, and a seek to 250 s landed on 168 s,
 * the stall watchdog moving it on to the next buffered range at 200 s (mp4-files.e2e,
 * 2026-11-09).
 *
 * Now a duration that cannot be set at once waits for the SourceBuffer running an operation:
 * the SourceBuffers start no further operation (SourceBufferWrapper.hold) until it is set, so
 * a steady stream of appends cannot keep it waiting. A seek past the element's duration waits
 * for it too (whenApplied).
 */
export class DurationSync {
  /**
   * @param {() => MediaSource|null|undefined} getMediaSource - The player's MediaSource.
   * @param {() => Array<import('./SourceBufferWrapper.mjs').SourceBufferWrapper>} getWrappers -
   *   The player's SourceBufferWrappers in use.
   */
  constructor(getMediaSource, getWrappers) {
    this.getMediaSource = getMediaSource;
    this.getWrappers = getWrappers;
    // The duration still to set, in seconds; NaN: none.
    this.target = NaN;
    /** @type {Array<() => void>} */
    this.waiting = [];
    /** @type {Array<import('./SourceBufferWrapper.mjs').SourceBufferWrapper>} */
    this.held = [];
  }

  /** Whether a duration waits to be set. */
  get pending() {
    return !Number.isNaN(this.target);
  }

  /**
   * Sets the MediaSource's duration now, or once no SourceBuffer is updating.
   * @param {number} duration - In seconds.
   */
  set(duration) {
    this.target = duration;
    this.apply();
  }

  /**
   * Sets the duration waiting, if the SourceBuffers let it: on a SourceBuffer's updateend, and
   * on every tick of the player's loop (a SourceBuffer taken away before its updateend sends
   * none).
   */
  apply() {
    if (!this.pending) return;
    const mediaSource = this.getMediaSource();
    // Closed (the player is gone) or ended (endOfStream, which waits for idle SourceBuffers
    // and is not called while one is held): there is nothing to set it on. A seek waiting goes
    // ahead anyway, rather than waiting for good.
    if (mediaSource && mediaSource.readyState === 'open') {
      const wrappers = this.getWrappers();
      const busy = wrappers.filter((wrapper) => wrapper.sourceBuffer.updating);
      if (busy.length) {
        for (const wrapper of wrappers) {
          if (!wrapper.held) {
            wrapper.hold();
            this.held.push(wrapper);
          }
        }
        return;
      }
      try {
        mediaSource.duration = this.target;
      } catch (e) {
        // Shorter than what is buffered, say: the element keeps the duration it has.
        console.warn('Could not set the MediaSource duration', e);
      }
    }
    this.finish();
  }

  /**
   * Runs `callback` once the duration waiting is set, or at once when none is.
   * @param {() => void} callback
   */
  whenApplied(callback) {
    if (this.pending) {
      this.waiting.push(callback);
    } else {
      callback();
    }
  }

  /** Forgets the duration waiting and the callbacks for it: the player is destroyed. */
  clear() {
    this.waiting.length = 0;
    this.target = NaN;
    this.release();
  }

  /** @private */
  finish() {
    this.target = NaN;
    this.release();
    for (const callback of this.waiting.splice(0)) {
      callback();
    }
  }

  /** @private */
  release() {
    for (const wrapper of this.held.splice(0)) {
      wrapper.release();
    }
  }
}
