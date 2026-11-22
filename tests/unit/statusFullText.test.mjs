import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The status line is one line in the control bar: in a narrow player its message ended in "..." with no way
// to read the rest but a tooltip, which shows late and never on touch. A message cut short shows whole and
// wrapped above the bar, for its reading time when it is new, and while the pointer is on it.

const {elements, bubble} = vi.hoisted(() => ({
  elements: [0, 1, 2].map(() => ({style: {}, textContent: '', className: '', onclick: null, scrollWidth: 0, clientWidth: 0})),
  bubble: {style: {display: 'none'}, textContent: '', className: ''},
}));
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {statusMessages: elements, statusFullText: bubble}}));

const {StatusManager, StatusTypes} = await import('../../chrome/player/ui/StatusManager.mjs');

const LONG = 'This video is larger than the disk space Firefox gives FastStream, so it is not predownloaded whole.';

/**
 * How wide a status message's text is, against the room it has.
 * @param {number} index
 * @param {number} textWidth
 * @param {number} [room]
 */
function widths(index, textWidth, room = 200) {
  elements[index].scrollWidth = textWidth;
  elements[index].clientWidth = Math.min(textWidth, room);
}

/** @return {boolean} */
function shown() {
  return bubble.style.display !== 'none';
}

let manager;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  elements.forEach((_, index) => widths(index, 100));
  bubble.style.display = 'none';
  bubble.textContent = '';
  manager = new StatusManager();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a status message the bar cuts short', () => {
  it('shows whole above the bar when it is new, for its reading time', () => {
    widths(0, 600);
    manager.setStatusMessage(StatusTypes.INFO, LONG, 'warning');
    expect(shown()).toBe(true);
    expect(bubble.textContent).toBe(LONG);
    expect(bubble.className).toBe('status_full_text warning');

    // 101 characters, 60 ms each.
    vi.setSystemTime(1_000_000 + 5_900);
    manager.updateStatusMessage();
    expect(shown()).toBe(true);
    vi.setSystemTime(1_000_000 + 6_200);
    manager.updateStatusMessage();
    expect(shown()).toBe(false);
  });

  it('goes with its message', () => {
    widths(0, 600);
    manager.setStatusMessage(StatusTypes.INFO, LONG, 'info', 2000);
    expect(shown()).toBe(true);
    vi.setSystemTime(1_000_000 + 2_100);
    manager.updateStatusMessage();
    expect(shown()).toBe(false);

    manager.setStatusMessage(StatusTypes.INFO, LONG, 'info');
    expect(shown()).toBe(true);
    manager.setStatusMessage(StatusTypes.INFO, null);
    expect(shown()).toBe(false);
  });

  it('shows nothing above the bar when the message fits', () => {
    widths(0, 150);
    manager.setStatusMessage(StatusTypes.INFO, 'Fits', 'info');
    expect(shown()).toBe(false);
  });

  it('shows again for another message, not for the same one counting on', () => {
    widths(1, 600);
    manager.setStatusMessage(StatusTypes.SAVE_VIDEO, 'Saving the video, 1% done', 'info');
    expect(shown()).toBe(true);
    vi.setSystemTime(1_000_000 + 20_000);
    manager.updateStatusMessage();
    expect(shown()).toBe(false);

    manager.setStatusMessage(StatusTypes.SAVE_VIDEO, 'Saving the video, 42.5% done', 'info');
    expect(shown()).toBe(false);
    manager.setStatusMessage(StatusTypes.SAVE_VIDEO, 'The video could not be saved', 'error');
    expect(shown()).toBe(true);
    expect(bubble.className).toBe('status_full_text error');
  });

  it('shows when it comes out from under a later level of its line', () => {
    widths(0, 600);
    manager.setStatusMessage(StatusTypes.ERROR, 'Short', 'error', 1000);
    manager.setStatusMessage(StatusTypes.INFO, LONG, 'info');
    expect(bubble.textContent).toBe('Short');
    vi.setSystemTime(1_000_000 + 1_100);
    manager.updateStatusMessage();
    expect(shown()).toBe(true);
    expect(bubble.textContent).toBe(LONG);
  });

  it('never shows by itself for the download line, but while the pointer is on it', () => {
    widths(0, 600);
    manager.setStatusMessage(StatusTypes.DOWNLOAD, 'Downloading with 4 connections, 12.5 MB/s, 40% done', 'info');
    expect(shown()).toBe(false);

    elements[0].onpointerenter();
    expect(shown()).toBe(true);
    vi.setSystemTime(1_000_000 + 60_000);
    manager.updateStatusMessage();
    expect(shown()).toBe(true);
    elements[0].onpointerleave({pointerType: 'mouse'});
    expect(shown()).toBe(false);
  });

  it('stays for its reading time after a finger lifts', () => {
    widths(0, 600);
    manager.setStatusMessage(StatusTypes.DOWNLOAD, LONG, 'info');
    elements[0].onpointerenter();
    elements[0].onpointerleave({pointerType: 'touch'});
    expect(shown()).toBe(true);
    vi.setSystemTime(1_000_000 + 6_200);
    manager.updateStatusMessage();
    expect(shown()).toBe(false);
  });

  it('shows nothing for the pointer on a message that fits', () => {
    manager.setStatusMessage(StatusTypes.DOWNLOAD, 'Fits', 'info');
    elements[0].onpointerenter();
    expect(shown()).toBe(false);
  });
});
