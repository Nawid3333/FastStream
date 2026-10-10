import {describe, expect, it} from 'vitest';
import {CSSFilterUtils} from '../../chrome/player/utils/CSSFilterUtils.mjs';

// The video's zoom and flips (Options > Video).
describe('CSSFilterUtils.getTransformString', () => {
  const options = (videoZoom, videoFlip = 0) => ({videoZoom, videoFlip, videoRotate: 0});

  // An emptied zoom field was saved as 0 by older versions, and the slider went down to 0 %:
  // scale(0) hid the video (review).
  it('takes a zoom of 0, or none, as no zoom', () => {
    expect(CSSFilterUtils.getTransformString(options(0))).toBe('');
    expect(CSSFilterUtils.getTransformString(options(undefined))).toBe('');
    expect(CSSFilterUtils.getTransformString(options(0, 1))).toBe('scaleX(-1) scaleY(1)');
  });

  it('keeps any other zoom', () => {
    expect(CSSFilterUtils.getTransformString(options(1.5))).toBe('scale(1.5)');
    expect(CSSFilterUtils.getTransformString(options(1))).toBe('');
  });
});
