// @ts-check
import {EventEmitter} from '../eventemitter.mjs';
import {MP4Merger} from './mp4merger.mjs';

export class DASH2MP4 extends EventEmitter {
  /**
   * @param {(cancel: () => void) => void} [registerCancel] - Called with the function that
   *   cancels the save.
   */
  constructor(registerCancel) {
    super();
    this.converter = null;
    this.registerCancel = registerCancel;
  }


  /**
   * Joins the streams into one MP4 with MP4Merger, or copies them with the remuxer where the
   * merger gives up.
   * @param {string|null|undefined} videoMimeType - Passed on to the remuxer, which does not need it.
   * @param {number} videoDuration - Seconds; 0 without video.
   * @param {?ArrayBufferLike} videoInitSegment - Its init segment; null without one.
   * @param {string|null|undefined} audioMimeType - As videoMimeType.
   * @param {number} audioDuration - Seconds; 0 without a separate audio track.
   * @param {?ArrayBufferLike} audioInitSegment - Its init segment; null without one.
   * @param {Array<import('./mp4merger.mjs').ZippedFragment>} zippedFragments - The fragments of both tracks, by time.
   * @return {Promise<Blob>} The MP4.
   */
  async convert(videoMimeType, videoDuration, videoInitSegment, audioMimeType, audioDuration, audioInitSegment, zippedFragments) {
    let mergerProgress = 0;
    try {
      this.converter = new MP4Merger(this.registerCancel);
      this.converter.on('progress', (/** @type {number} */ progress) => {
        mergerProgress = progress;
        this.emit('progress', progress);
      });
      // Downloaded, the init segments are plain ArrayBuffers.
      return await this.converter.convert(videoDuration, /** @type {?ArrayBuffer} */ (videoInitSegment), audioDuration, /** @type {?ArrayBuffer} */ (audioInitSegment), zippedFragments);
    } catch (e) {
      const mergerErrors = [
        'Video codec not supported!',
        'Audio codec not supported!',
        'Video is not an mp4!',
        'Audio is not an mp4!',
        'Unsupported mdat count!',
        'Unsupported moofs count!',
        'Unsupported trafs count!',
        'Sample duration is zero!',
      ];
      if (!mergerErrors.includes(/** @type {Error} */ (e).message)) {
        throw e;
      }

      // What the merger cannot join, Mediabunny copies as it is: see remuxer.mjs.
      const {Remuxer} = await import('../remux/remuxer.mjs');
      this.converter = new Remuxer(this.registerCancel);
      // The remuxer starts again from the first fragment. Its progress fills what is left
      // after the merger's, so the shown progress does not go back: a merger that gave up
      // at fragment 200 of 300 showed 66 % and then 0 %.
      this.converter.on('progress', (/** @type {number} */ progress) => {
        this.emit('progress', mergerProgress + (1 - mergerProgress) * progress);
      });
      return await this.converter.convert(videoMimeType, videoDuration, /** @type {?ArrayBuffer} */ (videoInitSegment), audioMimeType, audioDuration, /** @type {?ArrayBuffer} */ (audioInitSegment), zippedFragments);
    }
  }

  /**
   * Closes the blob store the saved file reads from: see MP4Merger.release().
   */
  release() {
    this.converter?.release();
  }
}
