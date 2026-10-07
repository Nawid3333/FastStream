/**
 * The US key each digit and US punctuation character is on, the name a binding to it has
 * (getKeyString): a press that types the character is that key, on any layout.
 * @type {Object<string, string>}
 */
const TypedKeyNames = {
  '0': 'Digit0', '1': 'Digit1', '2': 'Digit2', '3': 'Digit3', '4': 'Digit4',
  '5': 'Digit5', '6': 'Digit6', '7': 'Digit7', '8': 'Digit8', '9': 'Digit9',
  '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
  ';': 'Semicolon', '\'': 'Quote', '`': 'Backquote', ',': 'Comma', '.': 'Period', '/': 'Slash',
};

/**
 * Utility functions for DOM and web operations.
 */
export class WebUtils {
  /**
   * Copies text to the clipboard with navigator.clipboard, or where the browser refuses it
   * (no secure context, or no click to answer: the web build on a plain-http page) the old
   * way, a selected input and document.execCommand('copy').
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
   * Creates a DOM element with optional style and class.
   * @param {string} [type='div'] - The type of element to create.
   * @param {string} [style] - The style to apply to the element.
   * @param {string} [cl] - The class name to apply to the element.
  * @return {HTMLElement} The created element.
   */
  static create(type, style, cl) {
    const el = document.createElement(type || 'div');
    if (style) el.style = style;
    if (cl) el.className = cl;
    return el;
  }

  /**
   * Sets up tab index and keyboard accessibility for an element.
   * @param {HTMLElement} element - The element to setup.
   */
  static setupTabIndex(element) {
    element.tabIndex = 0;
    element.role = 'button';
    element.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        element.click();
        e.stopPropagation();
      }
    });
  }

  /**
   * Sets ARIA and title labels for an element.
   * @param {HTMLElement} element - The element to label.
   * @param {string} label - The label text.
   */
  static setLabels(element, label) {
    element.ariaLabel = label;
    element.title = label;
  }

  /**
   * Gets the left offset of an element relative to the viewport.
   * @param {HTMLElement} elem - The element.
  * @return {number} The left offset in pixels.
   */
  static getOffsetLeft(elem) {
    return elem.getBoundingClientRect().left;
  }

  /**
   * Gets the top offset of an element relative to the viewport.
   * @param {HTMLElement} elem - The element.
  * @return {number} The top offset in pixels.
   */
  static getOffsetTop(elem) {
    return elem.getBoundingClientRect().top;
  }

  /**
   * Returns a string representation of a keyboard event's key combination.
   * @param {KeyboardEvent} e - The keyboard event.
  * @return {string} The key combination string.
   */
  static getKeyString(e) {
    // A key goes by the character the keyboard's layout types, as mpv's input.conf does,
    // not by where it sits on a US keyboard (e.code): on a German one the key labelled Y
    // is KeyZ, so it seeked back 60 s (Z's binding) and the key labelled Z set 5x (Y's); its
    // '-' is the US '/' and its '=' is Shift+0. A binding keeps its name: 'KeyZ', 'Minus'.
    // - A Latin letter is 'Key<LETTER>', Shift counted (Shift+Z is its own binding).
    // - A digit or one of the US punctuation characters is that key's US name, however the
    //   layout makes it: the Shift or AltGr it took is part of the character, not a modifier.
    // - Another character on such a key (German ß, ü, ´) is named by itself, and a dead key
    //   is 'Dead': neither is the US key's binding any more.
    // - A non-Latin letter (Cyrillic) goes by position: those keyboards carry the Latin
    //   letters too. Named keys (arrows, Enter, F1) go by position as before.
    const char = e.key && e.key.length === 1 && e.key !== ' ' ? e.key : null;
    // AltGr is Control+Alt on Windows; with it a key types a character, it is no shortcut.
    const altGraph = (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) ||
      (e.ctrlKey && e.altKey && char !== null && !/^[a-z]$/i.test(char));
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
   * Creates an SVG icon element from a given path.
   * @param {string} iconPath - The SVG path data or URL.
   * @return {SVGElement} The created SVG icon element.
   */
  static createSVGIcon(iconPath) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttributeNS('http://www.w3.org/1999/xlink', 'href', iconPath);
    svg.appendChild(use);
    return svg;
  }

  /**
   * Replaces all children of a parent element with new children efficiently.
   * @param {HTMLElement} parent - The parent element.
   * @param {Array<HTMLElement>} children - The new children to append.
   */
  static replaceChildrenPerformant(parent, children) {
    const newChildrenSet = new Set(children);
    Array.from(parent.children).forEach((child) => {
      if (!newChildrenSet.has(child)) {
        parent.removeChild(child);
      }
    });

    // In the order given, moving only what is out of place. Appending just the new ones put
    // a subtitle cue that came back (a seek back into overlapping cues) below one that
    // started after it.
    children.forEach((child, i) => {
      if (parent.children[i] !== child) {
        parent.insertBefore(child, parent.children[i] || null);
      }
    });
  }
}
