import {describe, expect, it} from 'vitest';

import {chooseToRelease, HIGH, isFull, KEEP_ON_DISK_WINDOW, LOW, shareOf, WATCHED_WEIGHT, weightOf} from '../../chrome/player/network/MemoryBudget.mjs';

// Downloaded video stays in RAM up to a budget for all FastStream players together (2 GB by
// default, the user's setting); a player over its share writes the fragments furthest from
// the playhead to disk, or - in a private window - lets them go.

describe('MemoryBudget', () => {
  it('gives the watched player the larger share, and a lone one all of it', () => {
    const budget = 1000;
    // Alone: everything.
    expect(shareOf(budget, weightOf(true), [])).toBe(budget);
    // Watched, with one background player holding 600: its weight's part (4 of 5 = 800).
    expect(shareOf(budget, weightOf(true), [{ramBytes: 600, weight: weightOf(false)}])).toBe(800);
    // The background one: its part (200), or what the watched one leaves free when that is more.
    expect(shareOf(budget, weightOf(false), [{ramBytes: 300, weight: WATCHED_WEIGHT}])).toBe(700);
    expect(shareOf(budget, weightOf(false), [{ramBytes: 900, weight: WATCHED_WEIGHT}])).toBe(200);
  });

  it('lets go of what lies behind the playhead first, oldest first, then the furthest ahead', () => {
    const at = (start, bytes = 10) => ({start, end: start + 4, bytes});
    const held = [at(0), at(100), at(200), at(296), at(300), at(330), at(500), at(1000)];
    // At 300, keeping [290, 360]: behind are 0, 100, 200 (296 ends inside); ahead 500, 1000.
    // Exactly what lies outside the window: nothing inside it goes.
    const order = chooseToRelease(held, 300, KEEP_ON_DISK_WINDOW, 50).map((fragment) => fragment.start);
    expect(order).toEqual([0, 100, 200, 1000, 500]);
    // Only as many as it takes.
    expect(chooseToRelease(held, 300, KEEP_ON_DISK_WINDOW, 15).map((fragment) => fragment.start)).toEqual([0, 100]);
    expect(chooseToRelease(held, 300, KEEP_ON_DISK_WINDOW, 0)).toEqual([]);
  });

  it('lets go of all but the next seconds when the window alone is too big', () => {
    // A high bitrate or a small budget: the window kept around the playhead held more than
    // the share, and RAM grew without a bound.
    const at = (start) => ({start, end: start + 4, bytes: 100});
    const held = [at(290), at(304), at(308), at(320), at(340)];
    const order = chooseToRelease(held, 300, KEEP_ON_DISK_WINDOW, 250).map((fragment) => fragment.start);
    // Nothing lies outside [290, 360]: then behind first, then the furthest ahead, never
    // the next 10 s [300, 310].
    expect(order).toEqual([290, 340, 320]);
  });

  it('is full from HIGH of its share until it is back down to LOW', () => {
    const share = 100;
    expect(isFull(share * HIGH, 0, share, false)).toBe(true);
    // In between: as it was.
    expect(isFull(share * 0.8, 0, share, true)).toBe(true);
    expect(isFull(share * 0.8, 0, share, false)).toBe(false);
    // What is on its way to disk counts as gone.
    expect(isFull(share * 0.85, share * 0.2, share, true)).toBe(false);
    expect(isFull(share * LOW, 0, share, true)).toBe(false);
  });
});
