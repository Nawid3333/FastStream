import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {loadPage} from './helpers/fakeDom.mjs';
import {fakeStorageSync} from './helpers/fakeStorageSync.mjs';
import {META_KEY, chunkKey, saveCloudCopy} from '../../chrome/player/options/CloudSettings.mjs';
import {DefaultOptions} from '../../chrome/player/options/defaults/DefaultOptions.mjs';

// The options page's "Export to cloud" and "Import from cloud" (CloudSettings.mjs), run through
// the real options.mjs as the extension runs it: chrome.* stubbed, storage.sync a stand-in
// that keeps Firefox's quotas, the English messages. The cloud copy is the object the file
// export writes and goes in the way an imported file does; the buttons are hidden on Firefox
// for Android, whose storage.sync stays on the phone.

vi.mock('../../chrome/player/utils/SearchUtils.mjs', () => ({
  initsearch: vi.fn(), resetSearch: vi.fn(), searchWithQuery: vi.fn(),
}));
vi.mock('../../chrome/player/utils/UpdateChecker.mjs', () => ({
  UpdateChecker: {getLatestVersion: async () => null, refreshUpdateData: async () => null, compareVersions: () => false},
}));

const root = path.resolve(import.meta.dirname, '..', '..');
const english = JSON.parse(fs.readFileSync(path.join(root, 'chrome/_locales/en/messages.json'), 'utf8'));
const NOW = Date.UTC(2026, 10, 20, 12, 30);
const shown = (time) => new Date(time).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});

