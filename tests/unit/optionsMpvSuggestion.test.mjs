import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {loadPage} from './helpers/fakeDom.mjs';
import {splice} from '../../tools/splicer.mjs';

// The options page's offer to turn MPV mode on (MpvSuggestion.mjs), run through the real
// options.mjs as the extension runs it: chrome.* stubbed, the real OptionsStore. mpv-config's
// one-click setup installs the mpv host and the add-on but leaves MPV mode off; the banner
// says the host answered and turns the mode on with one click.
// - Shown only when MPV mode is off and the host answers "mpv found" (MPV_TEST, as the
//   "Test mpv connection" button asks).
// - The host is not asked before the page is seen: the options page is an iframe in every
//   player, and starting the host for each of them would be for nothing.
// - The button turns MPV mode on (saved like the checkbox) and points to the allowlist.
// - Dismissing it is remembered in storage.local, like the update banner's ignored version.
// - It is outside the update banner's SPLICER:NO_UPDATE_CHECKER block, so the AMO build
//   (the signed .xpi) keeps it.

vi.mock('../../chrome/player/utils/SearchUtils.mjs', () => ({
  initsearch: vi.fn(), resetSearch: vi.fn(), searchWithQuery: vi.fn(),
}));
// The update banner's check, which runs in the extension too: no newer version.
vi.mock('../../chrome/player/utils/UpdateChecker.mjs', () => ({
  UpdateChecker: {getLatestVersion: async () => null, compareVersions: () => false},
}));

const root = path.resolve(import.meta.dirname, '..', '..');

