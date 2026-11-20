import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {EnvUtils} from '../../chrome/player/utils/EnvUtils.mjs';

// EnvUtils.isChrome, isFirefox and isSafari were removed when this project became Firefox
// only. Two callers survived in chrome/player/modules/analyzer, a folder ESLint does not
// look at, and a call to a method that is not there fails only when that code runs: the
// background audio analyzer threw "EnvUtils.isSafari is not a function" in a shipped
// release. Nothing else would notice, so this reads every source file and checks that each
// EnvUtils method it calls exists.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../chrome');

/**
 * Lists the .mjs and .js files under a directory.
 * @param {string} dir - The directory to walk.
 * @return {string[]} Full paths.
 */
function sourceFiles(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return /\.(mjs|js)$/.test(entry.name) ? [full] : [];
  });
}

describe('EnvUtils', () => {
  it('has every method the source calls on it', () => {
    const missing = [];
    let calls = 0;
    for (const file of sourceFiles(root)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const [, method] of text.matchAll(/\bEnvUtils\.([A-Za-z_$][\w$]*)\s*\(/g)) {
        calls++;
        if (typeof EnvUtils[method] !== 'function') {
          missing.push(`${path.relative(root, file)}: EnvUtils.${method}()`);
        }
      }
    }
    // The scan has to be finding something, or an empty list proves nothing.
    expect(calls).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it('no longer asks which browser it is', () => {
    for (const method of ['isChrome', 'isFirefox', 'isSafari']) {
      expect(EnvUtils[method]).toBeUndefined();
    }
  });
});

describe('EnvUtils on Firefox for Android', () => {
  const ANDROID = 'Mozilla/5.0 (Android 15; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0';
  const DESKTOP_SITE = 'Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0';

  afterEach(() => {
    vi.unstubAllGlobals();
    EnvUtils.knownOs = null;
  });

  it('takes Firefox\'s answer over the user agent, which a desktop site changes', async () => {
    vi.stubGlobal('navigator', {userAgent: DESKTOP_SITE, platform: 'Linux aarch64'});
    vi.stubGlobal('chrome', {runtime: {getPlatformInfo: async () => ({os: 'android'})}});
    expect(EnvUtils.isAndroid()).toBe(false);
    expect(await EnvUtils.os()).toBe('android');
    expect(EnvUtils.isAndroid()).toBe(true);
  });

  it('reads the user agent until Firefox answers, and without a runtime', async () => {
    vi.stubGlobal('navigator', {userAgent: ANDROID, platform: 'Linux aarch64'});
    vi.stubGlobal('chrome', undefined);
    expect(EnvUtils.isAndroid()).toBe(true);
    expect(await EnvUtils.os()).toBe('android');

    vi.stubGlobal('navigator', {userAgent: DESKTOP_SITE, platform: 'Linux x86_64'});
    expect(EnvUtils.isAndroid()).toBe(false);
    expect(await EnvUtils.os()).toBe('linux');
  });
});

describe('EnvUtils.openExternalURL', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The extension's chrome, with or without tabs.
   * @param {boolean} withTabs - A player on its own tab has them; one framed in a page not.
   * @return {Object}
   */
  const extension = (withTabs) => {
    const chrome = {extension: {}, runtime: {sendMessage: vi.fn(async () => true)}};
    if (withTabs) chrome.tabs = {create: vi.fn(async () => ({}))};
    vi.stubGlobal('chrome', chrome);
    return chrome;
  };

  it('opens a tab itself where it can', () => {
    const chrome = extension(true);
    EnvUtils.openExternalURL('https://www.opensubtitles.com/en/subtitles/x');
    expect(chrome.tabs.create).toHaveBeenCalledWith({url: 'https://www.opensubtitles.com/en/subtitles/x'});
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('opens a page from the web player with no opener', () => {
    // The update notice's link to the issue page was opened so before it came through here.
    vi.stubGlobal('chrome', undefined);
    const open = vi.fn();
    vi.stubGlobal('window', {open});
    EnvUtils.openExternalURL('https://example.com/page');
    expect(open).toHaveBeenCalledWith('https://example.com/page', '_blank', 'noopener');
  });

  it('asks the background in a player framed in a page, which has no chrome.tabs', () => {
    // It did nothing there.
    const chrome = extension(false);
    EnvUtils.openExternalURL('https://www.opensubtitles.com/en/subtitles/x');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({type: 'OPEN_EXTERNAL_URL', url: 'https://www.opensubtitles.com/en/subtitles/x'});
  });
});
