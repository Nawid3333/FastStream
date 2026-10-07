// What a key shows is what it does, on every keyboard layout.
//
// The shortcuts are named by the character a key types (WebUtils.getKeyString): 'KeyZ' is
// the key that types z, 'Minus' the one that types -. They went by the key's place on a US
// keyboard, and on a German one the keys labelled Y and Z were swapped (Y seeked back 60 s,
// Z set 5x), the '-' key was dead and the 'ß' key took its binding. The welcome page and
// the options page name the keys by those characters.
//
// Here every default binding is pressed the way each layout types its character - the key
// it is on there, with the Shift or AltGr it takes - and has to come out as the binding;
// and keys that type something else must not come out as any default binding. The layouts
// are written out from their real key maps (Windows' kbdgr, kbdsg, kbdfr, kbduk, kbdsp,
// kbddv, kbdru and kbdus), only the characters the defaults use.

import {describe, expect, it} from 'vitest';

import {DefaultKeybinds} from '../../chrome/player/options/defaults/DefaultKeybinds.mjs';
import {WebUtils} from '../../chrome/player/utils/WebUtils.mjs';

/**
 * A keydown as Firefox reports it.
 * @param {{code: string, key: string, shift?: boolean, altGr?: boolean}} press
 * @param {boolean} [shift] - Shift held for the binding itself (Shift+Z).
 * @return {Object}
 */
