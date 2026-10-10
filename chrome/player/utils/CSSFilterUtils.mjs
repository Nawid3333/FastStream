/**
 * Utility functions for generating CSS filter strings for video effects.
 */
export class CSSFilterUtils {
  /**
   * Generates a CSS filter string based on video options.
   * @param {Object} options - Video filter options.
   * @return {string} The CSS filter string.
   */
  static getFilterString(options) {
    const filters = [];
    if (!options.disableVisualFilters) {
      if (options.videoBrightness !== 1) {
        filters.push(`brightness(${options.videoBrightness})`);
      }

      if (options.videoContrast !== 1) {
        filters.push(`contrast(${options.videoContrast})`);
      }

      if (options.videoSaturation !== 1) {
        filters.push(`saturate(${options.videoSaturation})`);
      }

      if (options.videoGrayscale !== 0) {
        filters.push(`grayscale(${options.videoGrayscale})`);
      }

      if (options.videoSepia !== 0) {
        filters.push(`sepia(${options.videoSepia})`);
      }

      if (options.videoInvert !== 0) {
        filters.push(`invert(${options.videoInvert})`);
      }

      if (options.videoHueRotate !== 0) {
        filters.push(`hue-rotate(${options.videoHueRotate}deg)`);
      }
    }

    return filters.join(' ');
  }

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
