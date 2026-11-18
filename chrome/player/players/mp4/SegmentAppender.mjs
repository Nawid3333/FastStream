// @ts-check
const REFUSALS_BEFORE_ERROR = 3;

/** A refused segment reloads from the playhead (reading less ahead when full); a third in a row fails. */
export class SegmentAppender {
  /**
   * @param {Object} player
   * @param {() => void} player.reload
   * @param {() => void} player.readLess
   * @param {(error: string) => void} player.fail
   * @param {(wrapper: Object) => boolean} player.isCurrent
   */
  constructor(player) {
    this.player = player;
    this.reloads = 0;
    this.refusals = 0;
  }

  /**
   * @param {import('./SourceBufferWrapper.mjs').SourceBufferWrapper} wrapper
   * @param {ArrayBuffer} buffer
   */
  append(wrapper, buffer) {
    const reloads = this.reloads;
    wrapper.appendBuffer(buffer, {media: true}).then(() => {
      if (reloads === this.reloads) {
        this.refusals = 0;
      }
    }, (e) => {
      if (reloads !== this.reloads || !this.player.isCurrent(wrapper)) {
        return;
      }
      this.refused(e);
    });
  }

  reloaded() {
    this.reloads++;
  }

  /** @param {Error} e */
  refused(e) {
    console.warn('The SourceBuffer refused a segment', e);
    this.refusals++;
    if (this.refusals >= REFUSALS_BEFORE_ERROR) {
      this.player.fail('The video could not be buffered: ' + (e?.name || e));
      return;
    }
    if (e?.name === 'QuotaExceededError') {
      this.player.readLess();
    }
    this.player.reload();
  }
}
