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

  it('asks the background in a player framed in a page, which has no chrome.tabs', () => {
    // It did nothing there (the review of 2026-11-13).
    const chrome = extension(false);
    EnvUtils.openExternalURL('https://www.opensubtitles.com/en/subtitles/x');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({type: 'OPEN_EXTERNAL_URL', url: 'https://www.opensubtitles.com/en/subtitles/x'});
  });
});
