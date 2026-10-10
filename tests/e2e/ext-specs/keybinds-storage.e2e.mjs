// The keybind migration against the real installed extension, whose options live in
// chrome.storage.local rather than localStorage.
//
// getOptionsFromStorage once handed an unresolved promise to the migration, which skipped
// it without a word, so the migration never ran in the extension at all. Nothing noticed:
// the unit tests fed the migration plain objects, and the web specs read localStorage. This
// is the path that broke, driven the way the extension takes it.

import {browser, expect} from '@wdio/globals';

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
    expect(options.keybindsVersion).toBe(4);
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
    expect(saved.keybindsVersion).toBe(4);
    expect(saved.keybinds.WindowedFullscreen).toBe('Shift+KeyW');
    expect(saved.keybinds.ResetPlaybackRate).toBe('KeyY');
  });

  it('moves options saved at version 2 to the mpv seeks and a 5 s arrow step', async function() {
    await openExtensionPage('/player/options/index.html');
    await setStored({keybindsVersion: 2, seekStepSize: 2, keybinds: {
      UndoSeek: 'KeyZ', Screenshot: 'KeyX', PlayPause: 'KeyK',
      SeekForwardFrame: 'Shift+ArrowRight', SeekBackwardFrame: 'Shift+ArrowLeft',
      SeekForwardLarge: 'Period', SeekBackwardLarge: 'Comma',
    }});

    const options = await browser.execute(() => new Promise((done) => {
      import('/player/utils/Utils.mjs')
          .then(({Utils}) => Utils.getOptionsFromStorage())
          .then(done, (e) => done({failed: String(e)}));
    }));
    expect(options.failed).toBeUndefined();
    expect(options.keybindsVersion).toBe(4);
    expect(options.seekStepSize).toBe(5);
    expect(options.keybinds.UndoSeek).toBe('Shift+Backspace');
    expect(options.keybinds.Screenshot).toBe('Shift+KeyS');
    expect(options.keybinds.SeekBackward60s).toBe('KeyZ');
    expect(options.keybinds.SeekForward60s).toBe('KeyX');
    expect(options.keybinds.SeekBackward10s).toBe('KeyJ');
    // K was the user's play/pause, so the 10 s seek forward waits for a key.
    expect(options.keybinds.PlayPause).toBe('KeyK');
    expect(options.keybinds.SeekForward10s).toBe('None');
    // The frame step takes `,`/`.` from the 10 s seeks, which no longer exist.
    expect(options.keybinds.SeekForwardFrame).toBe('Period');
    expect(options.keybinds.SeekBackwardFrame).toBe('Comma');
    expect(options.keybinds.SeekForwardLarge).toBeUndefined();
  });

  it('moves the speed steps saved at version 3 to S and D, and Save video to Shift+D', async function() {
    // As in mpv (2026-10-10). An S the user took keeps theirs: the slow-down waits for a key.
    await openExtensionPage('/player/options/index.html');
    await setStored({keybindsVersion: 3, keybinds: {
      SaveVideo: 'KeyD', IncreasePlaybackRate: 'Shift+ArrowUp', DecreasePlaybackRate: 'Shift+ArrowDown', Mute: 'KeyS',
    }});

    const options = await browser.executeAsync((done) => {
      import('/player/utils/Utils.mjs')
          .then(({Utils}) => Utils.getOptionsFromStorage())
          .then(done, (e) => done({failed: String(e)}));
    });
    expect(options.failed).toBeUndefined();
    expect(options.keybindsVersion).toBe(4);
    expect(options.keybinds.SaveVideo).toBe('Shift+KeyD');
    expect(options.keybinds.IncreasePlaybackRate).toBe('KeyD');
    expect(options.keybinds.Mute).toBe('KeyS');
    expect(options.keybinds.DecreasePlaybackRate).toBe('None');
  });

  it('keeps a choice made after the migration, even one equal to an old default', async function() {
    await openExtensionPage('/player/options/index.html');
    await setStored({keybindsVersion: 3, keybinds: {WindowedFullscreen: 'KeyW'}});

    const options = await browser.execute(() => new Promise((done) => {
      import('/player/utils/Utils.mjs')
          .then(({Utils}) => Utils.getOptionsFromStorage())
          .then(done, (e) => done({failed: String(e)}));
    }));
    expect(options.keybinds.WindowedFullscreen).toBe('KeyW');
    // Through the version 4 step (S and D), which does not touch it.
    expect(options.keybindsVersion).toBe(4);
  });
});
