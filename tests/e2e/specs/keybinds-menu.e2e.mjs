// Regression coverage for the keybinding menu on the options page.
//
// Guarded:
//
// - Every action is listed, under a readable name: "Seek to 50%" and "Speed preset 2.5x"
//   rather than the action name with a space put in front of each capital.
// - Two actions on one key are marked on both rows, each naming the other, and the mark
//   goes away when either is moved, unbound, or the defaults are restored.
// - What the page saves carries the layout version, so options that were migrated are not
//   migrated again over a choice made afterwards.
// - Options saved before the layout changed are shown migrated.

import {browser, expect} from '@wdio/globals';

const optionsPagePath = () => '/player/options/index.html?t=' + Date.now();

const row = (action) => `.keybind-container[data-keybind="${action}"]`;

async function openOptions() {
  await browser.url(optionsPagePath());
  await browser.waitUntil(
      async () => browser.execute(() => document.querySelectorAll('.keybind-container').length > 0),
      {timeout: 30000, timeoutMsg: 'the keybind list never rendered'});
}

// Presses a key in a row's box the way the page listens for it: a keydown on the box.
const assignKey = (action, code, {shift} = {}) => browser.execute((selector, code, shift) => {
  const box = document.querySelector(`${selector} .keybind-input`);
  const key = code.startsWith('Digit') ? code.slice(5) : code.slice(3).toLowerCase();
  box.focus();
  box.dispatchEvent(new KeyboardEvent('keydown', {code, key, shiftKey: shift, bubbles: true, cancelable: true}));
}, row(action), code, !!shift);

const rowState = (action) => browser.execute((selector) => {
  const container = document.querySelector(selector);
  if (!container) return null;
  const warning = container.querySelector('.keybind-warning');
  return {
    label: container.querySelector('.keybind-name').textContent,
    key: container.querySelector('.keybind-input').textContent,
    conflict: container.classList.contains('keybind-conflict'),
    warning: warning.hidden ? '' : warning.textContent,
  };
}, row(action));

const conflictCount = () => browser.execute(() => document.querySelectorAll('.keybind-conflict').length);

const savedOptions = () => browser.execute(() => JSON.parse(localStorage.getItem('options')));

// The page saves through OptionsStore, which does not finish before the click handler does.
const waitForSaved = (check) => browser.waitUntil(
    async () => {
      const saved = await savedOptions();
      return !!saved && check(saved);
    },
    {timeout: 10000, timeoutMsg: 'the options were never saved'});

const defaults = () => browser.executeAsync((done) => {
  import('/player/options/defaults/DefaultKeybinds.mjs').then((m) => done(m.DefaultKeybinds));
});

