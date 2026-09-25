import fs from 'node:fs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DefaultKeybinds} from '../../chrome/player/options/defaults/DefaultKeybinds.mjs';
import {DefaultOptions} from '../../chrome/player/options/defaults/DefaultOptions.mjs';
import {
  FIXED_SEEKS, KEYBINDS_VERSION, MOVED_IN_VERSION_2, MOVED_IN_VERSION_3, SKIP_BUTTON_SECONDS, SEEK_PERCENTS,
  SPEED_PRESETS, actionsForKey, findKeybindConflicts, seekPercentAction, speedPresetAction,
} from '../../chrome/player/options/KeybindUtils.mjs';
import {Utils} from '../../chrome/player/utils/Utils.mjs';

// The keybind defaults are user-facing: two actions on one key both fire on a press, a
// default with no handler does nothing, and a stored option that still holds an old
// default keeps that key for good because mergeOptions only fills keys that are missing.
// None of it shows anywhere until someone presses the key.

describe('DefaultKeybinds', () => {
  it('gives every bound action a key that reaches that action and no other', () => {
    for (const [action, key] of Object.entries(DefaultKeybinds)) {
      if (key === 'None') continue;
      expect(actionsForKey(key, DefaultKeybinds), `${action} on ${key}`).toEqual([action]);
    }
  });

  it('has no clashes, counting the actions that also answer to extra modifiers', () => {
    expect(findKeybindConflicts(DefaultKeybinds)).toEqual([]);
  });

  it('puts the percent seeks on Digit1-9 and a preset on a letter for every speed', () => {
    for (let digit = 1; digit <= 9; digit++) {
      expect(DefaultKeybinds[`SeekPercent${digit * 10}`]).toBe(`Digit${digit}`);
    }
    const letters = SPEED_PRESETS.map((speed) => DefaultKeybinds[speedPresetAction(speed)]);
    expect(letters).toEqual(['KeyR', 'KeyG', 'KeyB', 'KeyQ', 'KeyW', 'KeyA', 'KeyY', 'KeyE', 'KeyH']);
  });

  it('moved the six actions the presets took letters from to Shift+<letter>', () => {
    for (const [action, oldKey] of Object.entries(MOVED_IN_VERSION_2)) {
      expect(DefaultKeybinds[action]).toBe(`Shift+${oldKey}`);
    }
  });

  it('has the mpv seeks: J/K 10 s, Z/X 60 s, undo on Shift+Backspace, screenshot on Shift+S', () => {
    expect(actionsForKey('KeyJ', DefaultKeybinds)).toEqual(['SeekBackward10s']);
    expect(actionsForKey('KeyK', DefaultKeybinds)).toEqual(['SeekForward10s']);
    expect(actionsForKey('KeyZ', DefaultKeybinds)).toEqual(['SeekBackward60s']);
    expect(actionsForKey('KeyX', DefaultKeybinds)).toEqual(['SeekForward60s']);
    expect(FIXED_SEEKS).toEqual({SeekBackward10s: -10, SeekForward10s: 10, SeekBackward60s: -60, SeekForward60s: 60});
    expect(DefaultKeybinds.SeekForward).toBe('ArrowRight');
    expect(DefaultOptions.seekStepSize).toBe(5);
    expect(SKIP_BUTTON_SECONDS).toBe(10);
    for (const [action, oldKey] of Object.entries(MOVED_IN_VERSION_3)) {
      expect(DefaultKeybinds[action]).not.toBe(oldKey);
    }
    expect(DefaultKeybinds.UndoSeek).toBe('Shift+Backspace');
    expect(DefaultKeybinds.Screenshot).toBe('Shift+KeyS');
    expect(actionsForKey('Period', DefaultKeybinds)).toEqual(['SeekForwardFrame']);
    expect(actionsForKey('Comma', DefaultKeybinds)).toEqual(['SeekBackwardFrame']);
    expect(DefaultKeybinds).not.toHaveProperty('SeekForwardLarge');
  });

  it('is what the options start from, at the current layout version', () => {
    expect(DefaultOptions.keybinds).toBe(DefaultKeybinds);
    expect(DefaultOptions.keybindsVersion).toBe(KEYBINDS_VERSION);
  });
});

