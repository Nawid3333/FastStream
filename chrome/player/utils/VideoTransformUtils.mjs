/**
 * The CSS transform for the video's zoom, flip and rotation.
 */
export class VideoTransformUtils {
  /**
   * Generates a CSS transform string based on video options.
   * @param {Object} options - Video transform options.
   * @return {string} The CSS transform string.
   */
  static getTransformString(options) {
    const transforms = [];
    // A zoom of 0 (or none at all) is no zoom: scale(0) hid the video. An emptied zoom field
    // was saved as 0 by older versions, and the slider went down to 0 % (review).
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
}
