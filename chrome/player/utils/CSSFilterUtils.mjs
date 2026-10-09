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

    if (options.videoFlip !== 0) {
      transforms.push(`scaleX(${options.videoFlip % 2 === 0 ? options.videoZoom : -options.videoZoom}) scaleY(${options.videoFlip > 1 ? -options.videoZoom : options.videoZoom})`);
    } else if (options.videoZoom !== 1) {
      transforms.push(`scale(${options.videoZoom})`);
    }

    if (options.videoRotate !== 0) {
      transforms.push(`rotate(${options.videoRotate * 90}deg)`);
    }

    return transforms.join(' ');
  }
}
