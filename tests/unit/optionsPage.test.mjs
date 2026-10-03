import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {loadPage} from './helpers/fakeDom.mjs';

// The options page script (options.mjs), run on a stand-in of options/index.html with the
// real OptionsStore and storage stubbed. It runs as the web build does (no `chrome`).
// - A change made before the saved options were read saved the defaults over them.
// - The page redrew itself after its own saves: the keybind box a key was just pressed
//   in was rebuilt (focus lost), and a number field was rewritten after each key.
// - A key press with no key code was saved as the binding ''.
// - The eight menus had no accessible name on the <select> itself.
// - The web build's "Welcome Page" link was a 404.

vi.mock('../../chrome/player/utils/SearchUtils.mjs', () => ({
  initsearch: vi.fn(), resetSearch: vi.fn(), searchWithQuery: vi.fn(),
}));
vi.mock('../../chrome/player/utils/UpdateChecker.mjs', () => ({UpdateChecker: {}}));

const doc = loadPage('chrome/player/options/index.html');
// The web build's OptionsStore hears other pages' saves as window messages.
const win = {
  postMessage: vi.fn(), opener: null, location: {origin: 'https://player.example'}, listeners: {},
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  },
};
win.parent = win;
vi.stubGlobal('document', doc);
vi.stubGlobal('window', win);
vi.stubGlobal('parent', win);
vi.stubGlobal('sessionStorage', {removeItem: () => {}});

const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
const {DefaultKeybinds} = await import('../../chrome/player/options/defaults/DefaultKeybinds.mjs');
const {KEYBINDS_VERSION} = await import('../../chrome/player/options/KeybindUtils.mjs');

// What the user saved earlier: their own key for PlayPause, a list, a seek step.
const saved = {
  keybindsVersion: KEYBINDS_VERSION,
  keybinds: {...DefaultKeybinds, PlayPause: 'KeyP'},
  autoEnableURLs: ['https://mine.example'],
  seekStepSize: 7,
  videoZoom: 1,
};
// Storage answers the first read only when the test says so; later reads at once.
let deliverSaved;
let delivered = false;
const storageRead = new Promise((resolve) => {
  deliverSaved = () => {
    delivered = true;
    resolve(JSON.stringify(saved));
  };
});
vi.spyOn(Utils, 'getConfig').mockImplementation((key) => {
  if (key !== 'options') return Promise.resolve(null);
  return delivered ? Promise.resolve(JSON.stringify(saved)) : storageRead;
});
const writes = [];
vi.spyOn(Utils, 'setConfig').mockImplementation(async (key, value) => {
  writes.push({key, value: JSON.parse(value)});
});
const optionWrites = () => writes.filter((write) => write.key === 'options');

// Lets the store's saves and notifications run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

await import('../../chrome/player/options/options.mjs');

const byId = (id) => doc.getElementById(id);
const keybindRow = (action) => byId('keybindslist').children.find((row) => row.dataset.keybind === action);
const keybindBox = (action) => keybindRow(action).querySelector('.keybind-input');

describe('the options page before the saved options are read', () => {
  it('saves nothing, so the defaults cannot overwrite what was saved', async () => {
    const mp4 = byId('playmp4urls');
    mp4.checked = true;
    mp4.fire('change');
    await settle();
    expect(optionWrites()).toEqual([]);
  });
});

describe('the options page once the saved options are read', () => {
  beforeAll(async () => {
    deliverSaved();
    await settle();
    expect(doc.documentElement.dataset.optionsLoaded).toBe('true');
  });

  afterEach(async () => {
    await settle();
    writes.length = 0;
  });

  it('shows what was saved, and saves a change on top of it', async () => {
    expect(keybindBox('PlayPause').textContent).toBe('KeyP');
    expect(byId('autoEnableURLs').value).toBe('https://mine.example');

    const mp4 = byId('playmp4urls');
    mp4.checked = true;
    mp4.fire('change');
    await settle();
    const [{value}] = optionWrites();
    expect(value.playMP4URLs).toBe(true);
    expect(value.keybinds.PlayPause).toBe('KeyP');
    expect(value.autoEnableURLs).toEqual(['https://mine.example']);
    expect(value.seekStepSize).toBe(7);
  });

  it('keeps the keybind box a key was pressed in, and its focus', async () => {
    const rows = [...byId('keybindslist').children];
    const box = keybindBox('Mute');
    box.focus();
    box.fire('click');
    box.fire('keydown', {key: 'u', code: 'KeyU'});
    await settle();

    expect(optionWrites().at(-1).value.keybinds.Mute).toBe('KeyU');
    expect(box.isConnected).toBe(true);
    expect(doc.activeElement).toBe(box);
    expect(box.textContent).toBe('KeyU');
    expect(byId('keybindslist').children).toEqual(rows);
  });

  it('leaves a number field alone while it is typed in, and shows its unit after', async () => {
    const zoom = doc.querySelectorAll('.video-option').find((option) => option.dataset.option === 'videoZoom');
    const number = zoom.querySelector('input.number');
    number.focus();
    number.value = '15';
    number.fire('input');
    await settle();
    expect(optionWrites().at(-1).value.videoZoom).toBe(0.15);
    expect(number.value).toBe('15');

    number.fire('change');
    await settle();
    expect(number.value).toBe('15%');
  });

  it('still shows a change saved elsewhere', async () => {
    saved.keybinds = {...saved.keybinds, PlayPause: 'KeyL'};
    for (const fn of win.listeners.message) fn({origin: win.location.origin, data: {type: 'options'}});
    await settle();
    expect(keybindBox('PlayPause').textContent).toBe('KeyL');
    expect(optionWrites()).toEqual([]);
  });

  it('ignores a key press with no key code instead of binding the action to it', async () => {
    const box = keybindBox('SaveVideo');
    const before = box.textContent;
    box.focus();
    const event = box.fire('keydown', {key: 'Unidentified', code: ''});
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(optionWrites()).toEqual([]);
    expect(box.textContent).toBe(before);

    // The space bar still binds, by its key.
    box.fire('keydown', {key: ' ', code: ''});
    await settle();
    expect(optionWrites().at(-1).value.keybinds.SaveVideo).toBe('Space');
  });
});

describe('the options page\'s controls', () => {
  it('names each menu on the <select> itself', () => {
    const selects = doc.querySelectorAll('select');
    expect(selects.length).toBe(8);
    for (const select of selects) {
      const wrapper = select.parentNode;
      expect(wrapper.dataset.i18nLabel, wrapper.id).toBeTruthy();
      // In Node the page has no translations, so a message is its key.
      expect(select.getAttribute('aria-label'), wrapper.id).toBe(wrapper.dataset.i18nLabel);
    }
  });

  it('gives every field a label', () => {
    const fields = doc.querySelectorAll('input, textarea').filter((field) => field.getAttribute('type') !== 'file');
    expect(fields.length).toBeGreaterThan(30);
    const unlabelled = fields.filter((field) => !field.dataset.i18nLabel && !field.getAttribute('aria-label'));
    expect(unlabelled.map((field) => field.id || field.className)).toEqual([]);
  });

  it('hides the Welcome Page link in the web build, which has no welcome page', () => {
    expect(byId('welcomeitem').style.display).toBe('none');
    expect(byId('welcomeitem').querySelector('#welcome')).not.toBe(null);
  });
});
