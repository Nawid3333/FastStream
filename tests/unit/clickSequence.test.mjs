import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ClickSequence, ClickWindowMs} from '../../chrome/player/ui/ClickSequence.mjs';
import {ClickActions} from '../../chrome/player/options/defaults/ClickActions.mjs';
import {DefaultOptions} from '../../chrome/player/options/defaults/DefaultOptions.mjs';

// The clicks on the video (his wish, 2026-10-11): a click paused 300 ms after the Space key
// did, as it waited to see whether a double click came.

let acted;
beforeEach(() => {
  vi.useFakeTimers();
  acted = [];
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Clicks with these options, the options page's own unless given.
 * @param {Object} [options]
 * @return {ClickSequence}
 */
function video(options = {}) {
  const {singleClickAction, doubleClickAction, tripleClickAction} = {...DefaultOptions, ...options};
  return new ClickSequence(() => ({singleClickAction, doubleClickAction, tripleClickAction}), (action) => acted.push(action));
}

/**
 * Clicks in a row, this far apart.
 * @param {ClickSequence} clicks
 * @param {number} n
 * @param {number} [apartMs]
 */
function clickRow(clicks, n, apartMs = 100) {
  for (let i = 0; i < n; i++) {
    if (i > 0) vi.advanceTimersByTime(apartMs);
    clicks.click();
  }
}

describe('a click on the video', () => {
  it('plays or pauses at once, as the Space key does', () => {
    const clicks = video();
    clicks.click();
    expect(acted).toEqual([ClickActions.PLAY_PAUSE]);
    vi.advanceTimersByTime(ClickWindowMs + 50);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE]);
  });

  it('two in a row: the pause goes back, then the double click\'s fullscreen', () => {
    const clicks = video();
    clickRow(clicks, 2);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE, ClickActions.PLAY_PAUSE]);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE, ClickActions.PLAY_PAUSE, ClickActions.FULLSCREEN]);
  });

  it('three in a row: the triple click\'s action alone, the pause gone back', () => {
    const clicks = video();
    clickRow(clicks, 3);
    vi.advanceTimersByTime(0);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE, ClickActions.PLAY_PAUSE, ClickActions.HIDE_CONTROLS]);
  });

  it('two clicks further apart than a double click are two pauses', () => {
    const clicks = video();
    clickRow(clicks, 2, ClickWindowMs + 10);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE, ClickActions.PLAY_PAUSE]);
  });

  it('waits with a fullscreen, which a double click would undo again', () => {
    const clicks = video({singleClickAction: ClickActions.FULLSCREEN, doubleClickAction: ClickActions.PLAY_PAUSE});
    clicks.click();
    expect(acted).toEqual([]);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.FULLSCREEN]);

    acted = [];
    clickRow(clicks, 2);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE]);
  });

  it('does any action at once where no double or triple click does anything', () => {
    const clicks = video({singleClickAction: ClickActions.FULLSCREEN, doubleClickAction: ClickActions.NOTHING,
      tripleClickAction: ClickActions.NOTHING});
    clicks.click();
    expect(acted).toEqual([ClickActions.FULLSCREEN]);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.FULLSCREEN]);
    // Two quick clicks there are two single ones (deepseek's review): in and out again.
    acted = [];
    clickRow(clicks, 2);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.FULLSCREEN, ClickActions.FULLSCREEN]);
  });

  it('keeps the player\'s own defaults (hide the controls, two clicks pause) as they were', () => {
    const clicks = video({singleClickAction: ClickActions.HIDE_CONTROLS, doubleClickAction: ClickActions.PLAY_PAUSE,
      tripleClickAction: ClickActions.FULLSCREEN});
    clicks.click();
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.HIDE_CONTROLS]);
    acted = [];
    clickRow(clicks, 2);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE]);
  });
});
