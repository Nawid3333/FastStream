import fc from 'fast-check';
import {describe, expect, it} from 'vitest';

import {INIT_URGENT_MS, loopDelay, PAUSED_LOOP_MS, STEADY_LOOP_MS, URGENT_LOOP_MS} from '../../chrome/player/players/mp4/LoopPace.mjs';

// MP4Player's main loop: at once while something is urgent, a quarter of a second while
// nothing can change by itself. A start that never got its first frame (data the element cannot
// decode) ran the loop 250 times a second for as long as its tab stayed open.

const playing = {ended: false, paused: false, seeking: false, readyState: 4, needsInit: false, sinceProgress: 0};

describe('The MP4 player\'s loop pace', () => {
  it('runs steadily while it plays with media ahead, and slowly while paused or ended', () => {
    expect(loopDelay(playing)).toBe(STEADY_LOOP_MS);
    expect(loopDelay({...playing, paused: true})).toBe(PAUSED_LOOP_MS);
    expect(loopDelay({...playing, ended: true, readyState: 2})).toBe(PAUSED_LOOP_MS);
  });

  it('runs at once while seeking or out of media', () => {
    expect(loopDelay({...playing, seeking: true})).toBe(URGENT_LOOP_MS);
    expect(loopDelay({...playing, seeking: true, paused: true})).toBe(URGENT_LOOP_MS);
    expect(loopDelay({...playing, readyState: 2})).toBe(URGENT_LOOP_MS);
  });

  it('runs at once while a start gets somewhere, and steadily once it has not for a while', () => {
    const start = {...playing, paused: true, readyState: 1, needsInit: true};
    expect(loopDelay({...start, sinceProgress: 0})).toBe(URGENT_LOOP_MS);
    expect(loopDelay({...start, sinceProgress: INIT_URGENT_MS - 1})).toBe(URGENT_LOOP_MS);
    expect(loopDelay({...start, sinceProgress: INIT_URGENT_MS})).toBe(STEADY_LOOP_MS);
    // Set to play, and never a first frame: not out of media for a moment, but for good.
    expect(loopDelay({...start, paused: false, sinceProgress: 60000})).toBe(STEADY_LOOP_MS);
    expect(loopDelay({...start, seeking: true, sinceProgress: 60000})).toBe(STEADY_LOOP_MS);
  });

  it('never waits longer than paused, nor more than the steady pace while a start goes on', () => {
    const state = fc.record({ended: fc.boolean(), paused: fc.boolean(), seeking: fc.boolean(),
      readyState: fc.integer({min: 0, max: 4}), needsInit: fc.boolean(), sinceProgress: fc.nat({max: 1e7})});
    fc.assert(fc.property(state, (s) => {
      const delay = loopDelay(s);
      expect([URGENT_LOOP_MS, STEADY_LOOP_MS, PAUSED_LOOP_MS]).toContain(delay);
      if (s.needsInit && !s.ended) expect(delay).toBeLessThanOrEqual(STEADY_LOOP_MS);
      if (!s.needsInit && !s.ended && (s.seeking || (!s.paused && s.readyState < 3))) expect(delay).toBe(URGENT_LOOP_MS);
    }));
  });
});
