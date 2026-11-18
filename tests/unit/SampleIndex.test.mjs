import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {RangeTimes, addKeyframes, minTimeIn, sortKeyframes} from '../../chrome/player/players/mp4/SampleIndex.mjs';

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

// Where each range of a fragmented MP4 starts in time (MP4Player.setFragmentTimes) was worked
// out from every sample again for each range read: 10 ms a call on a 2-hour file. RangeTimes
// keeps each range's time and must give the earliest time of the samples in each range, at
// every step, whatever comes in what order.
describe('RangeTimes', () => {
  const SIZE = 100;
  /** @param {number} count @return {Array<{rangeStart: number, rangeEnd: number}>} */
  const grid = (count) => Array.from({length: count}, (_, i) => ({rangeStart: i * SIZE, rangeEnd: (i + 1) * SIZE}));
  /** @param {number} offset @param {number} cts */
  const at = (offset, cts) => ({cts, is_sync: true, offset, timescale: 1000});
  /** @param {Array<{offset: number, cts: number}>} samples @param {{rangeStart: number, rangeEnd: number}} range */
  const earliest = (samples, range) => {
    const inRange = samples.filter((s) => s.offset >= range.rangeStart && s.offset <= range.rangeEnd);
    return inRange.length ? Math.min(...inRange.map((s) => s.cts)) / 1000 : null;
  };

  it('gives the earliest time in every range, at every step, for any samples in any order', () => {
    fc.assert(fc.property(
        // Offsets, mostly rising (a file read on), sometimes going back (a seek back).
        fc.array(fc.tuple(fc.integer({min: -60, max: 80}), fc.integer({min: 0, max: 5000})), {minLength: 1, maxLength: 150}),
        fc.array(fc.nat({max: 150}), {maxLength: 8}),
        fc.nat({max: 12}),
        (steps, cuts, extra) => {
          let offset = 0;
          /** @type {Map<number, number>} */
          const ctsAt = new Map();
          // A sample at an offset seen before is that sample parsed again: the same time.
          const full = steps.map(([step, cts]) => {
            offset = Math.max(0, offset + step);
            if (!ctsAt.has(offset)) ctsAt.set(offset, cts);
            return at(offset, /** @type {number} */ (ctsAt.get(offset)));
          });
          const ranges = grid(Math.ceil(full.at(-1).offset / SIZE) + 1);
          const times = new RangeTimes();
          const samples = [];
          const ends = [...new Set(cuts.map((cut) => Math.max(1, Math.min(cut, full.length))))].sort((a, b) => a - b);
          for (const end of [...ends, full.length]) {
            samples.push(...full.slice(samples.length, end));
            // Some calls ask for only some of the ranges, some for ranges added later.
            const asked = ranges.slice(0, Math.max(1, ranges.length - (end % 3) * extra));
            expect(times.times(samples, asked)).toEqual(asked.map((r) => earliest(samples, r)));
          }
        }), {numRuns: 1000});
  });

  it('gives the earliest time in each range once an earlier part comes after a later one', () => {
    const samples = [at(300, 3000), at(350, 3500), at(400, 4000)];
    const ranges = grid(5);
    const times = new RangeTimes();
    times.times(samples, ranges);
    samples.push(at(0, 0), at(50, 500), at(100, 1000), at(150, 1500), at(200, 2000));
    expect(times.times(samples, ranges)).toEqual(ranges.map((r) => earliest(samples, r)));
  });

  it('starts from a track with no samples yet, as a fragmented file\'s metadata has', () => {
    const samples = [];
    const ranges = grid(3);
    const times = new RangeTimes();
    expect(times.times(samples, ranges)).toEqual([null, null, null]);
    samples.push(at(120, 300), at(180, 200));
    expect(times.times(samples, ranges)).toEqual([null, 0.2, null]);
    samples.push(at(250, 900));
    expect(times.times(samples, ranges)).toEqual([null, 0.2, 0.9]);
  });

  it('keeps only the ranges asked for: one dropped is not held', () => {
    const samples = [at(10, 500), at(150, 100)];
    const ranges = grid(2);
    const times = new RangeTimes();
    times.times(samples, ranges);
    times.times(samples, ranges.slice(0, 1));
    expect([...times.lists.get(samples).ranges.keys()]).toEqual([ranges[0]]);
    expect(times.times(samples, ranges)).toEqual([0.5, 0.1]);
  });

  it('works out again a range whose bounds changed (the file\'s end found later)', () => {
    const samples = [at(10, 500), at(150, 100), at(190, 50)];
    const ranges = grid(2);
    const times = new RangeTimes();
    expect(times.times(samples, ranges)).toEqual([0.5, 0.05]);
    ranges[1].rangeEnd = 160;
    expect(times.times(samples, ranges)).toEqual([0.5, 0.1]);
  });

  it('reads only the new samples\' ranges, not the whole list, as a file plays on', () => {
    // A long file: 400 ranges of 50 samples. Each step appends one range's worth.
    const perRange = 50;
    const all = Array.from({length: 400 * perRange}, (_, i) => at(i * (SIZE / perRange), i * 40));
    const ranges = grid(400);
    let reads = 0;
    const samples = [];
    const counted = new Proxy(samples, {get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    }});
    const times = new RangeTimes();
    samples.push(...all.slice(0, 200 * perRange));
    times.times(counted, ranges);
    reads = 0;
    for (let r = 200; r < 210; r++) {
      samples.push(...all.slice(r * perRange, (r + 1) * perRange));
      expect(times.times(counted, ranges)).toEqual(ranges.map((x) => minTimeIn(all.slice(0, (r + 1) * perRange), x.rangeStart, x.rangeEnd)));
    }
    // Before: every sample read in every call (over 100,000 reads for these ten calls). Now about
    // 330 a call: each new sample twice (the order check) and the two ranges it touches again.
    expect(reads).toBeLessThan(5000);
  });
});
