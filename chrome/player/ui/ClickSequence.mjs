// @ts-check
import {ClickActions} from '../options/defaults/ClickActions.mjs';

// How long a click waits for the next one of a double or a triple click.
export const ClickWindowMs = 300;

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
 * A single click's play or pause comes at once (his wish, 2026-10-11: a click paused 300 ms
 * after the Space key did, as it waited to see whether a double click came). A second click
 * then plays or pauses back, as YouTube does, and the double click's action follows. Other
 * single-click actions (fullscreen, picture-in-picture, hiding the player) still wait: done at
 * once and undone by the second click, they flickered. Nothing waits where no double or
 * triple click does anything.
 */
export class ClickSequence {
  /**
   * @param {() => ClickOptions} getOptions - The player's options, as they are now.
   * @param {(action: string) => void} act - Does a ClickActions action.
   */
  constructor(getOptions, act) {
    this.getOptions = getOptions;
    // "Nothing" is no action to do (kimi's review).
    /** @param {string} action */
    this.act = (action) => {
      if (action && action !== ClickActions.NOTHING) act(action);
    };
    this.count = 0;
    /** @type {?ReturnType<typeof setTimeout>} */
    this.timer = null;
    // The single click's action was done at once (on the first click of this row).
    this.singleDone = false;
  }

  /** A click on the video. */
  click() {
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
    this.count = this.timer !== null ? this.count + 1 : 1;
    this.timer = null;

    if (this.count === 1) {
      this.singleDone = options.singleClickAction === ClickActions.PLAY_PAUSE;
      if (this.singleDone) this.act(options.singleClickAction);
    } else if (this.count === 2 && this.singleDone && options.singleClickAction === ClickActions.PLAY_PAUSE) {
      // A double click: the first click's play or pause goes back.
      this.act(ClickActions.PLAY_PAUSE);
    }

    const count = this.count;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (count === 1 && this.singleDone) return;
      const action = [null, options.singleClickAction, options.doubleClickAction, options.tripleClickAction][count];
      if (action) this.act(action);
    }, count < 3 ? ClickWindowMs : 0);
  }
}
