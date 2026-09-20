import {DefaultKeybinds, KeybindsWithModifiers} from './defaults/DefaultKeybinds.mjs';

// Everything about keybinds that needs no DOM, so it can be tested in Node and shared by
// the player (KeybindManager), the options page and the code that loads saved options.

/**
 * The layout version of the keybinds, saved with the options as `keybindsVersion`.
 *
 * mergeOptions() only fills keys that are missing, so a default that moves never reaches
 * options that already hold the old one, and nothing in the saved options says which
 * layout they were written for. The version says it, so a migration runs exactly once and
 * whatever the user chooses afterwards, including a choice that equals an old default,
 * stays put.
 *
 * 1: the layout before the percent seeks and speed presets (no version saved at all).
 * 2: percent seeks on Digit1-9, speed presets on R G B Q W A Y E H, and the six actions
 *    that used those letters moved to Shift+<letter>.
 */
export const KEYBINDS_VERSION = 2;

/** Percentages the Digit1-Digit9 keys jump to. */
export const SEEK_PERCENTS = [10, 20, 30, 40, 50, 60, 70, 80, 90];

/** Speeds the preset keys set. */
export const SPEED_PRESETS = [1, 2, 2.5, 3, 3.5, 4, 5, 8, 16];

/**
 * The plain-letter defaults that version 2 moved out of the way, by action.
 * A saved binding that still equals the old default is moved to the new one.
 */
export const MOVED_IN_VERSION_2 = {
  'WindowedFullscreen': 'KeyW',
  'NextChapter': 'KeyA',
  'PreviousVideo': 'KeyB',
  'FlipVideo': 'KeyE',
  'RotateVideo': 'KeyR',
  'ToggleVisualFilters': 'KeyQ',
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

/** Actions that only exist since version 2, so no saved options can hold a choice for them. */
export const ADDED_IN_VERSION_2 = [
  ...SEEK_PERCENTS.map(seekPercentAction),
  ...SPEED_PRESETS.map(speedPresetAction),
];

/**
 * The time a percent seek jumps to.
 * A live stream reports an infinite duration and a stream that has not loaded reports NaN;
 * neither is a place to seek to, and the currentTime setter throws on a non-finite value.
 * @param {number} duration - The duration in seconds.
 * @param {number} percent - The percentage, 0 to 100.
 * @return {number|null} The time in seconds, or null when there is nowhere to seek to.
 */
export function seekPercentTarget(duration, percent) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  return duration * percent / 100;
}

const RATE_EPSILON = 0.0001;

/**
 * Works out what pressing a speed preset does.
 *
 * Pressing a preset sets its speed. Pressing the same key again reverts to the speed that
 * was active just before that key took effect, remembered per key, falling back to 1x when
 * the preset was already active on its first press (a rate restored from an earlier
 * session, say). The speed is clamped to the largest rate the browser allows, which is 8
 * on Firefox, so there the 16x key gives 8x.
 *
 * @param {number} preset - The preset's speed.
 * @param {number} currentRate - The current playback rate.
 * @param {number} maxRate - The largest rate the browser allows.
 * @param {number|undefined} remembered - What this key remembered, if it has yet.
 * @return {{rate: number, remembered: (number|undefined)}} The rate to set, and what the key
 *   remembers from now on.
 */
export function applySpeedPreset(preset, currentRate, maxRate, remembered) {
  const target = Number.isFinite(maxRate) ? Math.min(preset, maxRate) : preset;

  if (Math.abs(currentRate - target) < RATE_EPSILON) {
    // A remembered speed that is the preset itself (the rate was put back to it by hand
    // after a revert) is nowhere to go back to, and taking it would leave the key doing
    // nothing; 1x is what a key with no memory falls back to as well.
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
 * Finds the actions a key string triggers.
 * An action listed in KeybindsWithModifiers also fires when extra modifiers are held.
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
  const modifiers = keyString.split('+');
  const baseKey = modifiers.pop();

  const results = [];
  for (const [action, value] of entries) {
    if (value === keyString) {
      results.push(action);
    } else if (withModifiers.includes(action) && typeof value === 'string') {
      const testModifiers = value.split('+');
      const testBase = testModifiers.pop();
      if (testBase === baseKey && testModifiers.every((mod) => modifiers.includes(mod))) {
        results.push(action);
      }
    }
  }
  return results;
}

/**
 * Finds keys that would trigger more than one action, which a press would then all fire.
 * @param {Object<string, string>} keybinds - Action to key string.
 * @return {Array<{key: string, actions: string[]}>} One entry per clash.
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
 * For each action that shares its key, the other actions it shares it with.
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

/**
 * The name the options page shows for an action.
 * @param {string} action - The keybind action name.
 * @return {string} The label.
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
  return action.replace(/([A-Z])/g, ' $1').trim();
}

/**
 * Whether typing here should not trigger a keybind: a text field, a text area, a select or
 * anything editable. Keys that open a menu or change a value belong to the field then;
 * digits typed into a number box must not jump the video.
 * @param {*} target - An event's target.
 * @return {boolean} True for an element the user types into.
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
 * Migrates saved keybinds to the current layout.
 *
 * Runs once per saved options: it is skipped when the options carry a keybindsVersion that
 * is current, and options that were never saved need nothing. A binding the user chose is
 * never overridden, and a migration never leaves one press firing two actions:
 * - a binding that still holds a plain-letter default version 2 moved is given the new one,
 *   unless another action already uses that, in which case it is left unbound;
 * - an action new in version 2 takes its default key only when no other action already
 *   uses it, otherwise it is left unbound.
 *
 * @param {Object} options - The saved options merged over the defaults; changed in place.
 * @param {Object|null} stored - The options as they were saved, before the defaults were
 *   filled in, or null when nothing was saved.
 * @return {Object} The same options, with keybindsVersion set.
 */
export function migrateKeybinds(options, stored) {
  if (!options || typeof options !== 'object') {
    return options;
  }

  const storedVersion = Number.isInteger(stored?.keybindsVersion) ? stored.keybindsVersion : 1;
  if (stored && storedVersion < KEYBINDS_VERSION && options.keybinds && typeof options.keybinds === 'object') {
    const saved = stored.keybinds && typeof stored.keybinds === 'object' ? stored.keybinds : {};
    const keybinds = options.keybinds;

    // Gives an action a key only if nothing else already answers to it.
    const assign = (action, key) => {
      const others = Object.entries(keybinds).filter(([name]) => name !== action);
      if (key !== 'None' && actionsForKey(key, others).length > 0) {
        console.info(`Keybind ${action} left unbound: ${key} is already taken`);
        keybinds[action] = 'None';
      } else {
        keybinds[action] = key;
      }
    };

    for (const [action, oldKey] of Object.entries(MOVED_IN_VERSION_2)) {
      if (saved[action] === oldKey) {
        assign(action, DefaultKeybinds[action]);
      }
    }

    for (const action of ADDED_IN_VERSION_2) {
      if (!Object.hasOwn(saved, action)) {
        assign(action, keybinds[action]);
      }
    }
  }

  // Never lowered: options saved by a newer build keep their version.
  options.keybindsVersion = Math.max(storedVersion, KEYBINDS_VERSION);
  return options;
}
