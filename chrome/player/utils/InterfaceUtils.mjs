// @ts-check
import {DOMElements} from '../ui/DOMElements.mjs';

export class InterfaceUtils {
  /**
   * @return {boolean} Whether any window was open.
   */
  static closeWindows() {
    const windows = /** @type {HTMLElement[]} */ ([
      DOMElements.optionsContainer,
      DOMElements.subuiContainer,
      DOMElements.linkuiContainer,
    ]);

    let wasOpen = false;
    for (const box of windows) {
      if (box.style.display !== 'none') {
        wasOpen = true;
      }
      /** @type {HTMLElement} */ (box.getElementsByClassName('close_button')[0]).click();
    }

    return wasOpen;
  }

  /**
   * @return {boolean}
   */
  static isAnyWindowOpen() {
    const windows = /** @type {HTMLElement[]} */ ([
      DOMElements.optionsContainer,
      DOMElements.subuiContainer,
      DOMElements.linkuiContainer,
    ]);

    return windows.some((box) => box.style.display !== 'none');
  }
}
