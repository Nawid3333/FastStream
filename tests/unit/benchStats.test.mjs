import {describe, expect, it} from 'vitest';

import {compare, mad, median, renderTable, roundOrder} from '../e2e/bench/stats.mjs';

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
    expect(compare([99, 100, 101], [79, 80, 81]).verdict).toBe('better');
    expect(compare([79, 80, 81], [99, 100, 101]).verdict).toBe('worse');
    // Spread of 10 hides a difference of 15.
    expect(compare([90, 100, 110], [105, 115, 125]).verdict).toBe('same');
    // Below the floor: a timeupdate's 250 ms.
    expect(compare([1000, 1000, 1000], [1100, 1100, 1100], {floor: 250}).verdict).toBe('same');
    // Higher is better.
    expect(compare([1, 1, 1], [5, 5, 5], {lowerIsBetter: false}).verdict).toBe('better');
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
      result: compare([200, 210, 220], [150, 160, 170])}], {A: 'main', B: 'branch'});
    expect(table.split('\n')).toHaveLength(3);
    expect(table).toContain('| mp4 | first frame | 210 ms | 160 ms | -50 (-23.8 %) | 10 | 3/3 | better |');
  });
});
