// @ts-check
import {DefaultKeybinds, KeybindsWithModifiers} from './defaults/DefaultKeybinds.mjs';

/**
 * @typedef {{keybinds?: Object<string, string>, keybindsVersion?: number, seekStepSize?: number}} SavedOptions
 */
// No DOM here, so it can be tested in Node.

/**
 * Saved as `keybindsVersion`: mergeOptions() only fills missing keys, so a moved default needs
 * a migration that runs exactly once. 1: none saved; 2: percent seeks and speed presets;
 * 3: mpv's seeks; 4: speed steps on S and D; 5: numpad keys renamed by what they do.
 */
export const KEYBINDS_VERSION = 6;

export const SKIP_BUTTON_SECONDS = 10;

export const DEFAULT_SEEK_STEP_SIZE = 5;

export const OLD_SEEK_STEP_SIZE = 2;

export const SEEK_PERCENTS = [10, 20, 30, 40, 50, 60, 70, 80, 90];

export const SPEED_PRESETS = [1, 2, 2.5, 3, 3.5, 4, 5, 8, 16];

// Firefox's limit for a media element; above 8x it plays no sound.
export const SILENT_MAX_PLAYBACK_RATE = 16;

/** By action, the old default a saved binding still equal to it is moved from. */
export const MOVED_IN_VERSION_2 = {
  'WindowedFullscreen': 'KeyW',
  'PreviousVideo': 'KeyB',
  'FlipVideo': 'KeyE',
  'RotateVideo': 'KeyR',
};

/**
 * @param {number} percent - One of SEEK_PERCENTS.
 * @return {string} The keybind action name.
 */
export function seekPercentAction(percent) {
  return `SeekPercent${percent}`;
}

/**
 * @param {number} speed - One of SPEED_PRESETS.
 * @return {string} The keybind action name, 2.5 becoming SpeedPreset2_5.
 */
export function speedPresetAction(speed) {
  return `SpeedPreset${String(speed).replace('.', '_')}`;
}

export const ADDED_IN_VERSION_2 = [
  ...SEEK_PERCENTS.map(seekPercentAction),
  ...SPEED_PRESETS.map(speedPresetAction),
];

export const MOVED_IN_VERSION_3 = {
  'UndoSeek': 'KeyZ',
  'Screenshot': 'KeyX',
  'SeekForwardFrame': 'Shift+ArrowRight',
  'SeekBackwardFrame': 'Shift+ArrowLeft',
};

export const FIXED_SEEKS = {
  'SeekBackward10s': -10,
  'SeekForward10s': 10,
  'SeekBackward60s': -60,
  'SeekForward60s': 60,
};

export const ADDED_IN_VERSION_3 = Object.keys(FIXED_SEEKS);

// Save video first, so D is free when the speed-up comes to it.
export const MOVED_IN_VERSION_4 = {
  'SaveVideo': 'KeyD',
  'IncreasePlaybackRate': 'Shift+ArrowUp',
  'DecreasePlaybackRate': 'Shift+ArrowDown',
};

// Numpad keys with NumLock off, once named by position.
export const RENAMED_IN_VERSION_5 = {
  'Numpad0': 'Insert', 'Numpad1': 'End', 'Numpad2': 'ArrowDown', 'Numpad3': 'PageDown',
  'Numpad4': 'ArrowLeft', 'Numpad5': 'Clear', 'Numpad6': 'ArrowRight', 'Numpad7': 'Home',
  'Numpad8': 'ArrowUp', 'Numpad9': 'PageUp', 'NumpadDecimal': 'Delete', 'NumpadEnter': 'Enter',
};

export const ADDED_IN_VERSION_6 = ['SubtitleSyncTool'];

// Oldest first. renamed applies to every saved binding.
const MIGRATIONS = [
  {version: 2, moved: MOVED_IN_VERSION_2, added: ADDED_IN_VERSION_2, renamed: {}},
  {version: 3, moved: MOVED_IN_VERSION_3, added: ADDED_IN_VERSION_3, renamed: {}},
  {version: 4, moved: MOVED_IN_VERSION_4, added: [], renamed: {}},
  {version: 5, moved: {}, added: [], renamed: RENAMED_IN_VERSION_5},
  {version: 6, moved: {}, added: ADDED_IN_VERSION_6, renamed: {}},
];

/**
 * @param {number} duration - Seconds.
 * @param {number} percent - 0 to 100.
 * @return {number|null} Null for a live or unloaded stream: currentTime throws on non-finite.
 */
export function seekPercentTarget(duration, percent) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  return duration * percent / 100;
}

const RATE_EPSILON = 0.0001;

/**
 * A press sets the preset; the same key again reverts to the speed before it (per key, else 1x).
 * @param {number} preset
 * @param {number} currentRate
 * @param {number} maxRate - The largest rate a preset may set.
 * @param {number|undefined} remembered - What this key remembered, if it has yet.
 * @return {{rate: number, remembered: (number|undefined)}}
 */
