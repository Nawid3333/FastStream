import {describe, expect, it} from 'vitest';
import {KeyShortcut} from '../../chrome/background/KeyShortcut.mjs';

// Matches a key press a page cancelled against commands.getAll()'s shortcut
// strings, so the background can run the command Firefox did not. A false
// match runs a FastStream command on a key that is not FastStream's.

/**
 * @param {string} key - KeyboardEvent.key.
 * @param {string} code - KeyboardEvent.code.
 * @param {Object} [mods] - ctrlKey, altKey, shiftKey, metaKey.
 * @return {import('../../chrome/background/KeyShortcut.mjs').KeyPress}
 */
function press(key, code, mods = {}) {
  return {key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods};
}

const ctrlShift = {ctrlKey: true, shiftKey: true};

describe('keyName', () => {
  it('names letters and digits by the character, in upper case', () => {
    expect(KeyShortcut.keyName('U', 'KeyU')).toBe('U');
    expect(KeyShortcut.keyName('u', 'KeyU')).toBe('U');
    expect(KeyShortcut.keyName('7', 'Digit7')).toBe('7');
    expect(KeyShortcut.keyName('7', 'Numpad7')).toBe('7');
  });

  it('follows the layout: the German Z key is Z, wherever it sits', () => {
    expect(KeyShortcut.keyName('z', 'KeyY')).toBe('Z');
    expect(KeyShortcut.keyName('y', 'KeyZ')).toBe('Y');
  });

  it('falls back to the key position when the character is not Latin', () => {
    expect(KeyShortcut.keyName('г', 'KeyU')).toBe('U');
    expect(KeyShortcut.keyName('!', 'Digit1')).toBe('1');
    expect(KeyShortcut.keyName(';', 'Comma')).toBe('Comma');
  });

  it('uses the shortcut names for special keys', () => {
    expect(KeyShortcut.keyName(' ', 'Space')).toBe('Space');
    expect(KeyShortcut.keyName(',', 'Comma')).toBe('Comma');
    expect(KeyShortcut.keyName('.', 'Period')).toBe('Period');
    expect(KeyShortcut.keyName('ArrowUp', 'ArrowUp')).toBe('Up');
    expect(KeyShortcut.keyName('PageDown', 'PageDown')).toBe('PageDown');
    expect(KeyShortcut.keyName('F5', 'F5')).toBe('F5');
    expect(KeyShortcut.keyName('F12', 'F12')).toBe('F12');
    expect(KeyShortcut.keyName('MediaTrackNext', '')).toBe('MediaNextTrack');
    expect(KeyShortcut.keyName('MediaTrackPrevious', '')).toBe('MediaPrevTrack');
  });

  it('has no name for a key no shortcut can use', () => {
    expect(KeyShortcut.keyName('Escape', 'Escape')).toBeNull();
    expect(KeyShortcut.keyName('Enter', 'Enter')).toBeNull();
    expect(KeyShortcut.keyName('Unidentified', '')).toBeNull();
  });
});

describe('matches', () => {
  it('matches the manifest defaults', () => {
    expect(KeyShortcut.matches('Ctrl+Shift+U', press('U', 'KeyU', ctrlShift))).toBe(true);
    expect(KeyShortcut.matches('Ctrl+Shift+F', press('F', 'KeyF', ctrlShift))).toBe(true);
  });

  it('wants the modifiers exactly, no more and no fewer', () => {
    // Ctrl+U is view-source, the key VOE's guard meant to block.
    expect(KeyShortcut.matches('Ctrl+Shift+U', press('u', 'KeyU', {ctrlKey: true}))).toBe(false);
    expect(KeyShortcut.matches('Ctrl+Shift+U',
        press('U', 'KeyU', {...ctrlShift, altKey: true}))).toBe(false);
    expect(KeyShortcut.matches('Ctrl+Shift+U',
        press('U', 'KeyU', {...ctrlShift, metaKey: true}))).toBe(false);
    expect(KeyShortcut.matches('Ctrl+Shift+U', press('U', 'KeyU', {shiftKey: true}))).toBe(false);
  });

  it('wants the same key', () => {
    expect(KeyShortcut.matches('Ctrl+Shift+U', press('I', 'KeyI', ctrlShift))).toBe(false);
  });

  it('matches a rebound shortcut', () => {
    expect(KeyShortcut.matches('Alt+Shift+U', press('U', 'KeyU', {altKey: true, shiftKey: true})))
        .toBe(true);
    // The MPV key's default since 2026-10-04, and not the player's Ctrl+Shift+F.
    expect(KeyShortcut.matches('Alt+F', press('f', 'KeyF', {altKey: true}))).toBe(true);
    expect(KeyShortcut.matches('Alt+F', press('F', 'KeyF', ctrlShift))).toBe(false);
    expect(KeyShortcut.matches('Alt+F', press('F', 'KeyF', {altKey: true, shiftKey: true}))).toBe(false);
    expect(KeyShortcut.matches('Ctrl+Comma', press(',', 'Comma', {ctrlKey: true}))).toBe(true);
    expect(KeyShortcut.matches('Alt+Up', press('ArrowUp', 'ArrowUp', {altKey: true}))).toBe(true);
    expect(KeyShortcut.matches('F5', press('F5', 'F5'))).toBe(true);
    expect(KeyShortcut.matches('Ctrl+Shift+1', press('!', 'Digit1', ctrlShift))).toBe(true);
  });

  it('never matches an unset shortcut or one it cannot read', () => {
    expect(KeyShortcut.matches('', press('U', 'KeyU', ctrlShift))).toBe(false);
    expect(KeyShortcut.matches('Hyper+U', press('U', 'KeyU'))).toBe(false);
  });

  it('reads Ctrl as Command on macOS, and MacCtrl as Control', () => {
    const command = press('U', 'KeyU', {metaKey: true, shiftKey: true});
    expect(KeyShortcut.matches('Ctrl+Shift+U', command, true)).toBe(true);
    expect(KeyShortcut.matches('Ctrl+Shift+U', command, false)).toBe(false);
    expect(KeyShortcut.matches('Command+Shift+U', command, true)).toBe(true);
    expect(KeyShortcut.matches('MacCtrl+Shift+U', press('U', 'KeyU', ctrlShift), true)).toBe(true);
    expect(KeyShortcut.matches('Ctrl+Shift+U', press('U', 'KeyU', ctrlShift), true)).toBe(false);
  });
});