describe('Keybinding menu', function() {
  beforeEach(async function() {
    await openOptions();
    await browser.execute(() => localStorage.removeItem('options'));
    await openOptions();
  });

  after(async function() {
    await browser.execute(() => localStorage.removeItem('options'));
  });

  it('lists every action, with the default key next to it', async function() {
    const expected = await defaults();
    const shown = await browser.execute(() => {
      const keys = {};
      document.querySelectorAll('.keybind-container').forEach((container) => {
        keys[container.dataset.keybind] = container.querySelector('.keybind-input').textContent;
      });
      return keys;
    });
    expect(shown).toEqual(expected);
  });

  it('names every row from its action, never with a raw action name', async function() {
    const labels = await browser.executeAsync((done) => {
      import('/player/options/KeybindUtils.mjs').then(({keybindLabel}) => {
        done([...document.querySelectorAll('.keybind-container')].map((container) => ({
          action: container.dataset.keybind,
          shown: container.querySelector('.keybind-name').textContent,
          expected: keybindLabel(container.dataset.keybind),
        })));
      });
    });
    expect(labels.length).toBeGreaterThan(50);
    for (const {action, shown, expected} of labels) {
      // The action goes into the compared value so a failure says which row it was.
      expect([action, shown]).toEqual([action, expected]);
      expect(shown).not.toMatch(/_|undefined/);
    }
    expect(new Set(labels.map((label) => label.shown)).size).toBe(labels.length);
  });

  it('reads out the percent seeks and speed presets, and spaces the rest as before', async function() {
    expect((await rowState('SeekPercent50')).label).toBe('Seek to 50%');
    expect((await rowState('SeekPercent10')).label).toBe('Seek to 10%');
    expect((await rowState('SpeedPreset2_5')).label).toBe('Speed preset 2.5x');
    expect((await rowState('SpeedPreset16')).label).toBe('Speed preset 16x');
    expect((await rowState('PlayPause')).label).toBe('Play Pause');
    expect((await rowState('SeekForwardFrame')).label).toBe('Seek Forward Frame');
  });

  it('shows no clash for the defaults', async function() {
    expect(await conflictCount()).toBe(0);
    const visible = await browser.execute(() => document.querySelectorAll('.keybind-warning:not([hidden])').length);
    expect(visible).toBe(0);
  });

  it('marks both rows when two actions share a key, and names the other', async function() {
    await assignKey('Mute', 'KeyQ');

    const mute = await rowState('Mute');
    expect(mute.key).toBe('KeyQ');
    expect(mute.conflict).toBe(true);
    expect(mute.warning).toBe('Also used by Speed preset 3x');

    const preset = await rowState('SpeedPreset3');
    expect(preset.conflict).toBe(true);
    expect(preset.warning).toBe('Also used by Mute');

    expect((await rowState('Fullscreen')).conflict).toBe(false);
    expect(await conflictCount()).toBe(2);
  });

  it('marks a key that three actions share on all three', async function() {
    await assignKey('Mute', 'KeyQ');
    await assignKey('Fullscreen', 'KeyQ');
    expect(await conflictCount()).toBe(3);
    expect((await rowState('SpeedPreset3')).warning).toMatch(/^Also used by (Mute, Fullscreen|Fullscreen, Mute)$/);
  });

  it('clears the mark when one of the two is moved', async function() {
    await assignKey('Mute', 'KeyQ');
    await assignKey('Mute', 'KeyM');
    expect(await conflictCount()).toBe(0);
    expect((await rowState('SpeedPreset3')).warning).toBe('');
  });

  it('clears the mark when one of the two is unbound with Escape', async function() {
    await assignKey('Mute', 'KeyQ');
    await browser.execute((selector) => {
      const box = document.querySelector(`${selector} .keybind-input`);
      box.dispatchEvent(new KeyboardEvent('keydown', {code: 'Escape', key: 'Escape', bubbles: true, cancelable: true}));
    }, row('Mute'));

    expect((await rowState('Mute')).key).toBe('None');
    expect(await conflictCount()).toBe(0);
    await waitForSaved((saved) => saved.keybinds.Mute === 'None');
  });

  it('treats Shift+<key> as a different key from <key>', async function() {
    await assignKey('Mute', 'KeyQ', {shift: true});
    expect((await rowState('Mute')).key).toBe('Shift+KeyQ');
    // Shift+KeyQ is the default of ToggleVisualFilters, so this one does clash.
    expect((await rowState('Mute')).conflict).toBe(true);
    expect((await rowState('SpeedPreset3')).conflict).toBe(false);
  });

  it('restores the defaults, and the clash goes with them', async function() {
    await assignKey('Mute', 'KeyQ');
    await assignKey('SeekPercent50', 'KeyU');
    expect(await conflictCount()).toBe(2);

    await browser.execute(() => document.getElementById('resetdefault').click());

    expect(await conflictCount()).toBe(0);
    expect((await rowState('Mute')).warning).toBe('');
    expect((await rowState('SpeedPreset3')).warning).toBe('');
    expect(await browser.execute(() => document.querySelectorAll('.keybind-warning:not([hidden])').length)).toBe(0);
    expect((await rowState('Mute')).key).toBe('KeyM');
    expect((await rowState('SeekPercent50')).key).toBe('Digit5');

    const expected = Object.entries(await defaults()).sort();
    await waitForSaved((saved) => JSON.stringify(Object.entries(saved.keybinds).sort()) === JSON.stringify(expected));
    expect((await savedOptions()).keybindsVersion).toBe(3);
  });

  it('saves the choice with the layout version, and shows it again after a reload', async function() {
    await assignKey('SeekPercent50', 'KeyU');
    await waitForSaved((saved) => saved.keybinds.SeekPercent50 === 'KeyU');
    const saved = await savedOptions();
    expect(saved.keybindsVersion).toBe(3);

    await openOptions();
    expect((await rowState('SeekPercent50')).key).toBe('KeyU');
  });

  it('does not migrate again a choice made after the layout changed', async function() {
    // Old default, chosen on purpose, saved by a page that already knows the new layout.
    await assignKey('WindowedFullscreen', 'KeyW');
    await waitForSaved((saved) => saved.keybinds.WindowedFullscreen === 'KeyW');

    await openOptions();
    const state = await rowState('WindowedFullscreen');
    expect(state.key).toBe('KeyW');
    // It clashes with the W speed preset, which the page says rather than fixes.
    expect(state.conflict).toBe(true);
  });
});

describe('Keybinding menu with options saved before the layout changed', function() {
  const legacy = {
    keybinds: {
      WindowedFullscreen: 'KeyW', NextChapter: 'KeyA', PreviousVideo: 'KeyB',
      FlipVideo: 'KeyV', RotateVideo: 'KeyR', ToggleVisualFilters: 'KeyQ',
      ResetPlaybackRate: 'KeyY',
    },
  };

  before(async function() {
    await openOptions();
    await browser.execute((options) => localStorage.setItem('options', JSON.stringify(options)), legacy);
    await openOptions();
  });

  after(async function() {
    await browser.execute(() => localStorage.removeItem('options'));
  });

  it('shows the moved keys, the new keys, and the user\'s own bindings kept', async function() {
    expect((await rowState('WindowedFullscreen')).key).toBe('Shift+KeyW');
    expect((await rowState('NextChapter')).key).toBe('Shift+KeyA');
    expect((await rowState('PreviousVideo')).key).toBe('Shift+KeyB');
    expect((await rowState('RotateVideo')).key).toBe('Shift+KeyR');
    expect((await rowState('ToggleVisualFilters')).key).toBe('Shift+KeyQ');
    // Not on its old default, so not moved.
    expect((await rowState('FlipVideo')).key).toBe('KeyV');
    expect((await rowState('SpeedPreset3')).key).toBe('KeyQ');
    expect((await rowState('SpeedPreset4')).key).toBe('KeyA');
    expect((await rowState('ResetPlaybackRate')).key).toBe('KeyY');
    expect((await rowState('SpeedPreset5')).key).toBe('None');
    expect(await conflictCount()).toBe(0);
  });

  it('saves the migrated layout with its version once something is changed', async function() {
    await assignKey('SeekPercent50', 'KeyU');
    await waitForSaved((saved) => saved.keybinds.SeekPercent50 === 'KeyU');
    const saved = await savedOptions();
    expect(saved.keybindsVersion).toBe(3);
    expect(saved.keybinds.WindowedFullscreen).toBe('Shift+KeyW');
    expect(saved.keybinds.FlipVideo).toBe('KeyV');
    expect(saved.keybinds.SpeedPreset5).toBe('None');
    expect(saved.keybinds.ResetPlaybackRate).toBe('KeyY');
  });
});
