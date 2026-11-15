import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {addKeyframes, sortKeyframes} from '../../chrome/player/players/mp4/SampleIndex.mjs';

// A fragmented MP4's keyframe index (MP4Player.refreshSampleIndex) is brought up to date with
// the samples mp4box adds as each range is parsed. It was made again from all of them each
// time: 7.7 ms a range on a 2-hour file (338,000 audio samples, each a keyframe), on the
// player's thread. addKeyframes sorts only the new ones in, and must give exactly what the full
// sort gives: the same samples, in the same order, ties included.

/** @param {number} cts @param {boolean} sync @param {number} id */
const sample = (cts, sync, id) => ({cts, is_sync: sync, offset: id, timescale: 1000, id});

describe('addKeyframes', () => {
  it('appends new keyframes that all come later, in the same array', () => {
    const samples = [sample(0, true, 0), sample(40, false, 1), sample(80, true, 2)];
    const sorted = sortKeyframes(samples);
    samples.push(sample(120, false, 3), sample(160, true, 4));
    const next = addKeyframes(sorted, samples, 3);
    expect(next).toBe(sorted);
    expect(next.map((s) => s.id)).toEqual([0, 2, 4]);
  });

  it('merges keyframes of an earlier part parsed later (a seek back)', () => {
    const samples = [sample(1000, true, 0), sample(2000, true, 1)];
    const sorted = sortKeyframes(samples);
    samples.push(sample(500, true, 2), sample(1500, true, 3), sample(1500, false, 4));
    expect(addKeyframes(sorted, samples, 2).map((s) => s.id)).toEqual([2, 0, 3, 1]);
  });

  it('keeps the earlier sample first among equal times, as the full sort does', () => {
    const samples = [sample(100, true, 0)];
    const sorted = sortKeyframes(samples);
    samples.push(sample(100, true, 1), sample(50, true, 2), sample(100, true, 3));
    expect(addKeyframes(sorted, samples, 1).map((s) => s.id)).toEqual([2, 0, 1, 3]);
  });

  it('gives what sorting every sample again gives, for any samples added in any steps', () => {
    fc.assert(fc.property(
        fc.array(fc.tuple(fc.integer({min: 0, max: 50}), fc.boolean()), {maxLength: 200}),
        fc.array(fc.nat({max: 200}), {maxLength: 10}),
        (all, cuts) => {
          const full = all.map(([cts, sync], id) => sample(cts, sync, id));
          const steps = [...new Set(cuts.map((cut) => Math.min(cut, full.length)))].sort((a, b) => a - b);
          /** @type {ReturnType<typeof sample>[]} */
          const samples = [];
          let sorted = sortKeyframes(samples);
          let count = 0;
          for (const end of [...steps, full.length]) {
            samples.push(...full.slice(samples.length, end));
            sorted = addKeyframes(sorted, samples, count);
            count = samples.length;
          }
          expect(sorted.map((s) => s.id)).toEqual(sortKeyframes(full).map((s) => s.id));
        }), {numRuns: 500});
  });
});
