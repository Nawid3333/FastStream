// What the classic specs (tests/e2e/classic-specs, wdio.classic.conf.mjs) all do in Firefox's
// own chrome: run a function there, click FastStream's toolbar button, and stop the
// background as Firefox does when it idles. Each spec had its own copy, eight of the first
// (#266); a fix to one now reaches all of them.

import {browser} from '@wdio/globals';

import {EXTENSION_ID} from './wdio.extension.conf.mjs';

/**
 * Runs an async function in Firefox's chrome context.
 * @param {Function} fn - Called as fn(...args, done).
 * @param {...*} args - Serialisable arguments.
 * @return {Promise<*>} Whatever fn passed to done.
 */
export async function inChrome(fn, ...args) {
  await browser.setMozContext('chrome');
  try {
    return await browser.executeAsync(fn, ...args);
  } finally {
    await browser.setMozContext('content');
  }
}

/**
 * Clicks FastStream's toolbar button in a window's selected tab, as a user does.
 * @param {string} windowHandle - The window (its selected tab gets the click).
 * @param {number} [times] - How many clicks, one after the other.
 * @return {Promise<void>}
 */
export async function clickToolbar(windowHandle, times = 1) {
  await browser.switchToWindow(windowHandle);
  const result = await inChrome((extId, times, done) => {
    (async () => {
      try {
        const {ExtensionParent} = ChromeUtils.importESModule(
            'resource://gre/modules/ExtensionParent.sys.mjs');
        const extension = WebExtensionPolicy.getByID(extId).extension;
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        const action = ExtensionParent.apiManager.global.browserActionFor(extension);
        for (let i = 0; i < times; i++) {
          await action.triggerAction(win);
        }
        done({ok: true});
      } catch (e) {
        done({err: String(e)});
      }
    })();
  }, EXTENSION_ID, times);
  if (!result || !result.ok) {
    throw new Error('could not click the toolbar button: ' + JSON.stringify(result));
  }
}

/**
 * Stops the background script, as Firefox does to an idle one.
 * @return {Promise<void>}
 */
export async function suspendBackground() {
  const result = await inChrome((extId, done) => {
    WebExtensionPolicy.getByID(extId).extension.terminateBackground()
        .then(() => done({ok: true}), (e) => done({err: String(e)}));
  }, EXTENSION_ID);
  if (!result || !result.ok) {
    throw new Error('could not suspend the background: ' + JSON.stringify(result));
  }
}
