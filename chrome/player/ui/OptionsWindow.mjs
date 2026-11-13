// @ts-check
import {Localize} from '../modules/Localize.mjs';
import {InterfaceUtils} from '../utils/InterfaceUtils.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {DOMElements} from './DOMElements.mjs';

// A player that shows no picture (no source yet, a failed one) loads its settings page after
// this, all the same: the GitHub build's update check runs in it.
const LoadAnywayMs = 5000;

export class OptionsWindow {
  constructor() {
    this.setupUI();
    // The settings page, an iframe, loads after the player's first frame (loadFrameWhenIdle,
    // from the client) or when this window opens. Loaded with the player, its scripts ran
    // beside the player's own as it started, and held the first frame of a video back by about
    // 140 ms (tools/bench-ab.mjs, 2026-11-13: 945 -> 808 ms, 7 of 7 rounds).
    this.frameAsked = false;
    this.frameLoaded = false;
    this.frameTimer = setTimeout(() => this.loadFrameWhenIdle(), LoadAnywayMs);
  }

  /** Loads the settings page, once. */
  loadFrame() {
    if (this.frameLoaded) return;
    this.frameLoaded = true;
    clearTimeout(this.frameTimer);
    const frame = /** @type {HTMLIFrameElement} */ (DOMElements.optionsFrame);
    frame.src = /** @type {string} */ (frame.dataset.src);
  }

  /** Loads the settings page when the page is next idle (or within a second). */
  loadFrameWhenIdle() {
    if (this.frameAsked || this.frameLoaded) return;
    this.frameAsked = true;
    clearTimeout(this.frameTimer);
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => this.loadFrame(), {timeout: 1000});
    } else {
      setTimeout(() => this.loadFrame(), 0);
    }
  }

  setupUI() {
    /** @type {HTMLElement} */ (DOMElements.optionsContainer).addEventListener('click', (e) => {
      e.stopPropagation();
    });

    /** @type {HTMLElement} */ (DOMElements.optionsContainer).addEventListener('keyup', (e) => {
      e.stopPropagation();
    });

    const closeBtn = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (DOMElements.optionsContainer).getElementsByClassName('close_button')[0]);
    closeBtn.addEventListener('click', (e) => {
      this.closeUI();
    });
    WebUtils.setupTabIndex(closeBtn);
  }

  isOpen() {
    return /** @type {HTMLElement} */ (DOMElements.optionsContainer).style.display !== 'none';
  }

  openUI() {
    this.loadFrame();
    InterfaceUtils.closeWindows();
    /** @type {HTMLElement} */ (DOMElements.optionsContainer).style.display = '';

    WebUtils.setLabels(/** @type {HTMLElement} */ (DOMElements.settingsButton), Localize.getMessage('player_settings_close_label'));
  }

  closeUI() {
    /** @type {HTMLElement} */ (DOMElements.optionsContainer).style.display = 'none';

    WebUtils.setLabels(/** @type {HTMLElement} */ (DOMElements.settingsButton), Localize.getMessage('player_settings_open_label'));
  }

  toggleUI() {
    if (!this.isOpen()) {
      this.openUI();
    } else {
      this.closeUI();
    }
  }
}
