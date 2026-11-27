// @ts-check
import {ClickActions} from '../options/defaults/ClickActions.mjs';

// How long a single click whose action is not play or pause waits for a second one; and the most two clicks
// without a pointer (no click count of the browser's) may be apart to be a double click.
export const ClickWindowMs = 300;
// The longest a click counted by the browser may come after its row's last one (Windows allows a double-click
// time up to 900 ms): a later one starts no undo of an older row.
const RowGapMs = 1000;

/**
 * The options' click actions, each one of ClickActions' action names.
 * @typedef {Object} ClickOptions
 * @property {string} singleClickAction
 * @property {string} doubleClickAction
 */
/**
 * The clicks on the video: a single and a double click, each with its action (the options' singleClickAction,
 * doubleClickAction). A third click in a row and on does nothing.
 *
 * A click's place in its row is the browser's (the event's detail), which follows the system's double-click time
 * (Windows: 500 ms, GTK: 400 ms). A click without one (no pointer) is counted with ClickWindowMs.
 *
 * The double click acts on its second press, as the system's own does (Windows sends a double click on the second
 * button-down), not on the release a click event waits for. A single click's play or pause comes at once; the
 * double click then plays or pauses back, as YouTube does. Other single-click actions (fullscreen,
 * picture-in-picture, hiding the player) wait ClickWindowMs for a second click: done at once and undone by it, they
 * flickered. Nothing waits where the double click does nothing.
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
    // The single click's play or pause was done at once (on the first click of this row).
    this.singleDone = false;
    // When the row's last click came (Date.now).
    this.lastAt = -Infinity;
    // The row's double click was done on its second press: that click itself does nothing more.
    this.pressedDouble = false;
  }

  /**
   * A click on the video that did something else (closed a menu): its row's next click undoes nothing.
   * @param {number} [detail] - The click event's detail.
   */
  consumed(detail = 0) {
    this.stopTimer();
    this.count = detail > 0 ? detail : 1;
    this.singleDone = false;
    this.pressedDouble = false;
    this.lastAt = Date.now();
  }

  /**
   * A press of the main button on the video: the second press of a row is the double click.
   * @param {number} detail - The mousedown event's detail: its place in the row.
   */
  press(detail) {
    if (detail !== 2 || this.count !== 1 || Date.now() - this.lastAt > RowGapMs) return;
    const options = this.getOptions();
    if (options.doubleClickAction === ClickActions.NOTHING) return;
    this.count = 2;
    this.lastAt = Date.now();
    this.pressedDouble = true;
    this.double(options);
  }

  /**
   * A click on the video.
   * @param {number} [detail] - The click event's detail: its place in the row, 0 without a pointer.
   */
  click(detail = 0) {
    if (this.pressedDouble) {
      this.pressedDouble = false;
      if (detail === 2) return;
    }
    const options = this.getOptions();
    clearTimeout(/** @type {ReturnType<typeof setTimeout>|undefined} */ (this.timer));
    if (options.doubleClickAction === ClickActions.NOTHING) {
      // No double click: each click is a single one, at once (two quick ones are two, not a double click that
      // does nothing).
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
    if (count > 2) return;
    if (count === 2) {
      // The row's first click never came here (it closed a menu): nothing of it to undo.
      if (before !== 1) this.singleDone = false;
      this.double(options);
      return;
    }
    this.singleDone = options.singleClickAction === ClickActions.PLAY_PAUSE;
    if (this.singleDone) this.act(options.singleClickAction);
    // Runs for a done play or pause too: a second click without a pointer is counted while it does.
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.singleDone) this.act(options.singleClickAction);
    }, ClickWindowMs);
  }

  /**
   * The double click: the first click's play or pause goes back, then the double click's action.
   * @param {ClickOptions} options
   */
  double(options) {
    this.stopTimer();
    if (this.singleDone && options.singleClickAction === ClickActions.PLAY_PAUSE) this.act(ClickActions.PLAY_PAUSE);
    this.singleDone = false;
    this.act(options.doubleClickAction);
  }

  stopTimer() {
    clearTimeout(/** @type {ReturnType<typeof setTimeout>|undefined} */ (this.timer));
    this.timer = null;
  }
}
