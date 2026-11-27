import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ClickSequence, ClickWindowMs} from '../../chrome/player/ui/ClickSequence.mjs';
import {ClickActions} from '../../chrome/player/options/defaults/ClickActions.mjs';
import {DefaultOptions} from '../../chrome/player/options/defaults/DefaultOptions.mjs';

// A click on the video pauses at once, not after the double-click wait.

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
  const {singleClickAction, doubleClickAction} = {...DefaultOptions, ...options};
  return new ClickSequence(() => ({singleClickAction, doubleClickAction}), (action) => acted.push(action));
}

/**
 * Clicks without a pointer (no click count) in a row, this far apart.
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

const PAUSE_BACK_FULLSCREEN = [ClickActions.PLAY_PAUSE, ClickActions.PLAY_PAUSE, ClickActions.FULLSCREEN];

describe('a click on the video', () => {
  it('plays or pauses at once, as the Space key does', () => {
    const clicks = video();
    clicks.click();
    expect(acted).toEqual([ClickActions.PLAY_PAUSE]);
    vi.advanceTimersByTime(ClickWindowMs + 50);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE]);
  });

  it('two in a row: the pause goes back and the double click\'s fullscreen comes at once', () => {
    const clicks = video();
    clickRow(clicks, 2);
    expect(acted).toEqual(PAUSE_BACK_FULLSCREEN);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual(PAUSE_BACK_FULLSCREEN);
  });

  it('without a pointer, a third quick click starts the next row', () => {
    const clicks = video();
    clickRow(clicks, 3);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([...PAUSE_BACK_FULLSCREEN, ClickActions.PLAY_PAUSE]);
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
    expect(acted).toEqual([ClickActions.PLAY_PAUSE]);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE]);
  });

  it('does any action at once where the double click does nothing', () => {
    const clicks = video({singleClickAction: ClickActions.FULLSCREEN, doubleClickAction: ClickActions.NOTHING});
    clicks.click();
    expect(acted).toEqual([ClickActions.FULLSCREEN]);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.FULLSCREEN]);
    // two quick clicks there are two single ones
    acted = [];
    clickRow(clicks, 2);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.FULLSCREEN, ClickActions.FULLSCREEN]);
  });

  it('does nothing for an action set to nothing', () => {
    const clicks = video({singleClickAction: ClickActions.NOTHING, doubleClickAction: ClickActions.PLAY_PAUSE});
    clicks.click();
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([]);
    clickRow(clicks, 2);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE]);
  });

  it('keeps the player\'s own defaults (hide the controls, two clicks pause) as they were', () => {
    const clicks = video({singleClickAction: ClickActions.HIDE_CONTROLS, doubleClickAction: ClickActions.PLAY_PAUSE});
    clicks.click();
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.HIDE_CONTROLS]);
    acted = [];
    clickRow(clicks, 2);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE]);
  });
});

// #855: the row as the browser counts it (the event's detail, with the system's double-click time), the double
// click done on its second press.
describe('a click row as the browser counts it', () => {
  /**
   * The browser's presses and clicks of one row, each press this far after the last click.
   * @param {ClickSequence} clicks
   * @param {number} n
   * @param {number} apartMs
   */
  function browserRow(clicks, n, apartMs) {
    for (let i = 1; i <= n; i++) {
      if (i > 1) vi.advanceTimersByTime(apartMs);
      clicks.press(i);
      vi.advanceTimersByTime(80);
      clicks.click(i);
    }
  }

  it('does the double click on its second press, before the button is let go', () => {
    const clicks = video();
    clicks.press(1);
    clicks.click(1);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE]);
    vi.advanceTimersByTime(100);
    clicks.press(2);
    expect(acted).toEqual(PAUSE_BACK_FULLSCREEN);
    vi.advanceTimersByTime(80);
    clicks.click(2);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual(PAUSE_BACK_FULLSCREEN);
  });

  it('takes two clicks 450 ms apart for the double click the system made of them', () => {
    const clicks = video();
    browserRow(clicks, 2, 450);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual(PAUSE_BACK_FULLSCREEN);
  });

  it('a third click and a fourth do nothing', () => {
    const clicks = video();
    browserRow(clicks, 4, 100);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual(PAUSE_BACK_FULLSCREEN);
  });

  it('does the double click on its click where its press was not seen', () => {
    const clicks = video();
    clicks.click(1);
    vi.advanceTimersByTime(100);
    clicks.click(2);
    expect(acted).toEqual(PAUSE_BACK_FULLSCREEN);
  });

  it('a press cancels a waiting single click\'s action', () => {
    const clicks = video({singleClickAction: ClickActions.HIDE_CONTROLS, doubleClickAction: ClickActions.FULLSCREEN});
    clicks.press(1);
    clicks.click(1);
    vi.advanceTimersByTime(150);
    clicks.press(2);
    expect(acted).toEqual([ClickActions.FULLSCREEN]);
    clicks.click(2);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.FULLSCREEN]);
  });

  it('a press does nothing where the double click does nothing', () => {
    const clicks = video({doubleClickAction: ClickActions.NOTHING});
    browserRow(clicks, 2, 100);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE, ClickActions.PLAY_PAUSE]);
  });

  it('undoes nothing when the row\'s first click closed a menu: the double click\'s action only', () => {
    const clicks = video();
    clicks.click(1);
    vi.advanceTimersByTime(5000);
    acted = [];
    clicks.consumed(1);
    vi.advanceTimersByTime(200);
    clicks.press(2);
    clicks.click(2);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.FULLSCREEN]);
  });

  it('never undoes an older row\'s pause', () => {
    const clicks = video();
    clicks.click(1);
    vi.advanceTimersByTime(5000);
    clicks.press(2);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE]);
    clicks.click(2);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE, ClickActions.FULLSCREEN]);
  });

  it('two single clicks as the browser counts them are two pauses', () => {
    const clicks = video();
    browserRow(clicks, 1, 0);
    vi.advanceTimersByTime(700);
    browserRow(clicks, 1, 0);
    vi.advanceTimersByTime(ClickWindowMs);
    expect(acted).toEqual([ClickActions.PLAY_PAUSE, ClickActions.PLAY_PAUSE]);
  });

  it('a double click whose release never came leaves the next row as it is', () => {
    const clicks = video();
    clicks.press(1);
    clicks.click(1);
    vi.advanceTimersByTime(100);
    clicks.press(2);
    vi.advanceTimersByTime(3000);
    acted = [];
    browserRow(clicks, 2, 100);
    expect(acted).toEqual(PAUSE_BACK_FULLSCREEN);
  });
});
