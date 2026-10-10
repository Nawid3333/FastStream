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
