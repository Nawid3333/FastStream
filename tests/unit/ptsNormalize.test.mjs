import {describe, expect, it} from 'vitest';
import {normalizePts} from '../../chrome/player/modules/hls2mp4/ptsNormalize.mjs';

// MPEG-TS timestamps are 33 bits and wrap at 2^33. hls2mp4's transmuxer called
// normalizePts without ever defining it, so a transport stream whose video timestamps
// crossed the wrap made the save throw a ReferenceError instead of finding the start.

const WRAP = 2 ** 33;

describe('normalizePts', () => {
  it('leaves a value alone when there is nothing to compare with', () => {
    expect(normalizePts(12345, null)).toBe(12345);
  });

  it('leaves a value that is already close to the reference', () => {
    expect(normalizePts(90000, 180000)).toBe(90000);
    expect(normalizePts(180000, 90000)).toBe(180000);
    expect(normalizePts(5, 5)).toBe(5);
  });

  it('brings a value that wrapped back up next to a reference just before the wrap', () => {
    const before = WRAP - 90000;
    expect(normalizePts(90000, before)).toBe(90000 + WRAP);
  });

  it('brings a value from before the wrap down next to a reference just after it', () => {
    const before = WRAP - 90000;
    expect(normalizePts(before, 90000)).toBe(before - WRAP);
  });

  it('moves across as many wraps as it takes', () => {
    expect(normalizePts(10, 3 * WRAP + 20)).toBe(3 * WRAP + 10);
    expect(normalizePts(3 * WRAP + 10, 20)).toBe(10);
  });

  it('stops half a wrap from the reference, in either direction', () => {
    const half = WRAP / 2;
    expect(normalizePts(half, 0)).toBe(half);
    expect(normalizePts(half + 1, 0)).toBe(half + 1 - WRAP);
  });

  it('finds the earliest start of samples that straddle the wrap, the way getVideoStartPts uses it', () => {
    // Samples in decode order across the wrap. The earliest is the first, 200000 ticks
    // before the wrap; once a sample from after the wrap shows up, it is expressed on
    // that side of the timeline, as -200000.
    const samples = [WRAP - 200000, WRAP - 100000, 50000, 150000];
    const start = samples.reduce((min, pts) => {
      const delta = pts - min;
      if (delta < -(WRAP / 2)) {
        return normalizePts(min, pts);
      }
      return delta > 0 ? min : pts;
    }, samples[0]);
    expect(start).toBe(-200000);
  });
});
