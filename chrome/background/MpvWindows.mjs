// @ts-check

/**
 * The mpv windows FastStream follows, each by the helper's id for it: '' for the one on the helper's own pipe, else
 * the 16 hex digits a play answered (docs/notes/mpv.md "Host 30").
 */

const WindowId = /^[0-9a-f]{16}$/;

/**
 * The window a helper's answer names; '' for none (its own pipe's).
 * @param {*} window - The answer's field.
 * @return {?string} null for a value no helper sends.
 */
export function windowOf(window) {
  if (window === undefined || window === '') return '';
  return typeof window === 'string' && WindowId.test(window) ? window : null;
}

/** @template {{window: string, usedAt: number}} W - usedAt: when the window last got a stream. */
export class MpvWindows {
  constructor() {
    /** @type {Map<string, W>} */
    this.windows = new Map();
    // Ids of windows whose mpv quit: an id is never made again (the helper's newWindow).
    /** @type {Set<string>} */
    this.closed = new Set();
  }

  /**
   * @param {?string|undefined} window
   * @return {W|undefined}
   */
  get(window) {
    return typeof window === 'string' ? this.windows.get(window) : undefined;
  }

  /** @param {W} entry */
  add(entry) {
    this.windows.set(entry.window, entry);
  }

  /**
   * Only that entry: a later one for the same window stays.
   * @param {W} entry
   * @param {boolean} [quit] - Its mpv quit; else only its watch ended (the helper went), and mpv may play on.
   */
  remove(entry, quit = false) {
    if (this.windows.get(entry.window) !== entry) return;
    this.windows.delete(entry.window);
    if (quit && entry.window) this.closed.add(entry.window);
  }

  /**
   * @param {string} window
   * @return {boolean} Whether its mpv is known to have quit.
   */
  hasQuit(window) {
    return this.closed.has(window);
  }

  /**
   * @param {W} entry
   * @return {boolean}
   */
  has(entry) {
    return this.windows.get(entry.window) === entry;
  }

  /** @return {Array<W>} */
  all() {
    return [...this.windows.values()];
  }

  /**
   * The one a stream goes to: the tab's own window while it is open, else the one that got the last stream.
   * @param {?string|undefined} own - The tab's window.
   * @return {W|undefined}
   */
  targetFor(own) {
    const mine = this.get(own);
    if (mine) return mine;
    let recent;
    for (const entry of this.windows.values()) {
      if (!recent || entry.usedAt > recent.usedAt) recent = entry;
    }
    return recent;
  }
}
