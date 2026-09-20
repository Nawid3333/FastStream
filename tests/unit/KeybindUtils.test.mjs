import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DefaultKeybinds} from '../../chrome/player/options/defaults/DefaultKeybinds.mjs';
import {
  ADDED_IN_VERSION_2, KEYBINDS_VERSION, MOVED_IN_VERSION_2, SEEK_PERCENTS, SPEED_PRESETS,
  actionsForKey, applySpeedPreset, conflictPartners, findKeybindConflicts, isTextEntryTarget,
  keybindLabel, migrateKeybinds, seekPercentAction, seekPercentTarget, speedPresetAction,
} from '../../chrome/player/options/KeybindUtils.mjs';

// Pure keybind logic. Nothing here can be seen in a browser until someone presses the
// key, and a wrong answer is silent: a jump to the wrong place, a speed that does not
// revert, two actions on one key.

describe('action names', () => {
  it('names the percent seeks and the speed presets the way DefaultKeybinds does', () => {
    expect(seekPercentAction(50)).toBe('SeekPercent50');
    expect(speedPresetAction(1)).toBe('SpeedPreset1');
    expect(speedPresetAction(2.5)).toBe('SpeedPreset2_5');
    expect(speedPresetAction(16)).toBe('SpeedPreset16');
    for (const action of ADDED_IN_VERSION_2) {
      expect(DefaultKeybinds).toHaveProperty(action);
    }
    expect(ADDED_IN_VERSION_2).toHaveLength(SEEK_PERCENTS.length + SPEED_PRESETS.length);
  });
});

describe('seekPercentTarget', () => {
  it('scales the duration', () => {
    expect(seekPercentTarget(100, 50)).toBe(50);
    expect(seekPercentTarget(200, 10)).toBe(20);
    expect(seekPercentTarget(3661.5, 90)).toBeCloseTo(3295.35, 5);
  });

  it('has nowhere to go without a finite, positive duration', () => {
    // A live stream reports Infinity, and the currentTime setter throws on that.
    for (const duration of [Infinity, -Infinity, NaN, 0, -5, undefined, null]) {
      expect(seekPercentTarget(duration, 50)).toBeNull();
    }
  });
});

describe('applySpeedPreset', () => {
  // A client with a playback rate and a per-key memory, as KeybindManager keeps them.
  const player = (rate = 1, maxRate = 16) => {
    const state = {rate, memory: {}};
    state.press = (preset) => {
      const key = speedPresetAction(preset);
      const result = applySpeedPreset(preset, state.rate, maxRate, state.memory[key]);
      state.memory[key] = result.remembered;
      state.rate = result.rate;
      return state.rate;
    };
    return state;
  };

  it('sets the speed, and the same key again reverts to what it replaced', () => {
    const p = player();
    expect(p.press(3)).toBe(3);
    expect(p.press(3)).toBe(1);
    expect(p.press(3)).toBe(3);
  });

  it('remembers per key: 3x, 5x, 5x again lands on 3x, not 1x', () => {
    const p = player();
    expect(p.press(3)).toBe(3);
    expect(p.press(5)).toBe(5);
    expect(p.press(5)).toBe(3);
  });

  it('keeps one memory per key, not one shared slot: 3x, 5x, 5x, then 3x again returns to 1x', () => {
    // A single shared "previous speed" would answer 3x or 5x here; the 3x key remembers
    // the 1x it replaced, whatever the other keys did in between.
    const p = player();
    p.press(3);
    p.press(5);
    expect(p.press(5)).toBe(3);
    expect(p.press(3)).toBe(1);
  });

  it('gives each key its own memory: 4x remembers the 3x it replaced', () => {
    const p = player();
    p.press(3);
    expect(p.press(4)).toBe(4);
    expect(p.press(4)).toBe(3);
    expect(p.press(3)).toBe(1);
  });

  it('reverts to 1x when the preset is already active on the first press', () => {
    const p = player(3);
    expect(p.press(3)).toBe(1);
  });

  it('does nothing for the 1x preset at 1x', () => {
    const p = player(1);
    expect(p.press(1)).toBe(1);
    expect(p.memory).toEqual({SpeedPreset1: undefined});
  });

  it('treats a rate adjusted by hand as whatever the next revert returns to', () => {
    const p = player();
    p.press(3);
    p.rate = 1.7;
    expect(p.press(5)).toBe(5);
    expect(p.press(5)).toBe(1.7);
  });

  it('is not left dead when the rate is put back to the preset by hand', () => {
    const p = player();
    p.press(3);
    p.press(3);
    expect(p.memory.SpeedPreset3).toBe(3);
    p.rate = 3;
    expect(p.press(3)).toBe(1);
    expect(p.press(3)).toBe(3);
  });

  it('is not fooled by rounding in a rate that was stored and read back', () => {
    const p = player(2.5000000001);
    expect(p.press(2.5)).toBe(1);
    const q = player(2.99995);
    expect(q.press(3)).toBe(1);
  });

  it('clamps to the largest rate the browser allows', () => {
    const firefox = player(1, 8);
    expect(firefox.press(16)).toBe(8);
    expect(firefox.press(16)).toBe(1);

    // On Firefox 16x and 8x are the same speed, so the second key finds it active.
    const both = player(1, 8);
    both.press(16);
    expect(both.press(8)).toBe(1);
  });

  it('does not clamp when the largest rate is unknown', () => {
    for (const maxRate of [undefined, NaN, null]) {
      expect(applySpeedPreset(16, 1, maxRate, undefined).rate).toBe(16);
    }
  });
});