const settle = async () => {
  for (let round = 0; round < 8; round++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Opens a fresh options page in a stand-in extension.
 * @param {Object} setup
 * @param {Object} [setup.options] - The saved options.
 * @param {Object} [setup.sync] - storage.sync; a fresh empty one by default.
 * @param {?string} [setup.os] - Firefox's runtime.getPlatformInfo().os; null for no answer.
 * @param {string} [setup.userAgent]
 * @param {boolean} [setup.seen] - Whether the page is seen as soon as it loads.
 * @param {boolean} [setup.withSync] - Whether chrome.storage has a sync area at all.
 * @return {Promise<Object>}
 */
async function openOptionsPage({options = {}, sync = fakeStorageSync(), os = 'win', userAgent, seen = true, withSync = true} = {}) {
  vi.resetModules();
  const doc = loadPage('chrome/player/options/index.html');
  const local = {options: JSON.stringify(options)};
  const chrome = {
    extension: {inIncognitoContext: false},
    i18n: {
      getMessage: (key, subs = []) => english[key]?.message.replace(/\$(\d)/g, (m, n) => subs[n - 1]) ?? '',
      getUILanguage: () => 'en',
    },
    runtime: {
      lastError: undefined,
      getURL: (file) => 'moz-extension://test/' + file,
      getManifest: () => ({version: '1.3.82.0'}),
      onMessage: {addListener: () => {}},
      sendMessage: () => {},
      ...(os ? {getPlatformInfo: async () => ({os})} : {}),
    },
    storage: {
      local: {
        get(keys, callback) {
          const result = {};
          for (const key of typeof keys === 'string' ? [keys] : Object.keys(keys)) {
            if (Object.hasOwn(local, key)) result[key] = local[key];
            else if (typeof keys !== 'string') result[key] = keys[key];
          }
          setTimeout(() => callback(result), 0);
        },
        set(items, callback) {
          Object.assign(local, items);
          if (callback) setTimeout(callback, 0);
        },
      },
      ...(withSync ? {sync} : {}),
      onChanged: {addListener: () => {}},
    },
    tabs: {create: vi.fn()},
  };
  if (userAgent) vi.stubGlobal('navigator', {userAgent, platform: 'Win32'});
  let observed = null;
  // Never asked: the page asks on itself (CloudSettings.mjs says why).
  const confirm = vi.fn(() => true);
  const win = {opener: null, location: {origin: 'moz-extension://test'}, addEventListener() {}, confirm};
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
  // The file export's file, as written.
  const files = [];
  vi.stubGlobal('Blob', class {
    constructor(parts) {
      files.push(parts.join(''));
    }
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
  vi.spyOn(Utils, 'downloadURL').mockResolvedValue(1);

  await import('../../chrome/player/options/options.mjs');
  const byId = (id) => doc.getElementById(id);
  const page = {
    doc, local, sync, files, confirm, byId,
    box: () => byId('cloudsettings'),
    status: () => byId('cloudstatus').textContent,
    result: () => byId('cloudresult').textContent,
    // The question's text while it is shown, null while it is not.
    question: () => byId('cloudquestion').hidden ? null : byId('cloudquestiontext').textContent,
    focused: () => doc.activeElement.id,
    savedOptions: () => JSON.parse(local.options),
    click: async (id) => {
      byId(id).fire('click');
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the cloud buttons', () => {
  it('sit below the file buttons with their hint, which is always shown', async () => {
    const page = await openOptionsPage();
    const section = page.byId('import').parentNode.parentNode;
    expect(page.box().parentNode).toBe(section);
    expect(section.children.indexOf(page.box())).toBeGreaterThan(section.children.indexOf(page.byId('import').parentNode));
    expect(page.box().hidden).toBe(false);
    expect(page.byId('cloudexport').dataset.i18n).toBe('options_cloud_export');
    expect(page.byId('cloudimport').dataset.i18n).toBe('options_cloud_import');
    expect(english.options_cloud_export.message).toBe('Export to cloud');
    expect(english.options_cloud_import.message).toBe('Import from cloud');
    expect(page.byId('cloudhint').dataset.i18n).toBe('options_cloud_hint');
    expect(page.byId('cloudhint').hidden).toBe(false);
    // The question: hidden until asked, its answers real buttons.
    expect(page.question()).toBe(null);
    expect(page.byId('cloudquestion').parentNode).toBe(page.box());
    expect(page.byId('cloudreplace').tagName).toBe('BUTTON');
    expect(page.byId('cloudcancel').tagName).toBe('BUTTON');
    expect(english[page.byId('cloudreplace').dataset.i18n].message).toBe('Replace');
    expect(english[page.byId('cloudcancel').dataset.i18n].message).toBe('Cancel');
  });

  it('say there is no cloud copy yet, and read storage.sync only once the page is seen', async () => {
    const page = await openOptionsPage({seen: false});
    expect(page.sync.calls).toEqual([]);
    await page.show();
    expect(page.status()).toBe('No cloud copy yet');
  });

  it('export the object the file export writes, and show when and where it was saved', async () => {
    const page = await openOptionsPage({options: {mpvPath: 'C:\\Programs\\mpv\\mpv.exe', seekStepSize: 7}});
    await page.click('export');
    const file = JSON.parse(page.files.at(-1));
    expect(file.mpvPath).toBeUndefined();
    expect(file.seekStepSize).toBe(7);

    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    await page.click('cloudexport');
    expect(page.result()).toBe('Settings exported to the cloud.');
    const meta = page.sync.data[META_KEY];
    expect(meta).toMatchObject({v: 1, savedAt: NOW, os: 'win'});
    const copy = Array.from({length: meta.chunks}, (_, i) => page.sync.data[chunkKey(i)]).join('');
    expect(JSON.parse(copy)).toEqual(file);
    expect(page.status()).toBe(`Cloud copy: saved ${shown(NOW)} (Windows)`);
  });

  it('take one click at a time', async () => {
    const page = await openOptionsPage();
    page.byId('cloudexport').fire('click');
    page.byId('cloudexport').fire('click');
    page.byId('cloudimport').fire('click');
    await settle();
    expect(page.sync.calls.filter(([call]) => call === 'set')).toHaveLength(1);
    expect(page.question()).toBe(null);
    expect(page.byId('cloudexport').disabled).toBe(false);
  });

  /**
   * A page with another computer's copy in the cloud: numbers out of their fields' limits and
   * an mpv path, against the page's own seek step 7 and mpv path.
   */
  async function pageWithCloudCopy() {
    const sync = fakeStorageSync();
    const settings = {...DefaultOptions, seekStepSize: -5, autoEnableURLs: ['https://cloud.example'],
      mpvPath: 'C:\\planted\\mpv.exe', subtitlesSettings: {}, toolSettings: {}};
    await saveCloudCopy(sync, settings, 'linux', NOW);
    return openOptionsPage({sync, options: {seekStepSize: 7, mpvPath: 'C:\\mine\\mpv.exe'}});
  }

  it('import the cloud copy only on Replace, through the file import\'s checks', async () => {
    const page = await pageWithCloudCopy();
    expect(page.status()).toBe(`Cloud copy: saved ${shown(NOW)} (Linux)`);

    await page.click('cloudimport');
    expect(page.question()).toBe(`Replace your settings with the cloud copy saved ${shown(NOW)} (Linux)?`);
    expect(page.focused()).toBe('cloudreplace');
    expect(page.savedOptions().seekStepSize).toBe(7);

    await page.click('cloudcancel');
    expect(page.question()).toBe(null);
    expect(page.focused()).toBe('cloudimport');
    expect(page.savedOptions().seekStepSize).toBe(7);
    expect(page.result()).toBe('');

    await page.click('cloudimport');
    await page.click('cloudreplace');
    expect(page.question()).toBe(null);
    expect(page.focused()).toBe('cloudimport');
    expect(page.result()).toBe('Settings imported from the cloud.');
    expect(page.byId('autoEnableURLs').value).toBe('https://cloud.example');
    expect(page.savedOptions().autoEnableURLs).toEqual(['https://cloud.example']);
    expect(page.savedOptions().seekStepSize).toBe(0.1);
    expect(page.savedOptions().mpvPath).toBe('C:\\mine\\mpv.exe');
    expect(page.confirm).not.toHaveBeenCalled();
  });

  it('take the question down, unanswered, on an export', async () => {
    const page = await pageWithCloudCopy();
    await page.click('cloudimport');
    expect(page.question()).not.toBe(null);
    await page.click('cloudexport');
    expect(page.question()).toBe(null);
    // A Replace that still comes (a click on its way) brings no stale copy in.
    await page.click('cloudreplace');
    expect(page.savedOptions().seekStepSize).toBe(7);
    expect(page.result()).toBe('Settings exported to the cloud.');
  });

  it('take the question down, unanswered, on another import, and ask about the copy there now', async () => {
    const page = await pageWithCloudCopy();
    await page.click('cloudimport');
    // The copy goes from the cloud: the next import finds none, and asks nothing.
    page.sync.arrive(Object.fromEntries(Object.keys(page.sync.data).map((key) => [key, undefined])));
    await page.click('cloudimport');
    expect(page.result()).toBe(english.options_cloud_none.message);
    expect(page.question()).toBe(null);
    await page.click('cloudreplace');
    expect(page.savedOptions().seekStepSize).toBe(7);
    // Another computer's copy comes: the question is about that one.
    const other = fakeStorageSync();
    await saveCloudCopy(other, {...DefaultOptions, seekStepSize: 9, subtitlesSettings: {}, toolSettings: {}}, 'mac', NOW + 60000);
    page.sync.arrive(other.data);
    await page.click('cloudimport');
    expect(page.question()).toBe(`Replace your settings with the cloud copy saved ${shown(NOW + 60000)} (macOS)?`);
    await page.click('cloudreplace');
    expect(page.savedOptions().seekStepSize).toBe(9);
  });

  it('say so when there is no cloud copy, without asking', async () => {
    const page = await openOptionsPage();
    await page.click('cloudimport');
    expect(page.question()).toBe(null);
    expect(page.result()).toBe(english.options_cloud_none.message);
    expect(page.result()).toBe('No cloud copy yet. Export from another computer first; if you just did, use Sync Now in Firefox and try again.');
  });

  it('say so when the copy is incomplete, without asking', async () => {
    const sync = fakeStorageSync();
    await saveCloudCopy(sync, {...DefaultOptions, subtitlesSettings: {}, toolSettings: {}}, 'win', NOW);
    delete sync.data[chunkKey(0)];
    const page = await openOptionsPage({sync});
    await page.click('cloudimport');
    expect(page.question()).toBe(null);
    expect(page.result()).toBe('The cloud copy is incomplete; it may still be syncing. Try again in a few minutes.');
  });

  it('say so when the settings do not fit, and keep the copy there', async () => {
    const sync = fakeStorageSync();
    await saveCloudCopy(sync, {...DefaultOptions, subtitlesSettings: {}, toolSettings: {}}, 'win', NOW);
    const before = structuredClone(sync.data);
    const autoEnableURLs = Array.from({length: 3000}, (_, i) => `https://site-${i}.example/videos/watch/`);
    const page = await openOptionsPage({sync, options: {autoEnableURLs}});
    await page.click('cloudexport');
    expect(page.result()).toBe('Too large for Firefox\'s 100 KB sync storage. Shorten the URL lists, or use the file export.');
    expect(sync.data).toEqual(before);
    expect(page.byId('cloudexport').disabled).toBe(false);
  });

  it('show another computer\'s copy as it arrives', async () => {
    const sync = fakeStorageSync();
    const page = await openOptionsPage({sync});
    expect(page.status()).toBe('No cloud copy yet');
    const other = fakeStorageSync();
    await saveCloudCopy(other, {a: 1}, 'mac', NOW);
    sync.arrive(other.data);
    await settle();
    expect(page.status()).toBe(`Cloud copy: saved ${shown(NOW)} (macOS)`);
    // An item of its own is no cloud copy's: not read again.
    const reads = sync.calls.length;
    sync.arrive({unrelated: 1});
    await settle();
    expect(sync.calls.length).toBe(reads);
  });
});

describe('the cloud buttons where storage.sync does not sync', () => {
  const android = 'Mozilla/5.0 (Android 15; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0';
  const desktop = 'Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0';

  it('are hidden on Firefox for Android, with their hint and status, and storage.sync is not read', async () => {
    const page = await openOptionsPage({os: 'android', userAgent: android});
    expect(page.box().hidden).toBe(true);
    expect(page.byId('cloudhint').parentNode).toBe(page.box());
    expect(page.byId('cloudstatus').parentNode).toBe(page.box());
    expect(page.sync.calls).toEqual([]);
  });

  it('are hidden once Firefox says Android, when the user agent is a desktop site\'s', async () => {
    const page = await openOptionsPage({os: 'android', userAgent: desktop});
    expect(page.box().hidden).toBe(true);
  });

  it('are shown once Firefox says Windows, when the user agent is set to Android\'s', async () => {
    const page = await openOptionsPage({os: 'win', userAgent: android});
    expect(page.box().hidden).toBe(false);
    expect(page.status()).toBe('No cloud copy yet');
  });

  it('are hidden without storage.sync', async () => {
    const page = await openOptionsPage({withSync: false});
    expect(page.box().hidden).toBe(true);
    await page.click('cloudexport');
    expect(page.result()).toBe('');
  });
});
