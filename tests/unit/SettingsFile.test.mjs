import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {DefaultOptions} from '../../chrome/player/options/defaults/DefaultOptions.mjs';
import {KEYBINDS_VERSION, migrateKeybinds} from '../../chrome/player/options/KeybindUtils.mjs';
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
    const options = {...DefaultOptions, ramBudget: -5e9, bufferAhead: Infinity, bufferBehind: 12.7, maxSpeed: -1,
      maxVideoSize: NaN, videoZoom: 1e9, videoDelay: -Infinity};
    holdImportedNumbers(options);
    expect(options).toMatchObject({ramBudget: DefaultOptions.ramBudget, bufferAhead: DefaultOptions.bufferAhead,
      bufferBehind: 12, maxSpeed: -1, maxVideoSize: DefaultOptions.maxVideoSize, videoZoom: 2, videoDelay: 0});
  });

  it('leaves a sound file as it is', () => {
    const options = {...DefaultOptions, ramBudget: 0, bufferAhead: -1, videoZoom: 0.5, videoDelay: -250};
    holdImportedNumbers(options);
    expect(options).toMatchObject({ramBudget: 0, bufferAhead: -1, videoZoom: 0.5, videoDelay: -250});
  });
});