// Lets storage callbacks, the host's answer and the store's saves run.
const settle = async () => {
  for (let round = 0; round < 5; round++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Opens a fresh options page in a stand-in extension.
 * @param {Object} setup
 * @param {Object} [setup.options] - The saved options.
 * @param {Object} [setup.stored] - Other storage.local keys.
 * @param {*} [setup.answer] - The background's MPV_TEST answer; 'lastError' for none.
 * @param {boolean} [setup.seen] - Whether the page is seen as soon as it loads.
 * @return {Promise<Object>} The page, what it sent, what it stored, and a way to show it.
 */
async function openOptionsPage({options = {}, stored = {}, answer = {ok: true, mpv: true}, seen = true} = {}) {
  vi.resetModules();
  const doc = loadPage('chrome/player/options/index.html');
  const local = {options: JSON.stringify(options), ...stored};
  const sent = [];
  const heard = [];
  const chrome = {
    extension: {inIncognitoContext: false},
    i18n: {getMessage: () => '', getUILanguage: () => 'en'},
    runtime: {
      lastError: undefined,
      getURL: (file) => 'moz-extension://test/' + file,
      getManifest: () => ({version: '1.3.82.0'}),
      onMessage: {addListener: (fn) => heard.push(fn)},
      sendMessage(message, callback) {
        sent.push(message);
        if (message.type !== 'MPV_TEST') return;
        setTimeout(() => {
          if (answer === 'lastError') {
            chrome.runtime.lastError = {message: 'Could not establish connection.'};
            callback(undefined);
            chrome.runtime.lastError = undefined;
          } else {
            callback(answer);
          }
        }, 0);
      },
    },
    storage: {
      local: {
        get(keys, callback) {
          const result = {};
          if (typeof keys === 'string') {
            if (Object.hasOwn(local, keys)) result[keys] = local[keys];
          } else {
            for (const [key, fallback] of Object.entries(keys)) {
              result[key] = Object.hasOwn(local, key) ? local[key] : fallback;
            }
          }
          setTimeout(() => callback(result), 0);
        },
        set(items, callback) {
          Object.assign(local, items);
          if (callback) setTimeout(callback, 0);
        },
      },
    },
    tabs: {create: vi.fn()},
  };
  let observed = null;
  const win = {opener: null, location: {origin: 'moz-extension://test'}, addEventListener() {}};
  win.parent = win;
  vi.stubGlobal('chrome', chrome);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.stubGlobal('parent', win);
  vi.stubGlobal('sessionStorage', {removeItem: () => {}});
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) {
      observed = callback;
    }
    observe() {}
  });

  await import('../../chrome/player/options/options.mjs');
  const page = {
    doc, sent, local,
    byId: (id) => doc.getElementById(id),
    banner: () => doc.getElementById('mpvsuggestbox'),
    hostAsked: () => sent.filter((message) => message.type === 'MPV_TEST').length,
    savedOptions: () => JSON.parse(local.options),
    // Another page saved these options (the background's UPDATE_OPTIONS).
    savedElsewhere: async (changes) => {
      local.options = JSON.stringify({...JSON.parse(local.options), ...changes});
      for (const fn of heard) fn({type: 'UPDATE_OPTIONS', time: 1});
      await settle();
    },
    show: async () => {
      observed([{isIntersecting: true}]);
      await settle();
    },
  };
  await settle();
  if (seen) await page.show();
  return page;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the offer to turn MPV mode on', () => {
  it('starts hidden', () => {
    const doc = loadPage('chrome/player/options/index.html');
    expect(doc.getElementById('mpvsuggestbox').hidden).toBe(true);
  });

  it('shows when MPV mode is off and the host found mpv', async () => {
    const page = await openOptionsPage({options: {mpvMode: false}});
    expect(page.hostAsked()).toBe(1);
    expect(page.banner().hidden).toBe(false);
    expect(page.byId('mpvsuggestyes').hidden).toBe(false);
  });

  it('does not ask the host before the page is seen, and asks once after', async () => {
    const page = await openOptionsPage({seen: false});
    expect(page.hostAsked()).toBe(0);
    expect(page.banner().hidden).toBe(true);

    await page.show();
    await page.show();
    expect(page.hostAsked()).toBe(1);
    expect(page.banner().hidden).toBe(false);
  });

  it('stays hidden, without asking the host, while MPV mode is on', async () => {
    const page = await openOptionsPage({options: {mpvMode: true}});
    expect(page.hostAsked()).toBe(0);
    expect(page.banner().hidden).toBe(true);
  });

  it('stays hidden when the host is not installed', async () => {
    const page = await openOptionsPage({answer: {ok: false, error: 'No such native application com.faststream.mpv'}});
    expect(page.hostAsked()).toBe(1);
    expect(page.banner().hidden).toBe(true);
  });

  it('stays hidden when the background does not answer', async () => {
    const page = await openOptionsPage({answer: 'lastError'});
    expect(page.banner().hidden).toBe(true);
  });

  it('stays hidden when the host answers but found no mpv', async () => {
    const page = await openOptionsPage({answer: {ok: true, mpv: false}});
    expect(page.banner().hidden).toBe(true);
  });

  it('turns MPV mode on with its button, and points to the allowlist', async () => {
    const page = await openOptionsPage({options: {mpvMode: false, mpvAllowlist: ['https://mine.example']}});
    page.byId('mpvsuggestyes').fire('click');
    await settle();

    expect(page.savedOptions().mpvMode).toBe(true);
    // The rest of what was saved stays.
    expect(page.savedOptions().mpvAllowlist).toEqual(['https://mine.example']);
    expect(page.byId('mpvmode').checked).toBe(true);
    expect(page.byId('mpvModeSectionToggle').checked).toBe(true);
    // In Node a message is its key.
    expect(page.byId('mpvsuggesttext').textContent).toBe('options_mpv_suggest_done');
    expect(page.byId('mpvsuggestyes').hidden).toBe(true);
    expect(page.byId('mpvsuggestno').textContent).toBe('options_mpv_suggest_close');
    expect(page.banner().hidden).toBe(false);
    // Taken is as good as dismissed: no offer again.
    expect(page.local.mpvSuggestionDismissed).toBe(true);

    page.byId('mpvsuggestno').fire('click');
    expect(page.banner().hidden).toBe(true);
  });

  // Its "MPV mode is on" stayed up, untrue, until closed by hand (review, 2026-10-09).
  it('goes once taken when MPV mode is turned off again', async () => {
    const page = await openOptionsPage();
    page.byId('mpvsuggestyes').fire('click');
    await settle();
    expect(page.banner().hidden).toBe(false);
    const toggle = page.byId('mpvmode');
    toggle.checked = false;
    toggle.fire('change');
    await settle();
    expect(page.savedOptions().mpvMode).toBe(false);
    expect(page.banner().hidden).toBe(true);
  });

  it('goes when MPV mode is turned on with the checkbox instead', async () => {
    const page = await openOptionsPage();
    expect(page.banner().hidden).toBe(false);
    const toggle = page.byId('mpvmode');
    toggle.checked = true;
    toggle.fire('change');
    await settle();
    expect(page.savedOptions().mpvMode).toBe(true);
    expect(page.banner().hidden).toBe(true);
  });

  it('goes when MPV mode is turned on on another page', async () => {
    const page = await openOptionsPage();
    expect(page.banner().hidden).toBe(false);
    await page.savedElsewhere({mpvMode: true});
    expect(page.byId('mpvmode').checked).toBe(true);
    expect(page.banner().hidden).toBe(true);
  });

  it('remembers a dismissal, and then does not ask the host again', async () => {
    const page = await openOptionsPage();
    const click = page.byId('mpvsuggestno').fire('click');
    expect(click.defaultPrevented).toBe(true);
    expect(page.banner().hidden).toBe(true);
    expect(page.local.mpvSuggestionDismissed).toBe(true);
    // MPV mode stays off.
    expect(page.savedOptions().mpvMode).toBeFalsy();

    const next = await openOptionsPage({stored: {mpvSuggestionDismissed: true}});
    expect(next.hostAsked()).toBe(0);
    expect(next.banner().hidden).toBe(true);
  });
});

describe('the offer in the builds', () => {
  const source = fs.readFileSync(path.join(root, 'chrome/player/options/options.mjs'), 'utf8');

  it('is in the AMO build, which drops the update banner', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const amo = splice(source, 'NO_UPDATE_CHECKER', 'player/options/options.mjs');
    expect(amo).not.toContain('UpdateChecker');
    expect(amo).toContain('import {MpvSuggestion} from \'./MpvSuggestion.mjs\';');
    expect(amo).toContain('new MpvSuggestion(');
    expect(amo).toContain('offerMpvWhenReady();');
  });
});
