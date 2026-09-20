import {describe, expect, it} from 'vitest';
import {DefaultKeybinds} from '../../chrome/player/options/defaults/DefaultKeybinds.mjs';
import {Utils} from '../../chrome/player/utils/Utils.mjs';

// The keybind defaults are user-facing: two actions on one key both fire on a
// press, and a stored option that still holds an old default keeps that key
// forever because mergeOptions only fills keys that are missing. Neither shows
// up anywhere until someone presses the key.

describe('DefaultKeybinds', () => {
  it('gives no two actions the same key', () => {
    const owners = new Map();
    for (const [action, key] of Object.entries(DefaultKeybinds)) {
      if (key === 'None') continue;
      owners.set(key, [...(owners.get(key) || []), action]);
    }
    const shared = [...owners].filter(([, actions]) => actions.length > 1);
    expect(shared).toEqual([]);
  });

  it('has a percent seek for every digit from 1 to 9 and a preset for every speed', () => {
    for (let digit = 1; digit <= 9; digit++) {
      expect(DefaultKeybinds[`SeekPercent${digit * 10}`]).toBe(`Digit${digit}`);
    }
    for (const preset of ['1', '2', '2_5', '3', '3_5', '4', '5', '8', '16']) {
      expect(DefaultKeybinds[`SpeedPreset${preset}`]).toMatch(/^Key[A-Z]$/);
    }
  });
});

describe('Utils.migrateKeybinds', () => {
  const oldDefaults = {
    WindowedFullscreen: 'KeyW',
    NextChapter: 'KeyA',
    PreviousVideo: 'KeyB',
    FlipVideo: 'KeyE',
    RotateVideo: 'KeyR',
    ToggleVisualFilters: 'KeyQ',
  };

  it('moves every binding that still holds an old default to its new default', () => {
    const migrated = Utils.migrateKeybinds({keybinds: {...oldDefaults}});
    for (const action of Object.keys(oldDefaults)) {
      expect(migrated.keybinds[action]).toBe(DefaultKeybinds[action]);
      expect(migrated.keybinds[action]).toMatch(/^Shift\+Key[A-Z]$/);
    }
  });

  it('leaves a binding the user chose themselves alone', () => {
    const mine = {WindowedFullscreen: 'KeyZ', NextChapter: 'None', FlipVideo: 'Shift+KeyE', PlayPause: 'KeyW'};
    const migrated = Utils.migrateKeybinds({keybinds: {...mine}});
    expect(migrated.keybinds).toEqual(mine);
  });

  it('does not touch options without keybinds', () => {
    expect(Utils.migrateKeybinds({volume: 1})).toEqual({volume: 1});
    expect(Utils.migrateKeybinds({keybinds: null})).toEqual({keybinds: null});
    expect(Utils.migrateKeybinds({keybinds: 'KeyW'})).toEqual({keybinds: 'KeyW'});
  });

  it('is safe to run again on options it has already migrated', () => {
    const once = Utils.migrateKeybinds({keybinds: {...oldDefaults}});
    const twice = Utils.migrateKeybinds(structuredClone(once));
    expect(twice).toEqual(once);
  });
});
