import {describe, expect, it, vi} from 'vitest';
import {SpeedTracker} from '../../chrome/player/network/SpeedTracker.mjs';

// Drives the displayed download speed and any speed-based ABR decisions.
// All timestamps below are built relative to a single performance.now()
// capture per test, so this runs deterministically without fake timers -
// prune()/getSpeed() only ever compare against "now" at call time, and the
// synchronous test body executes in well under a millisecond.

describe('SpeedTracker', () => {
  it('reports 0 speed with no data', () => {
    expect(new SpeedTracker().getSpeed()).toBe(0);
  });

  it('computes bytes/sec over the tracked window', () => {
    const now = performance.now();
    const t = new SpeedTracker();
    t.update(1000, now - 1000, now - 500);
    t.update(1000, now - 500, now);
    // totalData=2000 bytes over dt=(now - firstEntry.start)/1000 ~= 1s.
    // getSpeed() reads a fresh performance.now() internally (not mocked
    // here), so allow slack for real time elapsed running the test itself.
    const speed = t.getSpeed();
    expect(speed).toBeGreaterThan(1000);
    expect(speed).toBeLessThan(4000);
  });

  it('updates the in-flight entry in place when start matches, instead of duplicating it', () => {
    const now = performance.now();
    const t = new SpeedTracker();
    t.update(500, now, now + 100);
    t.update(1500, now, now + 200); // same start = same fragment, more data arrived
    expect(t.buffer).toHaveLength(1);
    expect(t.buffer[0].dataSize).toBe(1500);
    expect(t.buffer[0].end).toBe(now + 200);
  });

  it('pushes a new entry when start differs, even if very close in time', () => {
    const now = performance.now();
    const t = new SpeedTracker();
    t.update(500, now, now + 100);
    t.update(500, now + 100, now + 200);
    expect(t.buffer).toHaveLength(2);
  });

  // The prune cases fill the buffer directly: update() prunes as it goes, so entries added
  // through it are already pruned, and a prune() that did nothing passed (#251).
  /** A tracker holding entries that ended at the given times. */
  function trackerWith(...ends) {
    const t = new SpeedTracker();
    t.buffer = ends.map((end) => ({dataSize: 100, start: end - 1000, end}));
    return t;
  }

  it('prunes entries older than cutoffSize down to the last 2', () => {
    const now = performance.now();
    // Four entries, all ending well before the 10s cutoff.
    const t = trackerWith(now - 21000, now - 19000, now - 17000, now - 15000);
    t.prune();
    expect(t.buffer.map((entry) => entry.end)).toEqual([now - 17000, now - 15000]);
  });

  it('keeps 2 entries even when both are older than cutoffSize', () => {
    const now = performance.now();
    const t = trackerWith(now - 17000, now - 15000);
    t.prune();
    expect(t.buffer).toHaveLength(2);
  });

  it('prunes only the entries older than cutoffSize', () => {
    const now = performance.now();
    const t = trackerWith(now - 30000, now - 20000, now - 5000, now - 3000, now - 1000);
    t.prune();
    expect(t.buffer.map((entry) => entry.end)).toEqual([now - 5000, now - 3000, now - 1000]);
  });

  it('prunes as it is updated', () => {
    const now = performance.now();
    const t = new SpeedTracker();
    t.update(100, now - 20000, now - 19000);
    t.update(100, now - 18000, now - 17000);
    t.update(100, now - 16000, now - 15000);
    expect(t.buffer.map((entry) => entry.end)).toEqual([now - 17000, now - 15000]);
  });

  it('reports 0, not Infinity, for data that came within one tick of the clock', () => {
    // A response from the cache can come within the same performance.now() tick
    // it was asked in (1 ms in Firefox).
    vi.spyOn(performance, 'now').mockReturnValue(5000);
    const t = new SpeedTracker();
    t.update(4096, 5000, 5000);
    expect(t.getSpeed()).toBe(0);
    vi.restoreAllMocks();
  });

  // The two entries kept were counted over an ever longer time: after the last download the
  // speed went down slowly, never to 0 (review, 2026-10-09).
  it('reports 0 once nothing has come for the whole window', () => {
    const now = performance.now();
    const t = trackerWith(now - 17000, now - 15000);
    expect(t.getSpeed()).toBe(0);
    const recent = trackerWith(now - 17000, now - 2000);
    expect(recent.getSpeed()).toBeGreaterThan(0);
  });

  it('does not prune recent entries', () => {
    const now = performance.now();
    const t = new SpeedTracker();
    t.update(100, now - 500, now - 100);
    t.update(100, now - 100, now);
    t.prune();
    expect(t.buffer).toHaveLength(2);
  });
});