export function applySpeedPreset(preset, currentRate, maxRate, remembered) {
  const target = Number.isFinite(maxRate) ? Math.min(preset, maxRate) : preset;

  if (Math.abs(currentRate - target) < RATE_EPSILON) {
    // A remembered speed equal to the preset would leave the key doing nothing.
    const usable = remembered !== undefined && Math.abs(remembered - target) >= RATE_EPSILON;
    const previous = usable ? remembered : 1;
    if (Math.abs(currentRate - previous) >= RATE_EPSILON) {
      return {rate: previous, remembered: target};
    }
    return {rate: currentRate, remembered};
  }

  return {rate: target, remembered: currentRate};
}

/**
 * The key itself may be a typed '+' ('Control++'). The s flag makes every string match.
 * @param {string} keyString - As WebUtils.getKeyString builds it, e.g. 'Shift+KeyW'.
 * @return {{modifiers: string[], key: string}} key is '' when the string names none ('Shift+').
 */
function splitKeyString(keyString) {
  const match = /** @type {RegExpExecArray} */ (/^((?:(?:Meta|Control|Alt|Shift)\+)*)(.*)$/s.exec(keyString));
  return {modifiers: match[1] ? match[1].slice(0, -1).split('+') : [], key: match[2]};
}

/**
 * The longest key string is 48 characters; none holds a control character.
 * @param {*} value - A saved binding.
 * @return {boolean}
 */
export function isKeyString(value) {
  return typeof value === 'string' && value.length <= 64 && !/\p{Cc}/u.test(value);
}

/**
 * An action in KeybindsWithModifiers also fires when extra modifiers are held.
 * @param {string} keyString - As WebUtils.getKeyString builds it, e.g. 'Shift+KeyW'.
 * @param {Map<string, string>|Array<[string, string]>|Object<string, string>} keybinds - Action to
 *   key string, as a map, a list of entries or a plain object.
 * @param {string[]} [withModifiers] - Actions that ignore extra modifiers.
 * @return {string[]} The actions, in the order the keybinds list them.
 */
export function actionsForKey(keyString, keybinds, withModifiers = KeybindsWithModifiers) {
  let entries;
  if (keybinds instanceof Map) {
    entries = keybinds.entries();
  } else if (Array.isArray(keybinds)) {
    entries = keybinds;
  } else {
    entries = Object.entries(keybinds);
  }
  const {modifiers, key: baseKey} = splitKeyString(keyString);
  // A press with no key code names no key.
  if (!baseKey) {
    return [];
  }

  const results = [];
  for (const [action, value] of entries) {
    if (value === keyString) {
      results.push(action);
    } else if (withModifiers.includes(action) && typeof value === 'string') {
      const {modifiers: testModifiers, key: testBase} = splitKeyString(value);
      if (testBase === baseKey && testModifiers.every((mod) => modifiers.includes(mod))) {
        results.push(action);
      }
    }
  }
  return results;
}

/**
 * @param {Object<string, string>} keybinds - Action to key string.
 * @return {Array<{key: string, actions: string[]}>} One entry per key that fires several actions.
 */
export function findKeybindConflicts(keybinds) {
  const bound = Object.entries(keybinds || {}).filter(([, key]) => {
    return typeof key === 'string' && key !== '' && key !== 'None';
  });

  const clashes = new Map();
  for (const [, key] of bound) {
    const actions = actionsForKey(key, bound);
    if (actions.length > 1) {
      clashes.set([...actions].sort().join('|'), {key, actions});
    }
  }
  return [...clashes.values()];
}

/**
 * @param {Object<string, string>} keybinds - Action to key string.
 * @return {Map<string, string[]>} Only actions that clash appear.
 */
export function conflictPartners(keybinds) {
  const partners = new Map();
  for (const {actions} of findKeybindConflicts(keybinds)) {
    for (const action of actions) {
      partners.set(action, actions.filter((other) => other !== action));
    }
  }
  return partners;
}

/** @type {Object<string, string>} */
const KeyDisplayNames = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: '\'', Backquote: '`', Comma: ',', Period: '.', Slash: '/',
  AltLeft: 'Left Alt', AltRight: 'Right Alt', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', MetaLeft: 'Left Meta', MetaRight: 'Right Meta',
  Escape: 'Esc', Dead: 'Dead key',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .', NumpadEnter: 'Num Enter', NumpadEqual: 'Num =', NumLock: 'Num Lock',
  CapsLock: 'Caps Lock', ScrollLock: 'Scroll Lock', PageUp: 'Page Up', PageDown: 'Page Down',
  PrintScreen: 'Print Screen', ContextMenu: 'Menu',
};

/**
 * As pressed ("Shift+W", "[", "↑"), not as saved ("Shift+KeyW", "BracketLeft", "ArrowUp").
 * @param {string} keyString - The binding (WebUtils.getKeyString), or 'None'.
 * @param {string} [noneText] - What 'None' is shown as.
 * @return {string}
 */
