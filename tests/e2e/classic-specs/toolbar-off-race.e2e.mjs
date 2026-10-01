// Turning FastStream off right after turning it on removes the in-page player.
//
// A toolbar click on a page with a detected video turns FastStream on and opens the player
// over the page's video: the background measures the page's videos (a round trip to
// content.js), asks content.js to put the player iframe in, and hears the player announce
// itself (PLAYER_LOADED) only once it has loaded. The Off click undid a player it had heard
// from - frame.isPlayer - and nothing else. A click in between left the player on the page
// while the toolbar said Off: during the measurement the player was not asked for yet, and
// the answer went on to open it anyway; after the request, frame.playerOpening said a
// player was on its way, and the Off path did not look at it. The MPV toolbar cycle checks
// both (hasOrOpeningPlayer); the plain On/Off toggle now does too, and the player is not
// opened for a tab that was turned off while its videos were being measured.
//
// All of that lives in the background's memory. Firefox keeps the background running
// while a player is open (an extension page), but can still stop it - after a hang, or
// with about:debugging's Terminate - and a restarted background knew no player, so Off
// left it playing under a toolbar that said Off. Now it asks the tab (tabHasPlayer):
// each frame's content script looks for a player iframe.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as url from 'node:url';

import {browser, expect} from '@wdio/globals';

import {EXTENSION_ID, EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';
import {hasExtensionApi} from '../extension-api.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../../..');

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;
const SITE_PORT = 41985;
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

/**
 * Clicks the extension's toolbar button for the selected tab, `times` times in a row
 * without waiting in between.
 * @param {number} times - How many clicks.
 */
