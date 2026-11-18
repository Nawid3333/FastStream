// @ts-check
import {AspectRatios} from '../options/defaults/AspectRatios.mjs';

export class VideoTransformUtils {
  /**
   * @param {{videoZoom: number, videoFlip: number, videoRotate: number}} options
   * @return {string}
   */
  static getTransformString(options) {
    const transforms = [];
    // Older versions could save a zoom of 0, and scale(0) hides the video.
    const zoom = options.videoZoom > 0 ? options.videoZoom : 1;

    if (options.videoFlip !== 0) {
      transforms.push(`scaleX(${options.videoFlip % 2 === 0 ? zoom : -zoom}) scaleY(${options.videoFlip > 1 ? -zoom : zoom})`);
    } else if (zoom !== 1) {
      transforms.push(`scale(${zoom})`);
    }

    if (options.videoRotate !== 0) {
      transforms.push(`rotate(${options.videoRotate * 90}deg)`);
    }

    return transforms.join(' ');
  }

  /**
   * A ratio gives the video a box of that shape and stretches the picture to it; stretch fills
   * the player; Auto (or an unknown value) leaves the video's own.
   * @param {{videoAspectRatio: string}} options
   * @return {{objectFit: string, aspectRatio: string}} aspectRatio as CSS ("16/9"), or ''.
   */
  static getAspectRatioStyles(options) {
    const ratio = options && options.videoAspectRatio;
    if (ratio === AspectRatios.STRETCH) {
      return {objectFit: 'fill', aspectRatio: ''};
    }
    if (typeof ratio !== 'string' || !/^\d+:\d+$/.test(ratio)) {
      return {objectFit: '', aspectRatio: ''};
    }
    return {objectFit: 'fill', aspectRatio: ratio.replace(':', '/')};
  }
}
