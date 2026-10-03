// How many refused appends in a row (with no accepted one between) MP4Player reloads from
// the playhead before it gives up with an error.
const REFUSALS_BEFORE_ERROR = 3;

/**
 * Appends MP4Player's media segments to its SourceBuffers, and decides what a refused one
 * means. A SourceBuffer refuses an append by throwing (QuotaExceededError when it is full,
 * InvalidStateError when its MediaSource is gone), and SourceBufferWrapper passes that on as
 * a rejection. Nothing caught it: an unhandled rejection, and since MP4Player releases a
 * segment's samples from mp4box as soon as it is queued, the segment was gone for good.
 * Playback reached the hole and waited there, with no error, until the user sought.
 *
 * Now a refused segment has the player load again from the playhead (reload), reading less
 * ahead (readLess) when the SourceBuffer was full, and a third refusal in a row is the
 * player's error (fail). Refusals of segments appended before the last reload are that
 * reload's business, as are those of SourceBuffers no longer in use.
 */
export class SegmentAppender {
  /**
   * @param {Object} player - What to do about a refusal.
   * @param {function(): void} player.reload - Load again from the playhead.
   * @param {function(): void} player.readLess - Buffer less ahead from now on.
   * @param {function(string): void} player.fail - Stop with this error.
   * @param {function(Object): boolean} player.isCurrent - Whether a SourceBufferWrapper is
   *   still the player's, and the player still running.
   */
  constructor(player) {
    this.player = player;
    this.reloads = 0;
    this.refusals = 0;
  }

  /**
   * Appends a media segment.
   * @param {Object} wrapper - The SourceBufferWrapper.
   * @param {ArrayBuffer} buffer
   */
  append(wrapper, buffer) {
    const reloads = this.reloads;
    wrapper.appendBuffer(buffer).then(() => {
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

  /**
   * The player loaded again from the playhead: what was appended before is no longer its
   * concern.
   */
  reloaded() {
    this.reloads++;
  }

  /**
   * @param {Error} e - Why the SourceBuffer refused a segment.
   */
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