async function clickToolbar(times) {
  await browser.switchToWindow(siteHandle);
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
 * Suspends the background event page, as Firefox does once it has been idle.
 * @return {Promise<void>}
 */
async function suspendBackground() {
  const result = await inChrome((extId, done) => {
    (async () => {
      try {
        await WebExtensionPolicy.getByID(extId).extension.terminateBackground();
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
 * @return {Promise<string>} 'on' or 'off'.
 */
async function tabMode() {
  await browser.switchToWindow(extHandle);
  return await browser.executeAsync((site, done) => {
    chrome.tabs.query({}, (tabs) => {
      const tab = tabs.find((t) => t.url && t.url.startsWith(site + '/'));
      if (!tab) {
        done('no site tab');
        return;
      }
      chrome.action.getBadgeText({tabId: tab.id}, (badge) => done(badge === 'On' ? 'on' : 'off'));
    });
  }, SITE);
}

/**
 * Whether the site page has FastStream's player iframe in it.
 * @return {Promise<boolean>}
 */
async function hasOverlayPlayer() {
  await browser.switchToWindow(siteHandle);
  return await browser.execute(() => {
    return Array.from(document.querySelectorAll('iframe')).some((f) => f.src.includes('player/index.html'));
  });
}

/**
 * Whether the player in the page has announced itself to the background. Once it has
 * (PLAYER_LOADED), the background links it to its iframe: the player posts a key to the
 * page. So a message from the player's iframe means the background already counts it as
 * a player.
 * @return {Promise<boolean>}
 */
async function playerAnnounced() {
  await browser.switchToWindow(siteHandle);
  return await browser.execute(() => window.__playerAnnounced === true);
}

/**
 * Loads the site page and waits until its video has data, which is when the background
 * has detected it as a source.
 */
async function openSite() {
  await browser.switchToWindow(siteHandle);
  await browser.url(`${SITE}/watch?t=${Date.now()}`);
  await browser.waitUntil(async () => browser.execute(() => {
    const video = document.querySelector('video');
    return !!video && video.readyState >= 2;
  }), {timeout: 20000, timeoutMsg: 'the page\'s video never loaded'});
  await browser.execute(() => {
    window.__playerAnnounced = false;
    window.addEventListener('message', (e) => {
      const frame = Array.from(document.querySelectorAll('iframe')).find((f) => f.contentWindow === e.source);
      if (frame && frame.src.includes('player/index.html')) {
        window.__playerAnnounced = true;
      }
    });
  });
  // The detection is an async webRequest event on top of the load.
  await browser.pause(500);
}

describe('Toolbar: Off right after On', function() {
  before(async function() {
    const clip = fs.readFileSync(path.join(root, 'tests/e2e/fixtures/sample.mp4'));
    siteServer = http.createServer((req, res) => {
      if (req.url.startsWith('/clip.mp4')) {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(clip.length),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(clip);
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(`<!doctype html><title>toolbar race</title>
        <video id="v" muted preload="auto" style="width: 640px; height: 360px"
               src="/clip.mp4?t=${Date.now()}"></video>`);
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });

    await browser.url(OPENER_URL);
    await browser.execute((u) => window.open(u, '_blank'), ORIGIN + '/player/index.html');
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        if ((await browser.getUrl()).startsWith(ORIGIN) && await hasExtensionApi()) {
          extHandle = handle;
          return true;
        }
      }
      return false;
    }, {timeout: 20000, timeoutMsg: 'the extension page never opened'});
    // The opener tab, not the welcome page the install may have opened.
    for (const handle of await browser.getWindowHandles()) {
      if (handle === extHandle) continue;
      await browser.switchToWindow(handle);
      if ((await browser.getUrl()).startsWith(OPENER_URL)) {
        siteHandle = handle;
      }
    }
  });

  after(async function() {
    if (siteServer) await new Promise((r) => siteServer.close(r));
  });

  it('turns on and opens the player on one click, and off again (the baseline)', async function() {
    await openSite();
    await clickToolbar(1);
    await browser.waitUntil(hasOverlayPlayer, {timeout: 15000, timeoutMsg: 'the player never opened'});
    expect(await tabMode()).toBe('on');
    // Off once the player has loaded - the case that always worked - which also leaves
    // the tab off for the next test.
    await browser.waitUntil(playerAnnounced, {timeout: 15000, timeoutMsg: 'the player never announced itself'});
    await clickToolbar(1);
    await browser.waitUntil(async () => !(await hasOverlayPlayer()),
        {timeout: 15000, timeoutMsg: 'Off left the loaded player on the page'});
    expect(await tabMode()).toBe('off');
  });

  it('leaves no player on the page after On and Off in quick succession', async function() {
    await openSite();
    await clickToolbar(2);
    // Long enough for a player that was on its way to have arrived.
    await browser.pause(4000);
    expect(await tabMode()).toBe('off');
    expect(await hasOverlayPlayer()).toBe(false);
  });

  it('removes a player that is still loading when Off is clicked', async function() {
    await openSite();
    await clickToolbar(1);
    // The iframe is in the page as soon as content.js puts it there; the player inside it
    // announces itself only once it has loaded. Off in between.
    await browser.waitUntil(hasOverlayPlayer, {timeout: 15000, interval: 20,
      timeoutMsg: 'the player iframe never appeared'});
    // Logged, not asserted: whether this click beat the player's announcement is up to
    // the machine. When it did not, this is the baseline's case.
    console.log('      player announced before Off:', await playerAnnounced());
    await clickToolbar(1);
    await browser.pause(4000);
    expect(await tabMode()).toBe('off');
    expect(await hasOverlayPlayer()).toBe(false);
  });

  it('removes the player when Off is clicked after the background was suspended', async function() {
    await openSite();
    await clickToolbar(1);
    await browser.waitUntil(playerAnnounced, {timeout: 15000, timeoutMsg: 'the player never announced itself'});
    // Stopped the way Firefox stops a hung background: what it knew about the page's
    // frames goes with it, and the player stays.
    await suspendBackground();
    await clickToolbar(1);
    await browser.pause(4000);
    expect(await tabMode()).toBe('off');
    expect(await hasOverlayPlayer()).toBe(false);
  });
});