describe('actionsForKey', () => {
  it('finds the action bound to exactly that key string', () => {
    expect(actionsForKey('Shift+KeyW', DefaultKeybinds)).toEqual(['WindowedFullscreen']);
    expect(actionsForKey('KeyW', DefaultKeybinds)).toEqual(['SpeedPreset3_5']);
    expect(actionsForKey('Digit5', DefaultKeybinds)).toEqual(['SeekPercent50']);
    expect(actionsForKey('KeyK', DefaultKeybinds)).toEqual([]);
  });

  it('takes a map, a list of entries or an object alike', () => {
    const object = {A: 'KeyA', B: 'KeyB'};
    expect(actionsForKey('KeyB', object)).toEqual(['B']);
    expect(actionsForKey('KeyB', Object.entries(object))).toEqual(['B']);
    expect(actionsForKey('KeyB', new Map(Object.entries(object)))).toEqual(['B']);
  });

  it('lets an action that ignores extra modifiers match with them held', () => {
    const keybinds = {SaveVideo: 'KeyD', Other: 'KeyG'};
    expect(actionsForKey('KeyD', keybinds)).toEqual(['SaveVideo']);
    expect(actionsForKey('Shift+KeyD', keybinds)).toEqual(['SaveVideo']);
    expect(actionsForKey('Control+Shift+KeyD', keybinds)).toEqual(['SaveVideo']);
    // ... but only for that action, and only on the same base key.
    expect(actionsForKey('Shift+KeyG', keybinds)).toEqual([]);
    expect(actionsForKey('Shift+KeyE', keybinds)).toEqual([]);
  });

  it('does not match a bare key against a binding that needs a modifier', () => {
    expect(actionsForKey('KeyW', {A: 'Shift+KeyW'})).toEqual([]);
    expect(actionsForKey('Shift+KeyW', {A: 'KeyW'})).toEqual([]);
  });

  it('survives a value that is not a string', () => {
    expect(actionsForKey('KeyA', {SaveVideo: 5, B: null})).toEqual([]);
  });
});

describe('findKeybindConflicts and conflictPartners', () => {
  it('finds none in the defaults', () => {
    expect(findKeybindConflicts(DefaultKeybinds)).toEqual([]);
    expect(conflictPartners(DefaultKeybinds).size).toBe(0);
  });

  it('finds two actions on one key, and each one names the other', () => {
    const keybinds = {...DefaultKeybinds, Mute: 'KeyQ'};
    const clashes = findKeybindConflicts(keybinds);
    expect(clashes).toHaveLength(1);
    expect(clashes[0].key).toBe('KeyQ');
    expect([...clashes[0].actions].sort()).toEqual(['Mute', 'SpeedPreset3']);

    const partners = conflictPartners(keybinds);
    expect(partners.get('Mute')).toEqual(['SpeedPreset3']);
    expect(partners.get('SpeedPreset3')).toEqual(['Mute']);
    expect(partners.has('Fullscreen')).toBe(false);
  });

  it('lists three on one key as one clash', () => {
    const keybinds = {A: 'KeyQ', B: 'KeyQ', C: 'KeyQ', D: 'KeyR'};
    expect(findKeybindConflicts(keybinds)).toHaveLength(1);
    expect(conflictPartners(keybinds).get('A')).toEqual(['B', 'C']);
  });

  it('ignores unbound actions, however many there are', () => {
    expect(findKeybindConflicts({A: 'None', B: 'None', C: '', D: undefined})).toEqual([]);
  });

  it('counts a key that an action with loose modifiers also answers to', () => {
    const clashes = findKeybindConflicts({SaveVideo: 'KeyD', Other: 'Shift+KeyD'});
    expect(clashes).toHaveLength(1);
    expect([...clashes[0].actions].sort()).toEqual(['Other', 'SaveVideo']);
  });

  it('copes with nothing at all', () => {
    expect(findKeybindConflicts(undefined)).toEqual([]);
    expect(findKeybindConflicts(null)).toEqual([]);
    expect(findKeybindConflicts({})).toEqual([]);
  });
});

