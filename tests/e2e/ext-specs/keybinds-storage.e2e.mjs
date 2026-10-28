// The keybind migration against the real installed extension, whose options live in
// chrome.storage.local rather than localStorage.
//
// getOptionsFromStorage once handed an unresolved promise to the migration, which skipped
// it without a word, so the migration never ran in the extension at all. Nothing noticed:
// the unit tests fed the migration plain objects, and the web specs read localStorage. This
// is the path that broke, driven the way the extension takes it.
//
// What each layout step moves is tests/unit/KeybindUtils.test.mjs's ("migrateKeybinds", "to
// version 3", "to version 4") and Keybinds.test.mjs's (Utils.getOptionsFromStorage, the same
// function as here, over a stored string). Three cases here walked those steps again over
// chrome.storage (version 2, version 3, a choice made after the migration); since
// 2026-10-13 they are Keybinds.test.mjs's, with the same stored options: the first case
// below already reads options of an earlier layout through chrome.storage, and the step it
// takes is no different there.

import {browser, expect} from '@wdio/globals';

import {KEYBINDS_VERSION} from '../../../chrome/player/options/KeybindUtils.mjs';

import {openExtensionPage} from '../extension-page.mjs';

const setStored = (options) => browser.execute((value) => new Promise((done) => {
  chrome.storage.local.set({options: value === null ? undefined : JSON.stringify(value)}, () => done(true));
}), options);

const clearStored = () => browser.execute(() => new Promise((done) => {
  chrome.storage.local.remove('options', () => done(true));
}));

const getStored = () => browser.execute(() => new Promise((done) => {
  chrome.storage.local.get('options', (result) => done(result.options ? JSON.parse(result.options) : null));
}));

const rowKey = (action) => browser.execute((selector) => {
  const box = document.querySelector(`${selector} .keybind-input`);
  return box ? box.dataset.key : null;
}, `.keybind-container[data-keybind="${action}"]`);

// What a profile held before the percent seeks and speed presets, with a binding of the
// user's own on a key that has since become a preset.
const legacy = {
  keybinds: {
    WindowedFullscreen: 'KeyW', NextChapter: 'KeyA', PreviousVideo: 'KeyB',
    FlipVideo: 'KeyV', RotateVideo: 'KeyR', ToggleVisualFilters: 'KeyQ',
    ResetPlaybackRate: 'KeyY',
  },
};

describe('keybinds saved by an earlier version, in chrome.storage', function() {
  after(async function() {
    await openExtensionPage('/player/options/index.html');
    await clearStored();
  });

  it('are migrated when the extension loads them', async function() {
    await openExtensionPage('/player/options/index.html');
    await setStored(legacy);

    const options = await browser.execute(() => new Promise((done) => {
      import('/player/utils/Utils.mjs')
          .then(({Utils}) => Utils.getOptionsFromStorage())
          .then(done, (e) => done({failed: String(e)}));
    }));

    expect(options.failed).toBeUndefined();
    expect(options.keybindsVersion).toBe(KEYBINDS_VERSION);
    expect(options.keybinds.WindowedFullscreen).toBe('Shift+KeyW');
    // Chapters are gone: the old binding is dropped.
    expect(options.keybinds.NextChapter).toBeUndefined();
    expect(options.keybinds.PreviousVideo).toBe('Shift+KeyB');
    expect(options.keybinds.RotateVideo).toBe('Shift+KeyR');
    // the video filters' key went with them (2026-10-10): a saved binding of it is dropped
    expect(options.keybinds.ToggleVisualFilters).toBeUndefined();
    // Not on its old default, so not moved.
    expect(options.keybinds.FlipVideo).toBe('KeyV');
    expect(options.keybinds.SpeedPreset3).toBe('KeyQ');
    expect(options.keybinds.SeekPercent50).toBe('Digit5');
    // The user's own binding wins over the new default that wanted the same key.
    expect(options.keybinds.ResetPlaybackRate).toBe('KeyY');
    expect(options.keybinds.SpeedPreset5).toBe('None');
  });

  it('are shown migrated on the options page, and saved with the layout version on change', async function() {
    await openExtensionPage('/player/options/index.html');
    await setStored(legacy);
    await openExtensionPage('/player/options/index.html');
    await browser.waitUntil(
        async () => browser.execute(() => document.querySelectorAll('.keybind-container').length > 0),
        {timeout: 30000, timeoutMsg: 'the keybind list never rendered'});

    expect(await rowKey('WindowedFullscreen')).toBe('Shift+KeyW');
    expect(await rowKey('SpeedPreset3_5')).toBe('KeyW');
    expect(await rowKey('ResetPlaybackRate')).toBe('KeyY');
    expect(await rowKey('SpeedPreset5')).toBe('None');
    expect(await browser.execute(() => document.querySelectorAll('.keybind-conflict').length)).toBe(0);

    // Nothing is written just by looking at the page.
    expect((await getStored()).keybindsVersion).toBeUndefined();

    await browser.execute(() => {
      const box = document.querySelector('.keybind-container[data-keybind="SeekPercent50"] .keybind-input');
      box.focus();
      box.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyU', key: 'u', bubbles: true, cancelable: true}));
    });
    await browser.waitUntil(async () => (await getStored())?.keybinds?.SeekPercent50 === 'KeyU',
        {timeout: 10000, timeoutMsg: 'the change was never saved to chrome.storage'});

    const saved = await getStored();
    expect(saved.keybindsVersion).toBe(KEYBINDS_VERSION);
    expect(saved.keybinds.WindowedFullscreen).toBe('Shift+KeyW');
    expect(saved.keybinds.ResetPlaybackRate).toBe('KeyY');
  });
});
