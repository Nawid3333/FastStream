// @ts-check
import {EventEmitter} from '../eventemitter.mjs';
import {MP4Merger} from './mp4merger.mjs';

export class DASH2MP4 extends EventEmitter {
  /**
   * @param {(cancel: () => void) => void} [registerCancel] - Gets what cancels the save.
   */
  constructor(registerCancel) {
    super();
    this.converter = null;
    this.registerCancel = registerCancel;
  }


  /**
   * MP4Merger, else the remuxer where the merger gives up.
   * @param {string|null|undefined} videoMimeType
   * @param {number} videoDuration - Seconds; 0 without video.
   * @param {?ArrayBufferLike} videoInitSegment - Its init segment; null without one.
   * @param {string|null|undefined} audioMimeType
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

      const {Remuxer} = await import('../remux/remuxer.mjs');
      this.converter = new Remuxer(this.registerCancel);
      // The remuxer starts again: its progress fills what is left, so progress never goes back.
      this.converter.on('progress', (/** @type {number} */ progress) => {
        this.emit('progress', mergerProgress + (1 - mergerProgress) * progress);
      });
      return await this.converter.convert(videoMimeType, videoDuration, /** @type {?ArrayBuffer} */ (videoInitSegment), audioMimeType, audioDuration, /** @type {?ArrayBuffer} */ (audioInitSegment), zippedFragments);
    }
  }

  /**
   * See MP4Merger.release().
   * @param {boolean} [removeFiles] - Its files on disk go too.
   */
  release(removeFiles = false) {
    this.converter?.release(removeFiles);
  }
}