function keydown(press, shift = false) {
  const altGr = !!press.altGr;
  return {
    code: press.code,
    key: press.key,
    shiftKey: !!press.shift || shift,
    // Windows reports AltGr as Control+Alt, and Firefox names it AltGraph too.
    ctrlKey: altGr,
    altKey: altGr,
    metaKey: false,
    getModifierState: (modifier) => modifier === 'AltGraph' && altGr,
  };
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const usLetter = (letter) => ({code: 'Key' + letter.toUpperCase(), key: letter});

/**
 * Each layout: how it types the characters the default bindings are named by. A missing
 * character is one the layout types only as a dead key (German `), or not at all.
 */
const LAYOUTS = {
  'US': {
    ...Object.fromEntries(LETTERS.map((l) => [l, usLetter(l)])),
    ...Object.fromEntries('0123456789'.split('').map((d) => [d, {code: 'Digit' + d, key: d}])),
    ',': {code: 'Comma', key: ','}, '.': {code: 'Period', key: '.'},
    '=': {code: 'Equal', key: '='}, '-': {code: 'Minus', key: '-'},
    '[': {code: 'BracketLeft', key: '['}, '`': {code: 'Backquote', key: '`'},
  },
  'UK': {
    ...Object.fromEntries(LETTERS.map((l) => [l, usLetter(l)])),
    ...Object.fromEntries('0123456789'.split('').map((d) => [d, {code: 'Digit' + d, key: d}])),
    ',': {code: 'Comma', key: ','}, '.': {code: 'Period', key: '.'},
    '=': {code: 'Equal', key: '='}, '-': {code: 'Minus', key: '-'},
    '[': {code: 'BracketLeft', key: '['}, '`': {code: 'Backquote', key: '`'},
  },
  'German': {
    ...Object.fromEntries(LETTERS.map((l) => [l, usLetter(l)])),
    'y': {code: 'KeyZ', key: 'y'}, 'z': {code: 'KeyY', key: 'z'},
    ...Object.fromEntries('0123456789'.split('').map((d) => [d, {code: 'Digit' + d, key: d}])),
    ',': {code: 'Comma', key: ','}, '.': {code: 'Period', key: '.'},
    '=': {code: 'Digit0', key: '=', shift: true}, '-': {code: 'Slash', key: '-'},
    '[': {code: 'Digit8', key: '[', altGr: true},
  },
  'Swiss German': {
    ...Object.fromEntries(LETTERS.map((l) => [l, usLetter(l)])),
    'y': {code: 'KeyZ', key: 'y'}, 'z': {code: 'KeyY', key: 'z'},
    ...Object.fromEntries('0123456789'.split('').map((d) => [d, {code: 'Digit' + d, key: d}])),
    ',': {code: 'Comma', key: ','}, '.': {code: 'Period', key: '.'},
    '=': {code: 'Digit0', key: '=', shift: true}, '-': {code: 'Slash', key: '-'},
    '[': {code: 'BracketLeft', key: '[', altGr: true},
  },
  'French': {
    ...Object.fromEntries(LETTERS.map((l) => [l, usLetter(l)])),
    'a': {code: 'KeyQ', key: 'a'}, 'q': {code: 'KeyA', key: 'q'},
    'z': {code: 'KeyW', key: 'z'}, 'w': {code: 'KeyZ', key: 'w'},
    'm': {code: 'Semicolon', key: 'm'},
    // The digits take Shift on AZERTY; unshifted the row types & é " ' ( - è _ ç à.
    ...Object.fromEntries('0123456789'.split('').map((d) => [d, {code: 'Digit' + d, key: d, shift: true}])),
    ',': {code: 'KeyM', key: ','}, '.': {code: 'Comma', key: '.', shift: true},
    '=': {code: 'Equal', key: '='}, '-': {code: 'Digit6', key: '-'},
    '[': {code: 'Digit5', key: '[', altGr: true},
  },
  'Spanish': {
    ...Object.fromEntries(LETTERS.map((l) => [l, usLetter(l)])),
    ...Object.fromEntries('0123456789'.split('').map((d) => [d, {code: 'Digit' + d, key: d}])),
    ',': {code: 'Comma', key: ','}, '.': {code: 'Period', key: '.'},
    '=': {code: 'Digit0', key: '=', shift: true}, '-': {code: 'Slash', key: '-'},
    '[': {code: 'BracketLeft', key: '[', altGr: true},
  },
  'Dvorak': {
    // The letters and the punctuation all move: the ',' key is US W, '.' US E, '-' US ',
    // '=' US ], '[' US -; the US , and . keys type w and v.
    ...Object.fromEntries([
      ['a', 'KeyA'], ['b', 'KeyN'], ['c', 'KeyI'], ['d', 'KeyH'], ['e', 'KeyD'], ['f', 'KeyY'],
      ['g', 'KeyU'], ['h', 'KeyJ'], ['i', 'KeyG'], ['j', 'KeyC'], ['k', 'KeyV'], ['l', 'KeyP'],
      ['m', 'KeyM'], ['n', 'KeyL'], ['o', 'KeyS'], ['p', 'KeyR'], ['q', 'KeyX'], ['r', 'KeyO'],
      ['s', 'Semicolon'], ['t', 'KeyK'], ['u', 'KeyF'], ['v', 'Period'], ['w', 'Comma'],
      ['x', 'KeyB'], ['y', 'KeyT'], ['z', 'Slash'],
    ].map(([l, code]) => [l, {code, key: l}])),
    ...Object.fromEntries('0123456789'.split('').map((d) => [d, {code: 'Digit' + d, key: d}])),
    ',': {code: 'KeyW', key: ','}, '.': {code: 'KeyE', key: '.'},
    '=': {code: 'BracketRight', key: '='}, '-': {code: 'Quote', key: '-'},
    '[': {code: 'Minus', key: '['}, '`': {code: 'Backquote', key: '`'},
  },
  'Russian': {
    // No Latin letters typed: the keys carry the Latin ones too, and keep their place.
    ...Object.fromEntries(LETTERS.map((l, i) => [l, {code: 'Key' + l.toUpperCase(), key: 'фисвуапршолдьтщзйкыегмцчня'[i]}])),
    ...Object.fromEntries('0123456789'.split('').map((d) => [d, {code: 'Digit' + d, key: d}])),
    ',': {code: 'Slash', key: ',', shift: true}, '.': {code: 'Slash', key: '.'},
    '=': {code: 'Equal', key: '='}, '-': {code: 'Minus', key: '-'},
  },
};

/** The character a binding's key is named by, for the keys a layout changes. */
const CHARACTERS = {
  'Comma': ',', 'Period': '.', 'Equal': '=', 'Minus': '-', 'BracketLeft': '[', 'Backquote': '`',
};

/**
 * The character a default binding is typed with, and whether Shift is part of it.
 * @param {string} binding - E.g. 'Shift+KeyZ', 'Digit5', 'Minus'.
 * @return {?{char: string, shift: boolean}} Null for keys every layout has in one place
 *   (arrows, Space, Backspace, Right Alt) or no key (None).
 */
function typedBy(binding) {
  const shift = binding.startsWith('Shift+');
  const name = binding.replace(/^Shift\+/, '');
  if (/^Key[A-Z]$/.test(name)) return {char: name.slice(3).toLowerCase(), shift};
  if (/^Digit\d$/.test(name)) return {char: name.slice(5), shift};
  if (CHARACTERS[name]) return {char: CHARACTERS[name], shift};
  return null;
}

const typedDefaults = Object.entries(DefaultKeybinds)
    .map(([action, binding]) => ({action, binding, typed: typedBy(binding)}))
    .filter(({typed}) => typed);

describe('every default shortcut, typed on each layout as its character', () => {
  it('covers the letters, digits and characters the defaults use', () => {
    expect(typedDefaults.length).toBeGreaterThan(40);
  });

  for (const [layout, keys] of Object.entries(LAYOUTS)) {
    it(`${layout}: the key that types it fires it`, () => {
      const wrong = [];
      for (const {action, binding, typed} of typedDefaults) {
        const press = keys[typed.char];
        if (!press) continue;
        const name = WebUtils.getKeyString(keydown(press, typed.shift));
        if (name !== binding) wrong.push(`${action} (${binding}): '${typed.char}' typed gives ${name}`);
      }
      expect(wrong).toEqual([]);
    });
  }

  it('only the dead key ` (German, Swiss German, French, Spanish) and Russian [ and ` cannot be typed', () => {
    const untypeable = [];
    for (const [layout, keys] of Object.entries(LAYOUTS)) {
      for (const {typed} of typedDefaults) {
        if (!keys[typed.char]) untypeable.push(`${layout} ${typed.char}`);
      }
    }
    expect([...new Set(untypeable)].sort()).toEqual([
      'French `', 'German `', 'Russian [', 'Russian `', 'Spanish `', 'Swiss German `',
    ].sort());
  });
});

describe('keys that type something else fire no default shortcut', () => {
  const bindings = new Set(Object.values(DefaultKeybinds));
  const others = {
    'German ß (US -)': {code: 'Minus', key: 'ß'},
    'German ü (US [)': {code: 'BracketLeft', key: 'ü'},
    'German ö (US ;)': {code: 'Semicolon', key: 'ö'},
    'German dead ´ (US =)': {code: 'Equal', key: 'Dead'},
    'German dead ^ (US `)': {code: 'Backquote', key: 'Dead'},
    'German @ (AltGr+Q)': {code: 'KeyQ', key: '@', altGr: true},
    'German € (AltGr+E)': {code: 'KeyE', key: '€', altGr: true},
    'German ! (Shift+1)': {code: 'Digit1', key: '!', shift: true},
    'French & (unshifted 1)': {code: 'Digit1', key: '&'},
    'French ù (US \')': {code: 'Quote', key: 'ù'},
    'Russian б (US ,)': {code: 'Comma', key: 'б'},
    'Russian х (US [)': {code: 'BracketLeft', key: 'х'},
    'Spanish ñ (US ;)': {code: 'Semicolon', key: 'ñ'},
    'Dvorak \' (US Q)': {code: 'KeyQ', key: '\''},
    'Dvorak / (US [)': {code: 'BracketLeft', key: '/'},
  };
  for (const [what, press] of Object.entries(others)) {
    it(what, () => {
      expect(bindings.has(WebUtils.getKeyString(keydown(press)))).toBe(false);
    });
  }
});

describe('keys every layout has in one place keep their names', () => {
  it('arrows, Space, Backspace, Right Alt, with their modifiers', () => {
    const named = (code, key, mods = {}) => WebUtils.getKeyString({code, key, shiftKey: false,
      ctrlKey: false, altKey: false, metaKey: false, ...mods});
    expect(named('ArrowLeft', 'ArrowLeft')).toBe('ArrowLeft');
    expect(named('ArrowUp', 'ArrowUp', {shiftKey: true})).toBe('Shift+ArrowUp');
    expect(named('Space', ' ')).toBe('Space');
    expect(named('Backspace', 'Backspace', {shiftKey: true})).toBe('Shift+Backspace');
    expect(named('AltRight', 'Alt', {altKey: true})).toBe('AltRight');
    expect(named('KeyZ', 'z', {ctrlKey: true})).toBe('Control+KeyZ');
    // A numpad digit is the digit, as upstream's issue 482 asked.
    expect(named('Numpad5', '5')).toBe('Digit5');
  });
});
