import {EventEmitter} from '../eventemitter.mjs';
import {MP4Merger} from './mp4merger.mjs';

export class DASH2MP4 extends EventEmitter {
  constructor(registerCancel) {
    super();
    this.converter = null;
    this.registerCancel = registerCancel;
  }


  async convert(videoMimeType, videoDuration, videoInitSegment, audioMimeType, audioDuration, audioInitSegment, zippedFragments) {
    let mergerProgress = 0;
    try {
      this.converter = new MP4Merger(this.registerCancel);
      this.converter.on('progress', (progress) => {
        mergerProgress = progress;
        this.emit('progress', progress);
      });
      return await this.converter.convert(videoDuration, videoInitSegment, audioDuration, audioInitSegment, zippedFragments);
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
      if (!mergerErrors.includes(e.message)) {
        throw e;
      }

      // What the merger cannot join, Mediabunny copies as it is: see remuxer.mjs.
      const {Remuxer} = await import('../remux/remuxer.mjs');
      this.converter = new Remuxer(this.registerCancel);
      // The remuxer starts again from the first fragment. Its progress fills what is left
      // after the merger's, so the shown progress does not go back: a merger that gave up
      // at fragment 200 of 300 showed 66 % and then 0 %.
      this.converter.on('progress', (progress) => {
        this.emit('progress', mergerProgress + (1 - mergerProgress) * progress);
      });
      return await this.converter.convert(videoMimeType, videoDuration, videoInitSegment, audioMimeType, audioDuration, audioInitSegment, zippedFragments);
    }
  }

  /**
   * Closes the blob store the saved file reads from: see MP4Merger.release().
   */
  release() {
    this.converter?.release();
  }
}
