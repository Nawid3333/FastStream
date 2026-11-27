import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// A buffer taken back is said in the middle of the bar, apart from the status line (where a failed load's messages
// show): how much, and a quiet button that downloads the video again. Each part explains itself on hover.

/** An element enough for the notice: its style, title, text, classes and listeners. */
function element() {
  /** @type {Map<string, Array<(e: *) => void>>} */
  const listeners = new Map();
  const classes = new Set();
  return {
    style: {display: 'none'},
    title: '',
    ariaLabel: '',
    textContent: '',
    tabIndex: -1,
    role: '',
    parentElement: /** @type {*} */ (null),
    classList: {add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c)},
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    },
    fire(type) {
      const e = {stopPropagation: vi.fn(), preventDefault() {}};
      for (const fn of listeners.get(type) || []) fn(e);
      return e;
    },
    click() {
      return this.fire('click');
    },
  };
}

const bar = element();
const box = element();
box.parentElement = bar;
const text = element();
const again = element();
const againText = element();
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {
  bufferKept: box, bufferKeptText: text, bufferKeptAgain: again, bufferKeptAgainText: againText,
}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({
  Localize: {getMessage: (key, args) => `${key}${args ? `(${args.join(',')})` : ''}`},
}));
const {BufferKeptNotice} = await import('../../chrome/player/ui/BufferKeptNotice.mjs');

describe('BufferKeptNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says how much it reuses and explains both parts, centred in the bar', () => {
    const notice = new BufferKeptNotice();
    notice.show(1.4e9, () => {});
    expect(box.style.display).toBe('');
    expect(bar.classList.contains('buffer_kept_shown')).toBe(true);
    expect(text.textContent).toMatch(/^player_buffer_kept\(.+\)$/);
    expect(text.title).toBe('player_buffer_kept_title');
    expect(againText.textContent).toBe('player_buffer_kept_again');
    expect(again.title).toMatch(/^player_buffer_kept_again_title\(.+\)$/);
    expect(again.ariaLabel).toBe(again.title);
    expect(again.role).toBe('button');
    notice.hide();
  });

  it('downloads again only by its button, then goes; a click on its text reaches neither it nor the video', () => {
    const notice = new BufferKeptNotice();
    const onAgain = vi.fn();
    notice.show(5e8, onAgain);
    const onText = box.click();
    expect(onText.stopPropagation).toHaveBeenCalled();
    expect(onAgain).not.toHaveBeenCalled();
    const pressed = again.click();
    expect(pressed.stopPropagation).toHaveBeenCalled();
    expect(onAgain).toHaveBeenCalledTimes(1);
    expect(notice.isShown()).toBe(false);
    expect(bar.classList.contains('buffer_kept_shown')).toBe(false);
    again.click();
    expect(onAgain).toHaveBeenCalledTimes(1);
  });

  it('goes after its time, but not while the pointer or the focus is on it', () => {
    const notice = new BufferKeptNotice();
    notice.show(5e8, () => {});
    vi.advanceTimersByTime(BufferKeptNotice.ShownMs - 1);
    expect(notice.isShown()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(notice.isShown()).toBe(false);

    notice.show(5e8, () => {});
    box.fire('pointerenter');
    vi.advanceTimersByTime(BufferKeptNotice.ShownMs + 5000);
    expect(notice.isShown()).toBe(true);
    box.fire('pointerleave');
    expect(notice.isShown()).toBe(false);

    notice.show(5e8, () => {});
    box.fire('focusin');
    vi.advanceTimersByTime(BufferKeptNotice.ShownMs);
    expect(notice.isShown()).toBe(true);
    box.fire('focusout');
    expect(notice.isShown()).toBe(false);
  });

  it('a new notice starts its time again; hide() leaves nothing to fire', () => {
    const notice = new BufferKeptNotice();
    const first = vi.fn();
    notice.show(5e8, first);
    vi.advanceTimersByTime(BufferKeptNotice.ShownMs - 1000);
    notice.show(6e8, () => {});
    vi.advanceTimersByTime(2000);
    expect(notice.isShown()).toBe(true);
    notice.hide();
    expect(vi.getTimerCount()).toBe(0);
  });
});