describe('welcome page', () => {
  const html = fs.readFileSync(new URL('../../chrome/welcome.html', import.meta.url), 'utf8');
  const localeDir = new URL('../../chrome/_locales/', import.meta.url);
  const locales = fs.readdirSync(localeDir);

  it('names the keys the speed presets and percent seeks are on', () => {
    const letters = SPEED_PRESETS.map((speed) => DefaultKeybinds[speedPresetAction(speed)].replace('Key', '').toLowerCase());
    expect(html).toContain(`<code>${letters.join('/')}</code>`);
    expect(html).toContain('<code>0-9</code>');
  });

  it('names the keys the fixed seeks and undo are on', () => {
    const letters = (back, forward) => [back, forward].map((action) => DefaultKeybinds[action].replace('Key', '').toLowerCase()).join('/');
    expect(html).toContain(`<code>${letters('SeekBackward10s', 'SeekForward10s')}</code>`);
    expect(html).toContain(`<code>${letters('SeekBackward60s', 'SeekForward60s')}</code>`);
    expect(html).toContain(`<code>${DefaultKeybinds.UndoSeek}</code>`);
  });

  it('has text for every keybind line in every language', () => {
    const used = [...html.matchAll(/data-i18n="(welcome_page_keybinds_content\d+)"/g)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(10);
    expect(locales.length).toBeGreaterThanOrEqual(16);
    for (const locale of locales) {
      const messages = JSON.parse(fs.readFileSync(new URL(`${locale}/messages.json`, localeDir), 'utf8'));
      const missing = used.filter((key) => !messages[key]?.message);
      expect(missing, locale).toEqual([]);
    }
  });
});

describe('KeybindManager wiring', () => {
  // KeybindManager cannot be imported in Node (it touches the DOM at module scope), so
  // its source is read: an action with a default key and no handler does nothing at all,
  // and a handler for an action nothing can trigger is dead code.
  const source = fs.readFileSync(new URL('../../chrome/player/ui/KeybindManager.mjs', import.meta.url), 'utf8');
  const literal = [...source.matchAll(/this\.on\('([A-Za-z0-9_]+)'/g)].map((match) => match[1]);
  const generated = [...SEEK_PERCENTS.map(seekPercentAction), ...SPEED_PRESETS.map(speedPresetAction)];

  it('registers the generated handlers from the same lists the defaults use', () => {
    expect(source).toMatch(/for \(const percent of SEEK_PERCENTS\) \{\s*this\.on\(seekPercentAction\(percent\)/);
    expect(source).toMatch(/const action = speedPresetAction\(preset\);\s*this\.on\(action,/);
  });

  it('has a handler for every action that has a default key', () => {
    const handled = new Set([...literal, ...generated]);
    const missing = Object.keys(DefaultKeybinds).filter((action) => !handled.has(action));
    expect(missing).toEqual([]);
  });

  it('has no handler for an action that does not exist', () => {
    // 'keybind' is the event emitted for every press, not an action.
    const known = new Set([...Object.keys(DefaultKeybinds), 'keybind']);
    const dead = literal.filter((action) => !known.has(action));
    expect(dead).toEqual([]);
  });

  it('registers each handler once', () => {
    const twice = literal.filter((action, index) => literal.indexOf(action) !== index);
    expect(twice).toEqual([]);
  });
});

describe('Utils.getOptionsFromStorage', () => {
  // What a browser held before the percent seeks and speed presets, with a few choices made.
  const legacyBinds = {
    WindowedFullscreen: 'KeyW', NextChapter: 'KeyA', PreviousVideo: 'KeyB',
    FlipVideo: 'KeyE', RotateVideo: 'KeyR', ToggleVisualFilters: 'KeyQ',
  };
  let saved;
  let info;

  const store = (value) => {
    saved = value === undefined ? undefined : (typeof value === 'string' ? value : JSON.stringify(value));
  };
  // Saves what was loaded, the way OptionsStore does, and loads it again.
  const saveAndReload = async () => {
    store(await Utils.getOptionsFromStorage());
    return Utils.getOptionsFromStorage();
  };

  beforeEach(() => {
    store(undefined);
    vi.spyOn(Utils, 'getConfig').mockImplementation(async () => saved);
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves to the options themselves', async () => {
    // getOptionsFromStorage once passed an unresolved promise to the migration, which
    // skipped it without a word, so the migration never ran in the extension.
    const pending = Utils.getOptionsFromStorage();
    expect(pending).toBeInstanceOf(Promise);
    const options = await pending;
    expect(options).not.toBeInstanceOf(Promise);
    expect(options.keybinds).toEqual(DefaultKeybinds);
  });

  it('gives options that were never saved the defaults, stamped with the layout version', async () => {
    const options = await Utils.getOptionsFromStorage();
    expect(options.keybinds).toEqual(DefaultKeybinds);
    expect(options.keybindsVersion).toBe(KEYBINDS_VERSION);
  });

  it('migrates options saved before the version existed', async () => {
    store({volume: 1, keybinds: {...legacyBinds, PlayPause: 'KeyK'}});
    const {keybinds, keybindsVersion} = await Utils.getOptionsFromStorage();

    expect(keybindsVersion).toBe(KEYBINDS_VERSION);
    expect(keybinds.WindowedFullscreen).toBe('Shift+KeyW');
    expect(keybinds.ToggleVisualFilters).toBe('Shift+KeyQ');
    expect(keybinds.PlayPause).toBe('KeyK');
    expect(keybinds.SpeedPreset3).toBe('KeyQ');
    expect(keybinds.SeekPercent50).toBe('Digit5');
    expect(findKeybindConflicts(keybinds)).toEqual([]);
  });

  it('migrates options saved at version 2 to the mpv seeks and a 5 s arrow step', async () => {
    const v2 = {
      ...DefaultKeybinds, UndoSeek: 'KeyZ', Screenshot: 'KeyX',
      SeekForwardFrame: 'Shift+ArrowRight', SeekBackwardFrame: 'Shift+ArrowLeft',
      SeekForwardLarge: 'Period', SeekBackwardLarge: 'Comma',
    };
    for (const action of Object.keys(FIXED_SEEKS)) delete v2[action];
    store({keybindsVersion: 2, seekStepSize: 2, keybinds: v2});
    const options = await Utils.getOptionsFromStorage();
    expect(options.keybindsVersion).toBe(KEYBINDS_VERSION);
    expect(options.keybinds).toEqual(DefaultKeybinds);
    expect(options.seekStepSize).toBe(5);

    // Saved again and reloaded, it stays put.
    store(options);
    expect(await Utils.getOptionsFromStorage()).toEqual(options);
  });

  it('keeps what the user chose and unbinds the new default that would have clashed', async () => {
    store({keybinds: {...legacyBinds, ResetPlaybackRate: 'KeyY', Mute: 'Digit5'}});
    const {keybinds} = await Utils.getOptionsFromStorage();

    expect(keybinds.ResetPlaybackRate).toBe('KeyY');
    expect(keybinds.Mute).toBe('Digit5');
    expect(keybinds.SpeedPreset5).toBe('None');
    expect(keybinds.SeekPercent50).toBe('None');
    expect(info).toHaveBeenCalled();
    expect(findKeybindConflicts(keybinds)).toEqual([]);
  });

  it('migrates once: a choice made afterwards, even the old default, is kept', async () => {
    store({keybinds: {...legacyBinds}});
    const migrated = await saveAndReload();
    expect(migrated.keybinds.WindowedFullscreen).toBe('Shift+KeyW');

    // The user sets it back to plain W in the options page and saves.
    migrated.keybinds.WindowedFullscreen = 'KeyW';
    store(migrated);
    const after = await Utils.getOptionsFromStorage();
    expect(after.keybinds.WindowedFullscreen).toBe('KeyW');
  });

  it('is stable: saving what was loaded and loading it again changes nothing', async () => {
    store({keybinds: {...legacyBinds, ResetPlaybackRate: 'KeyY'}});
    const first = await Utils.getOptionsFromStorage();
    store(first);
    const second = await Utils.getOptionsFromStorage();
    store(second);
    const third = await Utils.getOptionsFromStorage();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('drops actions that no longer exist and fills those that are new', async () => {
    store({keybinds: {NoSuchAction: 'KeyZ', PlayPause: 'KeyK'}});
    const {keybinds} = await Utils.getOptionsFromStorage();
    expect(keybinds).not.toHaveProperty('NoSuchAction');
    expect(keybinds.PlayPause).toBe('KeyK');
    expect(Object.keys(keybinds).sort()).toEqual(Object.keys(DefaultKeybinds).sort());
  });

  it('survives anything unusable in storage', async () => {
    for (const bad of ['{not json', '[1, 2]', '5', 'null', '"text"', '']) {
      store(bad);
      const options = await Utils.getOptionsFromStorage();
      expect(options.keybinds).toEqual(DefaultKeybinds);
      expect(options.keybindsVersion).toBe(KEYBINDS_VERSION);
    }
  });

  it('cannot be poisoned through the saved keybinds', async () => {
    store('{"keybinds": {"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}}');
    const {keybinds} = await Utils.getOptionsFromStorage();
    expect({}.polluted).toBeUndefined();
    expect(keybinds.polluted).toBeUndefined();
    expect(keybinds).toEqual(DefaultKeybinds);
  });

  it('keeps a layout version that a newer build saved', async () => {
    store({keybindsVersion: KEYBINDS_VERSION + 1, keybinds: {...legacyBinds}});
    const options = await Utils.getOptionsFromStorage();
    expect(options.keybindsVersion).toBe(KEYBINDS_VERSION + 1);
    expect(options.keybinds.WindowedFullscreen).toBe('KeyW');
  });

  it('migrates an imported settings file the same way', () => {
    const imported = {keybinds: {...legacyBinds}, volume: 1};
    const options = Utils.migrateKeybinds(Utils.mergeOptions(DefaultOptions, imported), imported);
    expect(options.keybinds.WindowedFullscreen).toBe('Shift+KeyW');
    expect(options.keybinds.SpeedPreset3_5).toBe('KeyW');
    expect(options.keybindsVersion).toBe(KEYBINDS_VERSION);

    const current = {keybindsVersion: KEYBINDS_VERSION, keybinds: {...DefaultKeybinds, WindowedFullscreen: 'KeyV'}};
    const kept = Utils.migrateKeybinds(Utils.mergeOptions(DefaultOptions, current), current);
    expect(kept.keybinds.WindowedFullscreen).toBe('KeyV');
  });
});
