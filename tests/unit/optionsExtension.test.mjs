import {afterEach, describe, expect, it, vi} from 'vitest';
import {loadPage} from './helpers/fakeDom.mjs';

// The options page (options.mjs) as the extension runs it: chrome.* stubbed, the real
// OptionsStore and UpdateChecker, GitHub's answer stubbed. The page is an iframe in every
// player, so what it does at load it does at every player opened.
// - The update check (GitHub build) stored the update data at every load, which told every
//   open options page; a failed check wrote null over the version known, and with no version
//   known it asked GitHub again at every load.
// - The problems list's Report button opened the issue with window.open, which the player's
//   iframe must not (EnvUtils.openExternalURL says why), and the update banner's button
//   called chrome.tabs.create itself.
// - The mpv test asked permissions.contains for nativeMessaging, a permission the manifest
//   requires, before it sent the test.

vi.mock('../../chrome/player/utils/SearchUtils.mjs', () => ({
  initsearch: vi.fn(), resetSearch: vi.fn(), searchWithQuery: vi.fn(),
}));

const HOUR = 1000 * 60 * 60;

// Lets storage callbacks, GitHub's answer and the store's saves run.
const settle = async () => {
  for (let round = 0; round < 5; round++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Opens a fresh options page in a stand-in extension.
 * @param {Object} setup
 * @param {Object} [setup.stored] - storage.local's keys besides the options.
 * @param {?string} [setup.latestVersion] - GitHub's answer; null for a failed check.
 * @param {*} [setup.mpvAnswer] - The background's answer to MPV_TEST.
 * @return {Promise<Object>}
 */
async function openOptionsPage({stored = {}, latestVersion = null, mpvAnswer = {ok: true, mpv: false}} = {}) {
  vi.resetModules();
  const doc = loadPage('chrome/player/options/index.html');
  const local = {options: JSON.stringify({}), ...stored};
  const sent = [];
  const localWrites = [];
  const chrome = {
    extension: {inIncognitoContext: false},
    i18n: {getMessage: () => '', getUILanguage: () => 'en'},
    runtime: {
      lastError: undefined,
      getURL: (file) => 'moz-extension://test/' + file,
      getManifest: () => ({version: '1.3.82.100'}),
      onMessage: {addListener: () => {}},
      sendMessage(message, callback) {
        sent.push(message);
        if (message.type === 'MPV_TEST') setTimeout(() => callback(mpvAnswer), 0);
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
          localWrites.push(items);
          Object.assign(local, items);
          if (callback) setTimeout(callback, 0);
        },
      },
      onChanged: {addListener: () => {}},
    },
    tabs: {create: vi.fn()},
    permissions: {contains: vi.fn(), request: vi.fn()},
  };
  const win = {
    opener: null, location: {origin: 'moz-extension://test'}, addEventListener() {}, open: vi.fn(),
    // i18n.mjs's, which the page has: a message is its key here.
    getI18nMessage: (key) => key,
  };
  win.parent = win;
  vi.stubGlobal('chrome', chrome);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.stubGlobal('parent', win);
  vi.stubGlobal('sessionStorage', {removeItem: () => {}});
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
  });

  // The instances options.mjs is about to import.
  const {UpdateChecker} = await import('../../chrome/player/utils/UpdateChecker.mjs');
  const askedGitHub = vi.spyOn(UpdateChecker, 'getLatestVersion').mockResolvedValue(latestVersion);
  const {EnvUtils} = await import('../../chrome/player/utils/EnvUtils.mjs');
  const opened = vi.spyOn(EnvUtils, 'openExternalURL').mockImplementation(() => {});

  await import('../../chrome/player/options/options.mjs');
  await settle();
  return {
    doc, sent, local, chrome, win, askedGitHub, opened,
    byId: (id) => doc.getElementById(id),
    updateWrites: () => localWrites.filter((items) => Object.hasOwn(items, 'updateData')),
    updateData: () => JSON.parse(local.updateData),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the update check', () => {
  it('checks once, stores what it found and shows a newer version', async () => {
    const page = await openOptionsPage({latestVersion: '1.3.82.200'});
    expect(page.askedGitHub).toHaveBeenCalledTimes(1);
    expect(page.updateWrites()).toHaveLength(1);
    expect(page.updateData().latestVersion).toBe('1.3.82.200');
    expect(page.byId('updatebox').style.display).toBe('block');
  });

  it('stores nothing and asks nothing within 12 hours of a check', async () => {
    const updateData = JSON.stringify({latestVersion: '1.3.82.200', lastUpdateCheck: Date.now() - HOUR});
    const page = await openOptionsPage({stored: {updateData}, latestVersion: '1.3.82.300'});
    expect(page.askedGitHub).not.toHaveBeenCalled();
    expect(page.updateWrites()).toEqual([]);
    // The version known is still shown.
    expect(page.byId('updatebox').style.display).toBe('block');
  });

  it('waits 12 hours after a failed check too, with no version known', async () => {
    const updateData = JSON.stringify({latestVersion: null, lastUpdateCheck: Date.now() - HOUR});
    const page = await openOptionsPage({stored: {updateData}, latestVersion: '1.3.82.200'});
    expect(page.askedGitHub).not.toHaveBeenCalled();
    expect(page.updateWrites()).toEqual([]);
  });

  it('keeps the version known when a check fails', async () => {
    const updateData = JSON.stringify({latestVersion: '1.3.82.200', lastUpdateCheck: Date.now() - 13 * HOUR});
    const page = await openOptionsPage({stored: {updateData}, latestVersion: null});
    expect(page.askedGitHub).toHaveBeenCalledTimes(1);
    expect(page.updateData().latestVersion).toBe('1.3.82.200');
    expect(page.updateData().lastUpdateCheck).toBeGreaterThan(Date.now() - HOUR);
    expect(page.byId('updatebox').style.display).toBe('block');
  });

  it('opens the releases as the player opens a page', async () => {
    const page = await openOptionsPage({latestVersion: '1.3.82.200'});
    page.byId('update').fire('click');
    expect(page.opened).toHaveBeenCalledWith('https://github.com/Nawid3333/FastStream-for-Firefox/releases');
    expect(page.chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe('the problems list', () => {
  it('opens the report as the player opens a page, not with window.open', async () => {
    const problem = {id: 'example.com|no_next', host: 'example.com', path: '/watch', kind: 'no_next', mode: 'player',
      count: 2, first: 0, last: 0};
    const page = await openOptionsPage({stored: {siteProblems: [problem]}});
    const [report] = page.byId('problemslist').querySelectorAll('button');
    report.fire('click');
    expect(page.win.open).not.toHaveBeenCalled();
    expect(page.opened).toHaveBeenCalledTimes(1);
    expect(page.opened.mock.calls[0][0]).toMatch(/^https:\/\/github\.com\/Nawid3333\/FastStream\/issues\/new\?.*example\.com/);
  });
});

describe('the mpv test button', () => {
  it('sends the test at once: nativeMessaging is a permission the manifest requires', async () => {
    const page = await openOptionsPage();
    page.byId('mpvtest').fire('click');
    expect(page.sent.filter((message) => message.type === 'MPV_TEST')).toHaveLength(1);
    expect(page.chrome.permissions.contains).not.toHaveBeenCalled();
    expect(page.chrome.permissions.request).not.toHaveBeenCalled();
    await settle();
    expect(page.byId('mpvtestresult').textContent).toBe('options_mpv_test_nompv');
  });

  it('is right that the manifest requires nativeMessaging', async () => {
    const fs = await import('node:fs');
    const manifest = JSON.parse(fs.readFileSync(new URL('../../chrome/manifest.json', import.meta.url), 'utf8'));
    expect(manifest.permissions).toContain('nativeMessaging');
    expect(manifest.optional_permissions ?? []).not.toContain('nativeMessaging');
  });
});
