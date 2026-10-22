// @ts-check
import {Localize} from '../modules/Localize.mjs';
import {InterfaceUtils} from '../utils/InterfaceUtils.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {DOMElements} from './DOMElements.mjs';

export class OptionsWindow {
  constructor() {
    this.setupUI();
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
