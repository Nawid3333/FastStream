import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// The same build runs on Firefox for Android, which lacks some of the APIs the desktop has
// (docs/notes/build-and-release.md, "Firefox for Android"). Its background page must load and
// work without them, and Mozilla's browser-compat-data must name nothing else FastStream
// uses as missing there.

const root = path.resolve(import.meta.dirname, '../..');
const PAGE = 'https://site.test/watch/1';
const PLAYER_IN_PAGE = 'moz-extension://bg-test/player/index.html?opener=page-1';

/** What Firefox for Android lacks, of what FastStream uses: a namespace, or one member of it. */
const AndroidLacks = ['commands', 'menus', 'contextMenus', 'windows', 'runtime.connectNative', 'runtime.sendNativeMessage'];

const lacked = (/** @type {string} */ name) => AndroidLacks.some((l) => name === l || name.startsWith(l + '.'));

/** @param {*} chrome - The harness's stand-in, before the background is imported. */
function asOnAndroid(chrome) {
  for (const name of AndroidLacks) {
    const [ns, member] = name.split('.');
    if (member) {
      delete chrome[ns][member];
    } else {
      delete chrome[ns];
    }
  }
}

/**
 * How many listeners each event has, by its name (runtime.onMessage, webRequest.onBeforeRequest).
 * @param {*} chrome
 * @return {Object<string, number>}
 */
function listenerCounts(chrome) {
  const counts = {};
  for (const [ns, api] of Object.entries(chrome)) {
    if (!api || typeof api !== 'object') continue;
    for (const [name, value] of Object.entries(api)) {
      if (value && Array.isArray(value.listeners)) counts[`${ns}.${name}`] = value.listeners.length;
    }
  }
  return counts;
}

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
});

describe('the background page on Firefox for Android', () => {
  it('loads, and listens to all it listens to on a desktop but what Android lacks', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    const desktop = listenerCounts(bg.chrome);
    bg.unload();
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}], beforeImport: asOnAndroid});
    const android = listenerCounts(bg.chrome);
    expect(desktop['runtime.onMessage']).toBe(1);
    expect(android).toEqual(Object.fromEntries(Object.entries(desktop).filter(([name]) => !lacked(name))));
  });

  it('turns the player on and off with the toolbar button', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}], beforeImport: asOnAndroid});
    await bg.click(1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false});
    await bg.click(1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: false});
  });

  it('keeps MPV mode off when the saved options have it on, and asks no helper', async () => {
    // Settings brought from a desktop, where an allowlisted page's stream goes to mpv by itself.
    const STREAM = 'https://cdn.test/a/master.m3u8';
    const options = {mpvMode: true, mpvAllowlist: ['https://site.test/']};
    const pageWithStream = async (setup) => {
      bg = await loadBackground({options, tabs: [{id: 1, url: PAGE}], ...setup});
      await bg.navigated(1, PAGE);
      await bg.frameAdded(1, 0, PAGE, 'page-1');
      await bg.request({tabId: 1, url: STREAM});
      await bg.wait(3000);
    };
    await pageWithStream({});
    expect(bg.toMpv()).toEqual([STREAM]);
    bg.unload();

    // The helper is asked through sendNativeMessage, which Android lacks: each time the code looks
    // for it is a hand-off tried.
    const looks = [];
    await pageWithStream({beforeImport: (chrome) => {
      asOnAndroid(chrome);
      Object.defineProperty(chrome.runtime, 'sendNativeMessage', {configurable: true, get: () => {
        looks.push('sendNativeMessage');
        return undefined;
      }});
    }});
    expect(looks).toEqual([]);
    await bg.click(1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false});
  });

  it('lets a key the page cancelled go, with no shortcuts to match it against', async () => {
    const rejections = [];
    const onRejection = (/** @type {*} */ reason) => rejections.push(String(reason));
    process.on('unhandledRejection', onRejection);
    try {
      bg = await loadBackground({tabs: [{id: 1, url: PAGE}], beforeImport: asOnAndroid});
      const press = {type: 'SHORTCUT_CANCELLED', key: 'u', code: 'KeyU', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false};
      await bg.message(press, {tabId: 1, url: PAGE});
      await bg.wait(100);
      // Node reports an unhandled rejection after a turn of its event loop: a real one.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
    expect(bg.sentToTabs).toEqual([]);
  });

  it('leaves the next episode in the page, with no window to make fullscreen', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}], beforeImport: asOnAndroid});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.message({type: 'PLAYER_LOADED', url: PLAYER_IN_PAGE, parentFrameId: 0}, {tabId: 1, frameId: 5});
    bg.sentToTabs.length = 0;
    expect(await bg.message({type: 'REQUEST_WINDOW_FULLSCREEN', force: true}, {tabId: 1, frameId: 5})).toBe('exit');
    expect(bg.sent('CARRIED_FULLSCREEN')).toEqual([]);
  });
});

describe('what Firefox for Android lacks', () => {
  // web-ext's linter brings Mozilla's data along; no package of its own to keep up to date.
  const require = createRequire(import.meta.url);
  const fromWebExt = createRequire(require.resolve('web-ext'));
  const fromLinter = createRequire(fromWebExt.resolve('addons-linter/package.json'));
  const bcd = fromLinter('@mdn/browser-compat-data');

  /** @param {*} entry @return {boolean} */
  const missingOnAndroid = (entry) => {
    const support = entry?.__compat?.support?.firefox_android;
    return (Array.isArray(support) ? support[0] : support)?.version_added === false;
  };

  /** Every chrome.<namespace>.<member> and browser.<namespace>.<member> in FastStream's own code. */
  function apiUses() {
    const uses = new Map();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'modules') walk(file);
        } else if (/\.m?js$/.test(entry.name)) {
          for (const m of fs.readFileSync(file, 'utf8').matchAll(/\b(?:chrome|browser)\.([a-zA-Z]+)\.([a-zA-Z]+)/g)) {
            const name = `${m[1]}.${m[2]}`;
            if (!uses.has(name)) uses.set(name, path.relative(root, file).replace(/\\/g, '/'));
          }
        }
      }
    };
    walk(path.join(root, 'chrome'));
    return uses;
  }

  it('is read from Mozilla\'s data', () => {
    expect(missingOnAndroid(bcd.webextensions.api.commands)).toBe(true);
    expect(missingOnAndroid(bcd.webextensions.api.runtime.connectNative)).toBe(true);
    expect(missingOnAndroid(bcd.webextensions.api.tabs)).toBe(false);
  });

  it('lists every API the code uses that Firefox for Android does not have', () => {
    const uses = apiUses();
    expect(uses.size).toBeGreaterThan(40);
    const missing = [];
    for (const [name, file] of uses) {
      const [ns, member] = name.split('.');
      const api = bcd.webextensions.api[ns];
      if (missingOnAndroid(api) || missingOnAndroid(api?.[member])) missing.push(`${name} (${file})`);
    }
    // A new one: guard it where it is used, add it here, and see that the tests above still pass.
    expect(missing.filter((use) => !lacked(use.split(' ')[0]))).toEqual([]);
  });
});

describe('the manifest', () => {
  it('declares Firefox for Android in both Firefox builds, with the desktop\'s floor', () => {
    const build = fs.readFileSync(path.join(root, 'build.mjs'), 'utf8');
    const floors = [...build.matchAll(/strict_min_version: '([\d.]+)'/g)].map((m) => m[1]);
    expect(build.match(/gecko_android: \{/g)).toHaveLength(2);
    expect(floors).toHaveLength(4);
    expect(new Set(floors).size).toBe(1);
  });
});
