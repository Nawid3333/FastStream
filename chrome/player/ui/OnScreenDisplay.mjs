import {DOMElements} from './DOMElements.mjs';

// How long a change stays on screen before it fades.
const ShowMs = 1000;

/**
 * A short text over the video for a moment, top left, as mpv's OSD: what a key just
 * changed (the playback speed), seen at once whether the control bar shows or not. Purely
 * visual (aria-hidden): the control the change went to carries its own label.
 */
export class OnScreenDisplay {
  constructor() {
    this.hideTimeout = null;
  }

  /**
   * Shows a text, replacing what shows now, and starts its time over.
   * @param {string} text - What to show.
   */
  show(text) {
    const element = DOMElements.osd;
    if (!element) return;
    element.textContent = text;
    element.classList.add('visible');
    clearTimeout(this.hideTimeout);
    this.hideTimeout = setTimeout(() => {
      element.classList.remove('visible');
    }, ShowMs);
  }
}
