// @ts-check

/**
 * The MediaSource takes a new duration only while no SourceBuffer updates: they are held until it is set.
 * A seek past the element's duration waits for it (whenApplied).
 */
export class DurationSync {
  /**
   * @param {() => MediaSource|null|undefined} getMediaSource
   * @param {() => Array<import('./SourceBufferWrapper.mjs').SourceBufferWrapper>} getWrappers
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

  get pending() {
    return !Number.isNaN(this.target);
  }

  /** @param {number} duration - Seconds. */
  set(duration) {
    this.target = duration;
    this.apply();
  }

  /** On a SourceBuffer's updateend and on every loop tick: one taken away before its updateend sends none. */
  apply() {
    if (!this.pending) return;
    const mediaSource = this.getMediaSource();
    // Closed or ended: nothing to set it on, and a waiting seek goes ahead.
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

  /** @param {() => void} callback */
  whenApplied(callback) {
    if (this.pending) {
      this.waiting.push(callback);
    } else {
      callback();
    }
  }

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
