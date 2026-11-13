import {describe, expect, it} from 'vitest';

import {renderReport} from '../e2e/bench/report.mjs';
import {compare, mad, median, rankSumP, renderTable, roundOrder} from '../e2e/bench/stats.mjs';

describe('A/B benchmark numbers', () => {
  it('takes the median of odd and even counts, skipping runs that measured nothing', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([5, NaN, 1, undefined, 3])).toBe(3);
    expect(median([])).toBeNaN();
  });

  it('measures the spread so that one stray run barely moves it', () => {
    expect(mad([10, 11, 12, 13, 14])).toBe(1);
    expect(mad([10, 11, 12, 13, 1000])).toBe(1);
  });

  it('calls a difference only when it stands out from the noise and the floor', () => {
    // 100 against 80, both spread by 1: B is better (lower).
    expect(compare([98, 99, 100, 101, 102], [78, 79, 80, 81, 82]).verdict).toBe('better');
    expect(compare([78, 79, 80, 81, 82], [98, 99, 100, 101, 102]).verdict).toBe('worse');
    // Spread of 10 hides a difference of 15.
    expect(compare([80, 90, 100, 110, 120], [95, 105, 115, 125, 135]).verdict).toBe('same');
    // Below the floor: a timeupdate's 250 ms.
    expect(compare([1000, 1000, 1000, 1000, 1000], [1100, 1100, 1100, 1100, 1100], {floor: 250}).verdict).toBe('same');
    // Higher is better.
    expect(compare([1, 1, 1, 1, 1], [5, 5, 5, 5, 5], {lowerIsBetter: false}).verdict).toBe('better');
    // Three runs a side cannot tell anything (p 0.1 at best).
    expect(compare([99, 100, 101], [79, 80, 81]).verdict).toBe('same');
  });

  it('calls no difference between runs in the same two modes on both sides', () => {
    // HLS's first frame on a slow line, 2026-11-13: about 1.47 s or 2.0-2.1 s by the round on
    // both builds. Three slow rounds of five on A and two on B put the medians 475 ms apart, far
    // over twice the MAD; the order of the runs says nothing.
    const a = [2017, 1461, 2090, 1478, 2066];
    const b = [1997, 1478, 1475, 1542, 2008];
    const result = compare(a, b, {floor: 10});
    expect(result.diff).toBeCloseTo(-475, 0);
    expect(result.diff).toBeLessThan(-2 * result.noise);
    expect(result.p).toBeGreaterThan(0.05);
    expect(result.verdict).toBe('same');
  });

  it('gives the share of splits whose rank sums lie as far apart', () => {
    // Fully apart, five a side: only the split itself and its mirror, of 252.
    expect(rankSumP([1, 2, 3, 4, 5], [6, 7, 8, 9, 10])).toBeCloseTo(2 / 252, 6);
    // The same runs on both sides: every split is as far apart as none.
    expect(rankSumP([5, 5, 5], [5, 5, 5])).toBe(1);
    expect(rankSumP([], [1])).toBeNaN();
    // Past 200,000 splits it samples, the same way each time.
    const many = Array.from({length: 12}, (_, i) => 100 + i);
    const more = Array.from({length: 12}, (_, i) => 110 + i);
    const p = rankSumP(many, more);
    expect(p).toBe(rankSumP(many, more));
    expect(p).toBeLessThan(0.05);
  });

  it('reports B against A and how many runs each side had', () => {
    const result = compare([100, 100], [80, NaN, 80]);
    expect(result).toMatchObject({a: 100, b: 80, diff: -20, pct: -20, runs: [2, 2]});
  });

  it('gives no verdict when a side measured nothing', () => {
    expect(compare([], [1, 2]).verdict).toBe('n/a');
  });

  it('alternates which build runs first', () => {
    expect([0, 1, 2, 3].map(roundOrder)).toEqual([['A', 'B'], ['B', 'A'], ['A', 'B'], ['B', 'A']]);
  });

  it('renders one table line per measure', () => {
    const table = renderTable([{scenario: 'mp4', measure: 'first frame', unit: 'ms',
      result: compare([200, 205, 210, 215, 220], [150, 155, 160, 165, 170])}], {A: 'main', B: 'branch'});
    expect(table.split('\n')).toHaveLength(3);
    expect(table).toContain('| mp4 | first frame | 210 ms | 160 ms | -50 (-23.8 %) | 5 | 0.008 | 5/5 | better |');
  });

  it('renders a run\'s report again from its numbers', () => {
    const report = renderReport({at: 'now', labels: {A: 'main', B: 'branch'}, line: {rateMbit: 12, ttfbMs: 150},
      rounds: 5, warmup: 1, failures: ['hls branch round 2: timed out'],
      results: {mp4: {A: {pausedWake: [41, 41, 41, 41, 41]}, B: {pausedWake: [9, 9, 9, 9, 9]}}}});
    expect(report).toContain('# A/B benchmark now');
    expect(report).toContain('media: 12 Mbit/s shared line, 150 ms to first byte.');
    expect(report).toContain('| mp4 | wake-ups while paused | 41 /s | 9 /s | -32 (-78 %) | 0 | 0.008 | 5/5 | better |');
    expect(report).toContain('- hls branch round 2: timed out');
  });
});

describe('A/B benchmark settings', () => {
  it('takes a number from the environment only inside its range', async () => {
    const {boundedNumber} = await import('../e2e/bench/settings.mjs');
    const saved = process.env.BENCH_TEST_NUMBER;
    try {
      delete process.env.BENCH_TEST_NUMBER;
      expect(boundedNumber('BENCH_TEST_NUMBER', 7, 10)).toBe(7);
      process.env.BENCH_TEST_NUMBER = '';
      expect(boundedNumber('BENCH_TEST_NUMBER', 7, 10)).toBe(7);
      process.env.BENCH_TEST_NUMBER = '10';
      expect(boundedNumber('BENCH_TEST_NUMBER', 7, 10)).toBe(10);
      for (const wrong of ['11', '-1', 'soon', 'Infinity']) {
        process.env.BENCH_TEST_NUMBER = wrong;
        expect(() => boundedNumber('BENCH_TEST_NUMBER', 7, 10)).toThrow('BENCH_TEST_NUMBER must be a number from 0 to 10');
      }
    } finally {
      if (saved === undefined) delete process.env.BENCH_TEST_NUMBER;
      else process.env.BENCH_TEST_NUMBER = saved;
    }
  });
});
