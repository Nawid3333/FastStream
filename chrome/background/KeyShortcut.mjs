// @ts-check

/**
 * A key press as content.js reports it: the KeyboardEvent fields a shortcut
 * is matched on.
 * @typedef {{key: string, code: string, ctrlKey: boolean, altKey: boolean,
 *   shiftKey: boolean, metaKey: boolean}} KeyPress
 */

// KeyboardEvent.key values that commands.getAll() names differently.
const NamedKeys = new Map([
  [' ', 'Space'],
  [',', 'Comma'],
  ['.', 'Period'],
  ['ArrowUp', 'Up'],
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
  ['Home', 'Home'],
  ['End', 'End'],
  ['PageUp', 'PageUp'],
  ['PageDown', 'PageDown'],
  ['Insert', 'Insert'],
  ['Delete', 'Delete'],
  ['MediaPlayPause', 'MediaPlayPause'],
  ['MediaStop', 'MediaStop'],
  ['MediaTrackNext', 'MediaNextTrack'],
  ['MediaTrackPrevious', 'MediaPrevTrack'],
]);

// The same, by KeyboardEvent.code, for when Shift changed the character.
const NamedCodes = new Map([
  ['Space', 'Space'],
  ['Comma', 'Comma'],
  ['Period', 'Period'],
]);

/**
 * Matches key presses against the shortcut strings commands.getAll() returns
 * ("Ctrl+Shift+U", "Alt+Comma", "F5", ...).
 */
export class KeyShortcut {
  /**
   * The name a shortcut string uses for a pressed key.
   *
   * The character decides, as it does for Firefox's own key matching, so on
   * a German layout the key labelled Z is "Z". When the character is not a
   * Latin letter or digit - Shift+1 is "!" on most layouts, a Cyrillic
   * layout types "г" on the U key - the key's position stands in for it,
   * as Firefox's fallback to the Latin character does.
   *
   * @param {string} key - KeyboardEvent.key.
   * @param {string} code - KeyboardEvent.code.
   * @return {?string} The key's name, or null for one no shortcut can use.
   */
  static keyName(key, code) {
    if (/^[a-z0-9]$/i.test(key)) {
      return key.toUpperCase();
    }
    if (/^F([1-9]|1[0-9])$/.test(key)) {
      return key;
    }
    const named = NamedKeys.get(key);
    if (named) {
      return named;
    }
    const position = /^Key([A-Z])$/.exec(code) || /^Digit([0-9])$/.exec(code);
    if (position) {
      return position[1];
    }
    return NamedCodes.get(code) || null;
  }

  /**
   * Whether a key press is the given shortcut, modifiers exactly.
   *
   * @param {string} shortcut - As commands.getAll() gives it; "" when unset.
   * @param {KeyPress} press - The key press.
   * @param {boolean} [isMac] - "Ctrl" means Command on macOS; "MacCtrl" is
   *     the Control key there.
   * @return {boolean}
   */
  static matches(shortcut, press, isMac = false) {
    if (!shortcut) {
      return false;
    }
    const parts = shortcut.split('+');
    const key = parts.pop();
    const want = {ctrl: false, alt: false, shift: false, meta: false};
    for (const modifier of parts) {
      if (modifier === 'Alt') {
        want.alt = true;
      } else if (modifier === 'Shift') {
        want.shift = true;
      } else if (modifier === 'Command' || (modifier === 'Ctrl' && isMac)) {
        want.meta = true;
      } else if (modifier === 'Ctrl' || modifier === 'MacCtrl') {
        want.ctrl = true;
      } else {
        return false;
      }
    }
    return want.ctrl === !!press.ctrlKey &&
      want.alt === !!press.altKey &&
      want.shift === !!press.shiftKey &&
      want.meta === !!press.metaKey &&
      KeyShortcut.keyName(press.key, press.code) === key;
  }
}
