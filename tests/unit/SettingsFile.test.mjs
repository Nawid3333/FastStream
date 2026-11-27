import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {DefaultOptions} from '../../chrome/player/options/defaults/DefaultOptions.mjs';
import {DefaultKeybinds} from '../../chrome/player/options/defaults/DefaultKeybinds.mjs';
import {KEYBINDS_VERSION, findKeybindConflicts, migrateKeybinds} from '../../chrome/player/options/KeybindUtils.mjs';
import {holdImportedNumbers, importedForMigration, settingsForExport} from '../../chrome/player/options/SettingsFile.mjs';
import {Utils} from '../../chrome/player/utils/Utils.mjs';

// The options page's settings file:
// - the export wrote the mpv path, which names the Windows account, into a file meant to be
//   shared, though the import never takes it;
// - an imported keybindsVersion above this build's was kept, and no later layout change was
//   ever applied to that user's keys;
// - an imported number only had to be a number: -5 GB of RAM, an Infinity of buffer, a zoom of
//   1e9 went in as they were.

describe('settingsForExport', () => {
  it('leaves out the mpv path, and nothing else', () => {
    const saved = {mpvPath: 'C:\\Users\\example\\mpv\\mpv.exe', ramBudget: 5, keybinds: {PlayPause: 'Space'}};
    expect(settingsForExport(saved)).toEqual({ramBudget: 5, keybinds: {PlayPause: 'Space'}});
    expect(saved.mpvPath).toBeDefined();
  });

  it('is what the options page exports', () => {
    const page = fs.readFileSync(new URL('../../chrome/player/options/options.mjs', import.meta.url), 'utf8');
    expect(page).toMatch(/\.\.\.settingsForExport\(await Utils\.getOptionsFromStorage\(\)\)/);
    expect(page).toMatch(/newOptionsObj = importedForMigration\(newOptionsObj\);\n\s+const newOptions =/);
    expect(page).toMatch(/holdToFields\(newOptions\);\n\s+holdImportedNumbers\(newOptions\);/);
  });
});

describe('importedForMigration', () => {
  it('takes a layout version above this build\'s as this build\'s, so later changes still apply', () => {
    const file = {keybindsVersion: 1e9, keybinds: {}};
    const merged = migrateKeybinds(Utils.mergeOptions(DefaultOptions, importedForMigration(file)), importedForMigration(file));
    expect(merged.keybindsVersion).toBe(KEYBINDS_VERSION);
    expect(file.keybindsVersion).toBe(1e9);
    expect(importedForMigration({keybindsVersion: 2}).keybindsVersion).toBe(2);
    // JSON's 1e999, and NaN, which no file gives but a number is.
    expect(importedForMigration(JSON.parse('{"keybindsVersion": 1e999}')).keybindsVersion).toBe(KEYBINDS_VERSION);
    expect(importedForMigration({keybindsVersion: NaN}).keybindsVersion).toBe(KEYBINDS_VERSION);
  });
});

describe('holdImportedNumbers', () => {
  it('keeps what the fields can save, and puts the default in for anything else', () => {
    const options = {...DefaultOptions, videoZoom: 1e9, videoDelay: -Infinity};
    holdImportedNumbers(options);
    expect(options).toMatchObject({videoZoom: 2, videoDelay: 0});
  });

  it('keeps a buffer only for one of the settings steps, an hour at most', () => {
    for (const [given, held] of [[3600, 3600], [0, 0], [60, 60], [86400, 20], [-1, 20], ['300', 20], [null, 20]]) {
      const options = {...DefaultOptions, bufferKeep: given};
      holdImportedNumbers(options);
      expect(options.bufferKeep, String(given)).toBe(held);
    }
  });

  it('leaves a sound file as it is', () => {
    const options = {...DefaultOptions, videoZoom: 0.5, videoDelay: -250};
    holdImportedNumbers(options);
    expect(options).toMatchObject({videoZoom: 0.5, videoDelay: -250});
  });
});

describe('a settings file through export and import', () => {
  // The options page's import, step by step (options.mjs, the import button's change handler).
  const importFile = (text) => {
    const file = importedForMigration(JSON.parse(text));
    return Utils.migrateClickActions(Utils.migrateSizes(Utils.migrateKeybinds(
        Utils.mergeOptions(DefaultOptions, file), file), file), file);
  };
  const exportOptions = (options) => JSON.stringify(settingsForExport(options), null, 2);
  // Saved options of this build: the defaults, at this layout version.
  const current = (keybinds = {}) => ({...DefaultOptions, keybindsVersion: KEYBINDS_VERSION,
    keybinds: {...DefaultKeybinds, ...keybinds}});
  // A file exported before SubtitleSyncTool existed: version 5, no such key.
  const beforeT = (keybinds = {}) => {
    const saved = {...DefaultKeybinds, ...keybinds};
    delete saved.SubtitleSyncTool;
    return JSON.stringify({...DefaultOptions, keybindsVersion: 5, keybinds: saved});
  };

  it('brings back every key as exported, the sync tool\'s own choice too', () => {
    for (const keybinds of [{}, {SubtitleSyncTool: 'Shift+KeyT', Mute: 'KeyT'}, {SubtitleSyncTool: 'None'}]) {
      const saved = current(keybinds);
      const exported = exportOptions(saved);
      expect(JSON.parse(exported).keybinds.SubtitleSyncTool).toBe(saved.keybinds.SubtitleSyncTool);
      const imported = importFile(exported);
      expect(imported.keybinds).toEqual(saved.keybinds);
      expect(imported.keybindsVersion).toBe(KEYBINDS_VERSION);
      expect(findKeybindConflicts(imported.keybinds)).toEqual([]);
    }
  });

  it('gives a file from before the sync key T, as an update gives saved options', () => {
    const {keybinds, keybindsVersion} = importFile(beforeT());
    expect(keybinds.SubtitleSyncTool).toBe('KeyT');
    expect(keybinds).toEqual(DefaultKeybinds);
    expect(keybindsVersion).toBe(KEYBINDS_VERSION);
  });

  it('keeps T where such a file put it, and leaves the sync key unbound', () => {
    const {keybinds} = importFile(beforeT({Mute: 'KeyT'}));
    expect(keybinds.Mute).toBe('KeyT');
    expect(keybinds.SubtitleSyncTool).toBe('None');
    expect(findKeybindConflicts(keybinds)).toEqual([]);
  });

  it('brings a file without a layout version to this one, with no clash', () => {
    const {keybinds, keybindsVersion} = importFile(JSON.stringify({keybinds: {PlayPause: 'Space', Mute: 'KeyM'}}));
    expect(keybinds.SubtitleSyncTool).toBe('KeyT');
    expect(keybindsVersion).toBe(KEYBINDS_VERSION);
    expect(findKeybindConflicts(keybinds)).toEqual([]);
  });
});
