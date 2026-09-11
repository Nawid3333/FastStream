import {describe, expect, it} from 'vitest';
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

  it('prunes entries older than cutoffSize but always keeps at least 2', () => {
    const now = performance.now();
    const t = new SpeedTracker();
    // Three entries, all ending well before the 10s cutoff.
    t.update(100, now - 20000, now - 19000);
    t.update(100, now - 18000, now - 17000);
    t.update(100, now - 16000, now - 15000);
    t.prune();
    // The oldest is prunable, but the "keep at least 2" floor stops there.
    expect(t.buffer.length).toBeGreaterThanOrEqual(2);
    expect(t.buffer[t.buffer.length - 1].end).toBe(now - 15000);
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