describe('keybindLabel', () => {
  it('reads out the percent seeks and speed presets', () => {
    expect(keybindLabel('SeekPercent10')).toBe('Seek to 10%');
    expect(keybindLabel('SeekPercent90')).toBe('Seek to 90%');
    expect(keybindLabel('SpeedPreset1')).toBe('Speed preset 1x');
    expect(keybindLabel('SpeedPreset2_5')).toBe('Speed preset 2.5x');
    expect(keybindLabel('SpeedPreset16')).toBe('Speed preset 16x');
  });

  it('spaces out every other name as before', () => {
    expect(keybindLabel('PlayPause')).toBe('Play Pause');
    expect(keybindLabel('SeekForwardLarge')).toBe('Seek Forward Large');
    expect(keybindLabel('HidePlayer')).toBe('Hide Player');
  });

  it('gives every default a label, and no two the same', () => {
    const labels = Object.keys(DefaultKeybinds).map(keybindLabel);
    expect(labels.every((label) => label.length > 0 && !/_|undefined/.test(label))).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('isTextEntryTarget', () => {
  const element = (tagName, extra = {}) => ({tagName, ...extra});

  it('is true where the user types', () => {
    expect(isTextEntryTarget(element('INPUT', {type: 'text'}))).toBe(true);
    expect(isTextEntryTarget(element('input', {type: 'number'}))).toBe(true);
    expect(isTextEntryTarget(element('INPUT', {type: 'search'}))).toBe(true);
    expect(isTextEntryTarget(element('INPUT', {type: 'url'}))).toBe(true);
    expect(isTextEntryTarget(element('INPUT', {type: 'password'}))).toBe(true);
    expect(isTextEntryTarget(element('INPUT'))).toBe(true);
    expect(isTextEntryTarget(element('TEXTAREA'))).toBe(true);
    expect(isTextEntryTarget(element('SELECT'))).toBe(true);
    expect(isTextEntryTarget(element('DIV', {isContentEditable: true}))).toBe(true);
  });

  it('is false for controls the keybinds should still reach', () => {
    for (const type of ['range', 'checkbox', 'radio', 'button', 'color', 'file']) {
      expect(isTextEntryTarget(element('INPUT', {type}))).toBe(false);
    }
    expect(isTextEntryTarget(element('VIDEO'))).toBe(false);
    expect(isTextEntryTarget(element('BUTTON'))).toBe(false);
    expect(isTextEntryTarget(element('DIV'))).toBe(false);
    expect(isTextEntryTarget(element('BODY'))).toBe(false);
  });

  it('is false for anything that is not an element', () => {
    for (const target of [null, undefined, 5, 'INPUT', {}]) {
      expect(isTextEntryTarget(target)).toBe(false);
    }
  });
});

describe('migrateKeybinds', () => {
  let info;
  beforeEach(() => {
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mergedOver = (saved) => {
    // What Utils.mergeOptions does with the keybinds: the defaults, overwritten by whatever was saved.
    return {keybinds: {...DefaultKeybinds, ...(saved.keybinds || {})}, keybindsVersion: KEYBINDS_VERSION};
  };
  const legacy = {
    WindowedFullscreen: 'KeyW', NextChapter: 'KeyA', PreviousVideo: 'KeyB',
    FlipVideo: 'KeyE', RotateVideo: 'KeyR', ToggleVisualFilters: 'KeyQ',
  };

  it('moves each plain-letter default of the old layout to the new one', () => {
    const stored = {keybinds: {...legacy}};
    const options = migrateKeybinds(mergedOver(stored), stored);
    for (const action of Object.keys(MOVED_IN_VERSION_2)) {
      expect(options.keybinds[action]).toBe(DefaultKeybinds[action]);
    }
    expect(options.keybindsVersion).toBe(KEYBINDS_VERSION);
    expect(findKeybindConflicts(options.keybinds)).toEqual([]);
  });

  it('gives the speed keys and percent seeks to a user who had none', () => {
    const stored = {keybinds: {...legacy}};
    const {keybinds} = migrateKeybinds(mergedOver(stored), stored);
    expect(keybinds.SpeedPreset3).toBe('KeyQ');
    expect(keybinds.SpeedPreset3_5).toBe('KeyW');
    expect(keybinds.SeekPercent50).toBe('Digit5');
  });

  it('leaves a binding the user chose alone, and unbinds the new default that clashes', () => {
    const stored = {keybinds: {...legacy, ResetPlaybackRate: 'KeyY', VolumeReset: 'KeyH', Mute: 'Digit5'}};
    const {keybinds} = migrateKeybinds(mergedOver(stored), stored);
    expect(keybinds.ResetPlaybackRate).toBe('KeyY');
    expect(keybinds.VolumeReset).toBe('KeyH');
    expect(keybinds.Mute).toBe('Digit5');
    expect(keybinds.SpeedPreset5).toBe('None');
    expect(keybinds.SpeedPreset16).toBe('None');
    expect(keybinds.SeekPercent50).toBe('None');
    expect(keybinds.SpeedPreset3).toBe('KeyQ');
    expect(findKeybindConflicts(keybinds)).toEqual([]);
  });

  it('leaves a moved action unbound when its new key is already the user\'s', () => {
    const stored = {keybinds: {...legacy, PlayPause: 'Shift+KeyW'}};
    const {keybinds} = migrateKeybinds(mergedOver(stored), stored);
    expect(keybinds.PlayPause).toBe('Shift+KeyW');
    expect(keybinds.WindowedFullscreen).toBe('None');
    expect(findKeybindConflicts(keybinds)).toEqual([]);
  });

  it('keeps a binding the user remapped away from the old default', () => {
    const stored = {keybinds: {...legacy, WindowedFullscreen: 'KeyV', FlipVideo: 'None', RotateVideo: 'Shift+KeyR'}};
    const {keybinds} = migrateKeybinds(mergedOver(stored), stored);
    expect(keybinds.WindowedFullscreen).toBe('KeyV');
    expect(keybinds.FlipVideo).toBe('None');
    expect(keybinds.RotateVideo).toBe('Shift+KeyR');
  });

  it('does nothing to options that carry the current version, whatever they hold', () => {
    // A user who set WindowedFullscreen back to plain W after the update, on purpose.
    const stored = {keybindsVersion: KEYBINDS_VERSION, keybinds: {...DefaultKeybinds, WindowedFullscreen: 'KeyW'}};
    const options = migrateKeybinds(mergedOver(stored), stored);
    expect(options.keybinds.WindowedFullscreen).toBe('KeyW');
    expect(options.keybinds.SpeedPreset3_5).toBe('KeyW');
  });

  it('is idempotent', () => {
    const stored = {keybinds: {...legacy, ResetPlaybackRate: 'KeyY'}};
    const once = migrateKeybinds(mergedOver(stored), stored);
    const savedAgain = structuredClone(once);
    const twice = migrateKeybinds(mergedOver(savedAgain), savedAgain);
    expect(twice).toEqual(once);
  });

  it('only stamps options that were never saved', () => {
    const options = migrateKeybinds(mergedOver({}), null);
    expect(options.keybinds).toEqual(DefaultKeybinds);
    expect(options.keybindsVersion).toBe(KEYBINDS_VERSION);
  });

  it('never lowers a version a newer build saved', () => {
    const stored = {keybindsVersion: KEYBINDS_VERSION + 1, keybinds: {...legacy}};
    const options = migrateKeybinds({...mergedOver(stored), keybindsVersion: KEYBINDS_VERSION + 1}, stored);
    expect(options.keybindsVersion).toBe(KEYBINDS_VERSION + 1);
    expect(options.keybinds.WindowedFullscreen).toBe('KeyW');
  });

  it('treats a version that is not a whole number as none', () => {
    for (const keybindsVersion of ['2', 2.5, null, NaN, {}]) {
      const stored = {keybindsVersion, keybinds: {...legacy}};
      const options = migrateKeybinds(mergedOver(stored), stored);
      expect(options.keybinds.WindowedFullscreen).toBe('Shift+KeyW');
    }
  });

  it('copes with saved keybinds that are missing or not an object', () => {
    for (const keybinds of [undefined, null, 'KeyW', 5, [], true]) {
      const stored = {keybinds};
      const options = migrateKeybinds({keybinds: {...DefaultKeybinds}, keybindsVersion: KEYBINDS_VERSION}, stored);
      expect(options.keybinds).toEqual(DefaultKeybinds);
    }
  });

  it('does not depend on unknown actions or on an inherited property', () => {
    const stored = JSON.parse('{"keybinds": {"NoSuchAction": "KeyQ", "__proto__": {"WindowedFullscreen": "KeyW"}}}');
    const options = migrateKeybinds(mergedOver({}), stored);
    expect(options.keybinds.WindowedFullscreen).toBe('Shift+KeyW');
    expect(options.keybinds).not.toHaveProperty('NoSuchAction');
    expect({}.WindowedFullscreen).toBeUndefined();
  });

  it('logs what it left unbound, and only that', () => {
    const stored = {keybinds: {...legacy, ResetPlaybackRate: 'KeyY'}};
    migrateKeybinds(mergedOver(stored), stored);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain('SpeedPreset5');
  });

  it('passes through anything that is not options', () => {
    expect(migrateKeybinds(null, null)).toBeNull();
    expect(migrateKeybinds(undefined, {})).toBeUndefined();
    expect(migrateKeybinds({}, {}).keybindsVersion).toBe(KEYBINDS_VERSION);
  });
});