export function keyDisplayName(keyString, noneText = 'None') {
  if (!keyString || keyString === 'None') {
    return noneText;
  }
  const split = splitKeyString(keyString);
  const modifiers = split.modifiers.map((m) => (m === 'Control' ? 'Ctrl' : m));
  const key = split.key;
  const named = /^Key([A-Z])$/.exec(key)?.[1] ?? /^Digit(\d)$/.exec(key)?.[1] ??
    (/^Numpad(\d)$/.test(key) ? 'Num ' + key.slice(6) : KeyDisplayNames[key] ?? key);
  return [...modifiers, named].join('+');
}

/**
 * @param {string} action
 * @return {string}
 */
export function keybindLabel(action) {
  const percent = /^SeekPercent(\d+)$/.exec(action);
  if (percent) {
    return `Seek to ${percent[1]}%`;
  }
  const preset = /^SpeedPreset(\d+(?:_\d+)?)$/.exec(action);
  if (preset) {
    return `Speed preset ${preset[1].replace('_', '.')}x`;
  }
  const fixed = /^Seek(Forward|Backward)(\d+)s$/.exec(action);
  if (fixed) {
    return `Seek ${fixed[1]} ${fixed[2]}s`;
  }
  return action.replace(/([A-Z])/g, ' $1').trim();
}

/**
 * @param {*} target - An event's target.
 * @return {boolean} True for an element the user types into: keys belong to it then.
 */
export function isTextEntryTarget(target) {
  if (!target || typeof target !== 'object') {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (tag === 'INPUT') {
    const type = String(target.type || 'text').toLowerCase();
    return ['text', 'search', 'number', 'url', 'email', 'password', 'tel'].includes(type);
  }
  return false;
}

/**
 * Applies each newer version in turn. A binding the user chose is never overridden, and one
 * press never fires two actions: a moved, added or renamed key already taken leaves it unbound.
 * @param {SavedOptions} options - The saved options merged over the defaults; changed in place.
 * @param {SavedOptions|null} stored - The options as they were saved, before the defaults were
 *   filled in, or null when nothing was saved.
 * @return {Object} The same options, with keybindsVersion set.
 */
export function migrateKeybinds(options, stored) {
  if (!options || typeof options !== 'object') {
    return options;
  }

  const storedVersion = Number.isInteger(stored?.keybindsVersion) ? /** @type {{keybindsVersion: number}} */ (stored).keybindsVersion : 1;
  if (stored && storedVersion < KEYBINDS_VERSION && options.keybinds && typeof options.keybinds === 'object') {
    const saved = stored.keybinds && typeof stored.keybinds === 'object' ? stored.keybinds : /** @type {Object<string, string>} */ ({});
    const keybinds = options.keybinds;

    /**
     * Only if no press would then fire it and another action (extra modifiers included).
     * @param {string} action
     * @param {string} key
     */
    const assign = (action, key) => {
      keybinds[action] = key;
      if (key !== 'None' && findKeybindConflicts(keybinds).some(({actions}) => actions.includes(action))) {
        console.info(`Keybind ${action} left unbound: ${key} is already taken`);
        keybinds[action] = 'None';
      }
    };

    for (const {version, moved, added, renamed} of MIGRATIONS) {
      if (storedVersion >= version) {
        continue;
      }
      for (const [action, key] of Object.entries(keybinds)) {
        const match = /^((?:(?:Meta|Control|Alt|Shift)\+)*)(.+)$/.exec(key);
        const newName = match && Object.hasOwn(renamed, match[2]) ? /** @type {Object<string, string>} */ (renamed)[match[2]] : null;
        if (match && newName) {
          assign(action, match[1] + newName);
        }
      }
      for (const [action, oldKey] of Object.entries(moved)) {
        if (saved[action] === oldKey) {
          assign(action, /** @type {Object<string, string>} */ (DefaultKeybinds)[action]);
        }
      }
      for (const action of added) {
        if (!Object.hasOwn(saved, action)) {
          assign(action, keybinds[action]);
        }
      }
    }
  }

  if (stored && storedVersion < 3 && stored.seekStepSize === OLD_SEEK_STEP_SIZE) {
    options.seekStepSize = DEFAULT_SEEK_STEP_SIZE;
  }

  // Never lowered: options saved by a newer build keep their version.
  options.keybindsVersion = Math.max(storedVersion, KEYBINDS_VERSION);
  return options;
}

/**
 * "2×", "2.5×"; 1.2000000000000002 shows as "1.2×".
 * @param {number} rate
 * @return {string}
 */
export function formatPlaybackRate(rate) {
  return `${Math.round(rate * 100) / 100}×`;
}

/**
 * Above the rate with sound, it says so.
 * @param {number} rate
 * @param {number} soundMax - The fastest rate with sound (options.maxPlaybackRate).
 * @param {string} noSound - The localized "no sound".
 * @return {string}
 */
export function describePlaybackRate(rate, soundMax, noSound) {
  return rate > soundMax + RATE_EPSILON ? `${formatPlaybackRate(rate)} · ${noSound}` : formatPlaybackRate(rate);
}
