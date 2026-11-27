// @ts-check
import {ClickActions} from '../options/defaults/ClickActions.mjs';

// How long a click waits for the next one of a double or a triple click.
export const ClickWindowMs = 300;
// The longest a click counted by the browser may come after its row's last one (Windows allows a double-click
// time up to 900 ms): a later one starts no undo of an older row.
const RowGapMs = 1000;

/**
 * The options' three click actions, each one of ClickActions' action names.
 * @typedef {Object} ClickOptions
 * @property {string} singleClickAction
 * @property {string} doubleClickAction
 * @property {string} tripleClickAction
 */
/**
 * The clicks on the video: one, two or three in a row, each with its action (the options'
 * singleClickAction, doubleClickAction, tripleClickAction).
 *
 * A click's place in its row is the browser's (the event's detail), which follows the system's
 * double-click time (Windows: 500 ms, longer than ClickWindowMs). A click without one (no
 * pointer) is counted with ClickWindowMs.
 *
 * A single click's play or pause comes at once (a click paused 300 ms
 * after the Space key did, as it waited to see whether a double click came). A second click
 * then plays or pauses back, as YouTube does, and the double click's action follows: at once
 * unless a triple click does something. Other single-click actions (fullscreen,
 * picture-in-picture, hiding the player) still wait: done at once and undone by the second
 * click, they flickered. Nothing waits where no double or triple click does anything.
 */
export class ClickSequence {
  /**
   * @param {() => ClickOptions} getOptions - The player's options, as they are now.
   * @param {(action: string) => void} act - Does a ClickActions action.
   */
  constructor(getOptions, act) {
    this.getOptions = getOptions;
    // "Nothing" is no action to do.
    /** @param {string} action */
    this.act = (action) => {
      if (action && action !== ClickActions.NOTHING) act(action);
    };
    this.count = 0;
    /** @type {?ReturnType<typeof setTimeout>} */
    this.timer = null;
    // The single click's action was done at once (on the first click of this row).
    this.singleDone = false;
    // When the row's last click came (Date.now).
    this.lastAt = -Infinity;
  }

  /**
   * A click on the video that did something else (closed a menu): its row's next click undoes nothing.
   * @param {number} [detail] - The click event's detail.
   */
  consumed(detail = 0) {
    clearTimeout(/** @type {ReturnType<typeof setTimeout>|undefined} */ (this.timer));
    this.timer = null;
    this.count = detail > 0 ? detail : 1;
    this.singleDone = false;
    this.lastAt = Date.now();
  }

  /**
   * A click on the video.
   * @param {number} [detail] - The click event's detail: its place in the row, 0 without a pointer.
   */
  click(detail = 0) {
    const options = this.getOptions();
    clearTimeout(/** @type {ReturnType<typeof setTimeout>|undefined} */ (this.timer));
    if (options.doubleClickAction === ClickActions.NOTHING && options.tripleClickAction === ClickActions.NOTHING) {
      // No double or triple click: each click is a single one, at once (two quick ones are
      // two, not a double click that does nothing).
      this.timer = null;
      this.count = 0;
      this.act(options.singleClickAction);
      return;
    }
    const now = Date.now();
    const before = now - this.lastAt <= RowGapMs ? this.count : 0;
    this.lastAt = now;
    const count = detail > 0 ? detail : (this.timer !== null ? before + 1 : 1);
    this.timer = null;
    this.count = count;
    // A fourth click and on does nothing more.
    if (count > 3) return;
    // The row's earlier click never came here (it closed a menu): nothing of it to undo.
    if (count > 1 && before !== count - 1) this.singleDone = false;

    if (count === 1) {
      this.singleDone = options.singleClickAction === ClickActions.PLAY_PAUSE;
      if (this.singleDone) this.act(options.singleClickAction);
    } else if (count === 2 && this.singleDone && options.singleClickAction === ClickActions.PLAY_PAUSE) {
      // A double click: the first click's play or pause goes back.
      this.act(ClickActions.PLAY_PAUSE);
    }

    const action = /** @type {string} */ ([null, options.singleClickAction, options.doubleClickAction, options.tripleClickAction][count]);
    const wait = count === 1 || (count === 2 && options.tripleClickAction !== ClickActions.NOTHING);
    if (!wait) {
      this.act(action);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (count === 1 && this.singleDone) return;
      this.act(action);
    }, ClickWindowMs);
  }
}
