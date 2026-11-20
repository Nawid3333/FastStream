// @ts-check

/**
 * The mpv windows FastStream follows, each by the helper's id for it: '' for the one on the helper's own pipe, else
 * the 16 hex digits a play answered (helper 30, docs/notes/mpv.md "Host 30").
 */

const WindowId = /^[0-9a-f]{16}$/;

/**
 * The window a helper's answer names; '' for none (a helper before 30, or its own pipe's).
 * @param {*} window - The answer's field.
 * @return {?string} null for a value no helper sends.
 */
export function windowOf(window) {
  if (window === undefined || window === '') return '';
  return typeof window === 'string' && WindowId.test(window) ? window : null;
}

/** @template {{window: string}} W */
export class MpvWindows {
  constructor() {
    /** @type {Map<string, W>} */
    this.windows = new Map();
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
   */
  remove(entry) {
    if (this.windows.get(entry.window) === entry) this.windows.delete(entry.window);
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
}
