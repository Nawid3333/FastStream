import {describe, expect, it} from 'vitest';
import {VideoTransformUtils} from '../../chrome/player/utils/VideoTransformUtils.mjs';

// The video's zoom and flips (Options > Video).
describe('VideoTransformUtils.getTransformString', () => {
  const options = (videoZoom, videoFlip = 0) => ({videoZoom, videoFlip, videoRotate: 0});

  // An emptied zoom field was saved as 0 by older versions, and the slider went down to 0 %:
  // scale(0) hid the video (review).
  it('takes a zoom of 0, or none, as no zoom', () => {
    expect(VideoTransformUtils.getTransformString(options(0))).toBe('');
    expect(VideoTransformUtils.getTransformString(options(undefined))).toBe('');
    expect(VideoTransformUtils.getTransformString(options(0, 1))).toBe('scaleX(-1) scaleY(1)');
  });

  it('keeps any other zoom', () => {
    expect(VideoTransformUtils.getTransformString(options(1.5))).toBe('scale(1.5)');
    expect(VideoTransformUtils.getTransformString(options(1))).toBe('');
  });
});

// The picture's aspect ratio (Options > Video, upstream #552; back on his word, 2026-10-11).
describe('VideoTransformUtils.getAspectRatioStyles', () => {
  const styles = (videoAspectRatio) => VideoTransformUtils.getAspectRatioStyles({videoAspectRatio});

  it('leaves auto, nothing and an unknown value to the video', () => {
    for (const value of ['auto', undefined, '', 'banana', '16:', ':9', '16/9']) {
      expect(styles(value)).toEqual({objectFit: '', aspectRatio: ''});
    }
  });

  it('gives a ratio a box of that shape, the picture stretched to it', () => {
    expect(styles('16:9')).toEqual({objectFit: 'fill', aspectRatio: '16/9'});
    expect(styles('4:3')).toEqual({objectFit: 'fill', aspectRatio: '4/3'});
    expect(styles('9:16')).toEqual({objectFit: 'fill', aspectRatio: '9/16'});
  });

  it('stretches to the whole player', () => {
    expect(styles('stretch')).toEqual({objectFit: 'fill', aspectRatio: ''});
  });
});
