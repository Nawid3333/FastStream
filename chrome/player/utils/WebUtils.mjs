// @ts-check
import {EnvUtils} from './EnvUtils.mjs';

/**
 * A press that types one of these characters is its US key, on any layout.
 * @type {Object<string, string>}
 */
const TypedKeyNames = {
  '0': 'Digit0', '1': 'Digit1', '2': 'Digit2', '3': 'Digit3', '4': 'Digit4',
  '5': 'Digit5', '6': 'Digit6', '7': 'Digit7', '8': 'Digit8', '9': 'Digit9',
  '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
  ';': 'Semicolon', '\'': 'Quote', '`': 'Backquote', ',': 'Comma', '.': 'Period', '/': 'Slash',
};

// Keys that type nothing and still go by position: modifiers have a left and a right one.
const PositionNamedKeys = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Super', 'Hyper',
  'Fn', 'FnLock', 'Unidentified', 'Process']);

export class WebUtils {
  /**
   * Falls back to execCommand('copy') where navigator.clipboard is refused (no secure context).
   * @param {string} text
   * @param {HTMLElement} container - Where the fallback's input goes, for a moment.
   * @return {Promise<void>}
   */
  static async copyText(text, container) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (e) {
      // The old way below.
    }
    const input = document.createElement('input');
    input.value = text;
    container.appendChild(input);
    input.focus();
    input.select();
    document.execCommand('copy');
    container.removeChild(input);
  }

  /**
   * @param {string} [type='div']
   * @param {string|null} [style]
   * @param {string} [cl] - The class name.
   * @return {HTMLElement}
   */
  static create(type, style, cl) {
    const el = document.createElement(type || 'div');
    if (style) el.style = style;
    if (cl) el.className = cl;
    return el;
  }

  /**
   * @param {HTMLElement} element
   */
  static setupTabIndex(element) {
    element.tabIndex = 0;
    element.role = 'button';
    WebUtils.setupKeyPress(element);
  }

  /**
   * Makes Enter and Space press a control as they press a <button>. A key an earlier listener
   * took (preventDefault) is left to it: a menu's Enter in its open list must not close it.
   * @param {HTMLElement} element
   * @param {(e: KeyboardEvent) => void} [press] - What a press does: a click by default.
   */
  static setupKeyPress(element, press = () => element.click()) {
    element.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Enter') {
        press(e);
        e.stopPropagation();
        return;
      }
      // Only when focused by keyboard: after a mouse click Space stays the player's play/pause.
      // Form controls have Space of their own.
      if (e.key === ' ' && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey &&
          !/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(element.tagName) && !element.isContentEditable &&
          element.matches(':focus-visible')) {
        e.preventDefault();
        e.stopPropagation();
        press(e);
      }
    });
  }

  /**
   * @param {HTMLElement} button
   * @param {boolean} open
   */
  static setExpanded(button, open) {
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', String(open));
  }

  /**
   * @param {HTMLElement} element
   * @param {string} label
   */
  static setLabels(element, label) {
    element.ariaLabel = label;
    element.title = label;
  }

  /**
   * @param {HTMLElement} elem
   * @return {number}
   */
  static getOffsetLeft(elem) {
    return elem.getBoundingClientRect().left;
  }

  /**
   * @param {HTMLElement} elem
   * @return {number}
   */
  static getOffsetTop(elem) {
    return elem.getBoundingClientRect().top;
  }

  /**
   * A key goes by the character the layout types, as in mpv's input.conf, under the US key's
   * name ('KeyZ', 'Minus'); the Shift or AltGr a character took is no modifier. Other
   * characters are named by themselves, non-Latin letters by position, keys that type nothing
   * by KeyboardEvent.key (modifiers by position).
   * @param {KeyboardEvent} e
   * @return {string}
   */
  static getKeyString(e) {
    const char = e.key && e.key.length === 1 && e.key !== ' ' ? e.key : null;
    // Control+Alt means AltGr only on Windows; elsewhere it is a shortcut of its own.
    const altGraph = (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) ||
      (EnvUtils.isWindows() && e.ctrlKey && e.altKey && char !== null && !/^[a-z]$/i.test(char));
    let key;
    let typed = false;
    if (e.key === ' ') {
      key = 'Space';
    } else if (char && /^[a-z]$/i.test(char)) {
      key = 'Key' + char.toUpperCase();
    } else if (char && TypedKeyNames[char]) {
      key = TypedKeyNames[char];
      typed = true;
    } else if (char && /^Key[A-Z]$/.test(e.code) && /\p{L}/u.test(char)) {
      key = e.code;
    } else if (char) {
      key = char;
      typed = true;
    } else if (e.key === 'Dead') {
      key = 'Dead';
    } else if (e.key && /^[A-Z][A-Za-z0-9]+$/.test(e.key) && !PositionNamedKeys.has(e.key)) {
      key = e.key;
    } else {
      key = e.code;
    }

    const metaPressed = e.metaKey && e.key !== 'Meta';
    const ctrlPressed = e.ctrlKey && e.key !== 'Control' && !altGraph;
    const altPressed = e.altKey && e.key !== 'Alt' && !altGraph;
    const shiftPressed = e.shiftKey && e.key !== 'Shift' && !typed;

    return (metaPressed ? 'Meta+' : '') + (ctrlPressed ? 'Control+' : '') + (altPressed ? 'Alt+' : '') + (shiftPressed ? 'Shift+' : '') + key;
  }

  /**
   * @param {string} iconPath - The SVG path data or URL.
   * @return {SVGElement}
   */
  static createSVGIcon(iconPath) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttributeNS('http://www.w3.org/1999/xlink', 'href', iconPath);
    svg.appendChild(use);
    return svg;
  }

  /**
   * @param {HTMLElement} parent
   * @param {Array<HTMLElement>} children
   */
  static replaceChildrenPerformant(parent, children) {
    const newChildrenSet = new Set(children);
    Array.from(parent.children).forEach((child) => {
      if (!newChildrenSet.has(/** @type {HTMLElement} */ (child))) {
        parent.removeChild(child);
      }
    });

    // In the order given, moving only what is out of place (overlapping subtitle cues after a seek back).
    children.forEach((child, i) => {
      if (parent.children[i] !== child) {
        parent.insertBefore(child, parent.children[i] || null);
      }
    });
  }
}
