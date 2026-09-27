// Runs a function in a page of the installed extension, where chrome.* is available: the
// specs set options there (the auto-enable list) the way the options page does.
//
// Waiting for the new tab's URL was not enough. window.open() gives the tab its URL before
// the extension page has loaded into it, and a script run in that moment finds no
// `chrome`: "ReferenceError: chrome is not defined" in page-subtitles, embed-page-query and
// the live suite on 2026-09-27, twice in a row on WSL's Ubuntu 24.04. The wait now also
// needs the page's chrome.storage. The four specs that use this each had their own copy.

import {browser} from '@wdio/globals';

import {EXTENSION_UUID, OPENER_URL} from './wdio.extension.conf.mjs';

const PLAYER_PAGE = `moz-extension://${EXTENSION_UUID}/player/index.html`;

/**
 * Runs a function in a page of the extension, where chrome.* is available.
 * @param {Function} fn - Called as fn(arg, done).
 * @param {*} arg - A serialisable argument.
 * @return {Promise<*>} Whatever fn passed to done.
 */
export async function inExtensionPage(fn, arg) {
  const opener = await browser.getWindowHandle();
  await browser.url(OPENER_URL);
  await browser.execute((u) => window.open(u, '_blank'), PLAYER_PAGE + '?t=' + Date.now());
  let handle;
  await browser.waitUntil(async () => {
    for (const h of await browser.getWindowHandles()) {
      await browser.switchToWindow(h);
      if (!(await browser.getUrl()).startsWith(PLAYER_PAGE)) {
        continue;
      }
      // A page still loading may refuse the script; that is "not yet" too.
      const ready = await browser.execute(() => typeof chrome !== 'undefined' && !!chrome.storage?.local)
          .catch(() => false);
      if (ready) {
        handle = h;
        return true;
      }
    }
    return false;
  }, {timeout: 20000, interval: 200, timeoutMsg: 'the extension page never opened'});
  try {
    return await browser.executeAsync(fn, arg);
  } finally {
    await browser.switchToWindow(handle);
    await browser.closeWindow();
    await browser.switchToWindow(opener);
  }
}
