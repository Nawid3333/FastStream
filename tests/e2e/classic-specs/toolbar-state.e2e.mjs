// A toolbar choice on an MPV-allowlisted site has to survive a reload of the
// tab.
//
// Visiting an allowlisted site starts MPV mode on its own. Once the user has
// used the toolbar button to pick something else for that tab - the in-page
// player, or FastStream off - a reload must not put the tab back into MPV
// mode. Within one lifetime of the background script that already held. It
// broke because Firefox runs the background as an event page and suspends it
// after about 30 idle seconds, which wiped every tab's state; the reload then
// woke a fresh background that saw an allowlisted site it had never been told
// about, and auto-started MPV again.
//
// The spec reads the tab's mode off the toolbar button (title and badge),
// which is what the user sees, and never plays media, so no mpv is launched.

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {EXTENSION_ID, EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;
const SITE_PORT = 41995;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

let siteServer;
let extHandle;
let siteHandle;

/**
 * Runs an async function in Firefox's chrome context.
 * @param {Function} fn - Called as fn(...args, done).
 * @param {...*} args - Serialisable arguments.
 * @return {Promise<*>} Whatever fn passed to done.
 */
async function inChrome(fn, ...args) {
  await browser.setMozContext('chrome');
  try {
    return await browser.executeAsync(fn, ...args);
  } finally {
    await browser.setMozContext('content');
  }
}

/** Clicks the extension's toolbar button for the selected tab. */
async function clickToolbar() {
  await browser.switchToWindow(siteHandle);
  const result = await inChrome((extId, done) => {
    (async () => {
      try {
        const {ExtensionParent} = ChromeUtils.importESModule(
            'resource://gre/modules/ExtensionParent.sys.mjs');
        const extension = WebExtensionPolicy.getByID(extId).extension;
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        const action = ExtensionParent.apiManager.global.browserActionFor(extension);
        await action.triggerAction(win);
        done({ok: true});
      } catch (e) {
        done({err: String(e)});
      }
    })();
  }, EXTENSION_ID);
  if (!result || !result.ok) {
    throw new Error('could not click the toolbar button: ' + JSON.stringify(result));
  }
}

/**
 * Suspends the background event page, as Firefox does once it has been idle.
 * @return {Promise<void>}
 */
async function suspendBackground() {
  const result = await inChrome((extId, done) => {
    (async () => {
      try {
        const extension = WebExtensionPolicy.getByID(extId).extension;
        await extension.terminateBackground();
        done({ok: true});
      } catch (e) {
        done({err: String(e)});
      }
    })();
  }, EXTENSION_ID);
  if (!result || !result.ok) {
    throw new Error('could not suspend the background: ' + JSON.stringify(result));
  }
}

/**
 * Reads the site tab's mode off its toolbar button.
 * @return {Promise<string>} 'mpv', 'on' or 'off'.
 */
async function tabMode() {
  await browser.switchToWindow(extHandle);
  return await browser.executeAsync((site, done) => {
    // Filtered here rather than with a url pattern: match patterns carry no
    // port, and the site is told apart from the opener page only by its port.
    chrome.tabs.query({}, (tabs) => {
      const tab = tabs.find((t) => t.url && t.url.startsWith(site + '/'));
      if (!tab) {
        done('no site tab');
        return;
      }
      const tabId = tab.id;
      chrome.action.getTitle({tabId}, (title) => {
        chrome.action.getBadgeText({tabId}, (badge) => {
          if (title.includes('MPV')) done('mpv');
          else if (badge === 'On') done('on');
          else done('off');
        });
      });
    });
  }, SITE);
}

/**
 * Waits until the site tab shows the expected mode, and fails naming the one
 * it did show.
 * @param {string} expected - 'mpv', 'on' or 'off'.
 * @param {string} when - What just happened, for the failure message.
 */
async function expectMode(expected, when) {
  let last;
  try {
    await browser.waitUntil(async () => {
      try {
        last = await tabMode();
      } catch (e) {
        last = String(e);
      }
      return last === expected;
    }, {timeout: 5000, interval: 250});
  } catch (e) {
    throw new Error(`${when}: expected the tab to be '${expected}', it is '${last}'`);
  }
  // Held, not just passed through: a late auto-start would flip it back.
  await browser.pause(1500);
  expect(await tabMode()).toBe(expected);
}

/**
 * Reloads the site tab and waits for the load to finish.
 * @return {Promise<void>}
 */
async function reloadSite() {
  await browser.switchToWindow(siteHandle);
  await browser.refresh();
}

describe('Toolbar choice on an MPV-allowlisted site', function() {
  before(async function() {
    siteServer = http.createServer((req, res) => {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end('<!doctype html><title>allowlisted</title><p>no media here</p>');
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });

    await browser.url(OPENER_URL);
    await browser.execute((u) => window.open(u, '_blank'),
        ORIGIN + '/player/index.html');
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        if ((await browser.getUrl()).startsWith(ORIGIN)) {
          extHandle = handle;
          return true;
        }
      }
      return false;
    }, {timeout: 20000, timeoutMsg: 'the extension page never opened'});

    await browser.executeAsync((site, done) => {
      chrome.storage.local.set({
        options: JSON.stringify({mpvMode: true, mpvAllowlist: [site]}),
      }, () => {
        chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
          void chrome.runtime.lastError;
          done(true);
        });
      });
    }, SITE);
    await browser.pause(1000);

    siteHandle = (await browser.getWindowHandles()).find((h) => h !== extHandle);
  });

  after(async function() {
    if (siteServer) await new Promise((r) => siteServer.close(r));
  });

  for (const [target, clicks] of [['on', 1], ['off', 2]]) {
    it(`keeps '${target}' across reloads, including after the background was suspended`,
        async function() {
          await browser.switchToWindow(siteHandle);
          await browser.url(`${SITE}/watch-${target}`);
          await expectMode('mpv', 'visiting the allowlisted site');

          // MPV -> On -> Off
          for (let i = 0; i < clicks; i++) {
            await clickToolbar();
          }
          await expectMode(target, 'after the toolbar click');

          await reloadSite();
          await expectMode(target, 'after a reload');

          await suspendBackground();
          await reloadSite();
          await expectMode(target, 'after a reload with the background suspended');

          // Suspended again and reloaded again: the restored state has to
          // stick, not just the first time.
          await suspendBackground();
          await reloadSite();
          await expectMode(target, 'after a second suspend and reload');

          // Leaving the site is still a fresh decision.
          await browser.switchToWindow(siteHandle);
          await browser.url('http://localhost:' + SITE_PORT + '/elsewhere');
          await browser.url(`${SITE}/watch-${target}-again`);
          await expectMode('mpv', 'coming back to the site from another one');
        });
  }
});
