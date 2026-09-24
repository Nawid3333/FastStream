// The reordered MPV toolbar cycle (MPV -> Off -> On -> MPV) actually does
// what each state implies, not just that the badge changes.
//
// toolbar-state.e2e.mjs already covers a chosen state surviving reloads and
// background suspends. This spec drives the cycle itself and checks the
// underlying effect at every step:
//   - MPV -> Off really leaves the page alone (no in-page overlay, and the
//     click does not itself launch a second mpv window).
//   - Off -> On really swaps the page's <video> for FastStream's own overlay
//     iframe, from the stream already detected while the tab sat idle.
//   - On -> MPV is the transition that never existed before the reorder (the
//     old cycle went MPV -> On -> Off, never back the other way from a
//     toolbar click). There is no message that retracts an overlay iframe,
//     so this reloads the tab to tear it down; the reload's freshly detected
//     stream then has to reach mpv through the ordinary auto-forward path
//     with no help from this code path.
//
// Drives the real native host and mpv; skips, not fails, when the host is
// not installed.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import * as url from 'node:url';

import {browser, expect} from '@wdio/globals';

import {EXTENSION_ID, EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../../..');
const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

const SITE_PORT = 41998;
const CDN_PORT = 41999;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const CDN = `http://127.0.0.1:${CDN_PORT}`;

// Only mpv's HTTP client sends this header; see mpv.e2e.mjs.
const isMpvRequest = (r) => 'icy-metadata' in r.headers;

let siteServer;
let cdnServer;
const requests = [];
let extHandle;
let siteHandle;

/** @return {boolean} Whether the native host is registered for Firefox. */
function hostInstalled() {
  try {
    const key = ['HKCU', 'Software', 'Mozilla', 'NativeMessagingHosts',
      'com.faststream.mpv'].join('\\');
    const out = execFileSync('reg', ['query', key],
        {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    const match = out.match(/REG_SZ\s+(.+)/);
    return !!(match && fs.existsSync(match[1].trim()));
  } catch (e) {
    return false;
  }
}

const HAVE_HOST = hostInstalled();

/** @return {Array<number>} Process ids of every running mpv.exe. */
function mpvPids() {
  if (process.platform !== 'win32') {
    return [];
  }
  try {
    const out = execFileSync('tasklist',
        ['/FI', 'IMAGENAME eq mpv.exe', '/FO', 'CSV', '/NH'],
        {encoding: 'utf8'});
    return out.split(String.fromCharCode(10))
        .map((line) => /^"mpv\.exe","(\d+)"/.exec(line.trim()))
        .filter(Boolean)
        .map((m) => Number(m[1]));
  } catch (e) {
    return [];
  }
}

const preexistingMpvPids = new Set(mpvPids());

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

/** Clicks the extension's toolbar button for the focused window. */
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
 * Reads the site tab's mode off its toolbar button.
 * @return {Promise<string>} 'mpv', 'on' or 'off'.
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
      chrome.action.getTitle({tabId: tab.id}, (title) => {
        chrome.action.getBadgeText({tabId: tab.id}, (badge) => {
          if (title.includes('MPV')) done('mpv');
          else if (badge === 'On') done('on');
          else done('off');
        });
      });
    });
  }, SITE);
}

/**
 * Waits until the site tab shows the expected mode.
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
    }, {timeout: 15000, interval: 250});
  } catch (e) {
    throw new Error(`${when}: expected the tab to be '${expected}', it is '${last}'`);
  }
}

/**
 * Whether the site page currently has FastStream's overlay iframe in place
 * of its native <video>.
 * @return {Promise<boolean>}
 */
async function hasOverlayPlayer() {
  await browser.switchToWindow(siteHandle);
  return await browser.execute(() => {
    return Array.from(document.querySelectorAll('iframe'))
        .some((f) => f.src.includes('player/index.html'));
  });
}

describe('The MPV toolbar cycle (MPV -> Off -> On -> MPV)', function() {
  before(async function() {
    const clip = fs.readFileSync(path.join(root, 'tests/e2e/fixtures/sample.mp4'));

    siteServer = http.createServer((req, res) => {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(`<!doctype html><title>toolbar cycle test</title>
        <video id="v" muted autoplay loop preload="auto"
               crossorigin="anonymous"></video>
        <script>
          setTimeout(() => {
            const v = document.getElementById('v');
            // Cache-busted: step 4 reloads this same page, and a repeat
            // request for the exact same URL can be served out of Firefox's
            // HTTP cache with no network traffic at all, which would mean no
            // webRequest event to redetect it by - see mpv-suspend.e2e.mjs.
            v.src = '${CDN}/clip.mp4?t=' + Date.now();
            v.load();
            v.play().catch(() => {});
          }, 1500);
        </script>`);
    });

    cdnServer = http.createServer((req, res) => {
      requests.push({url: req.url, headers: req.headers});
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(clip.length),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(req.method === 'HEAD' ? undefined : clip);
    });

    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) => {
      cdnServer.on('error', reject);
      cdnServer.listen(CDN_PORT, '127.0.0.1', resolve);
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
    if (cdnServer) await new Promise((r) => cdnServer.close(r));
    for (const pid of mpvPids()) {
      if (preexistingMpvPids.has(pid)) {
        continue;
      }
      try {
        execFileSync('taskkill', ['/F', '/PID', String(pid)], {stdio: 'ignore'});
      } catch (e) {
        // Already gone.
      }
    }
  });

  (HAVE_HOST ? it : it.skip)(
      'really tears the overlay down and back up at each step, and hands off to mpv both ways',
      async function() {
        // 1. Visiting the allowlisted site auto-starts MPV, and mpv actually
        //    requests the stream.
        await browser.switchToWindow(siteHandle);
        await browser.url(`${SITE}/watch`);
        await expectMode('mpv', 'visiting the allowlisted site');
        await browser.waitUntil(async () => requests.some(isMpvRequest), {
          timeout: 45000,
          interval: 500,
          timeoutMsg: 'mpv never requested the stream on auto-start',
        });
        expect(await hasOverlayPlayer()).toBe(false);

        // 2. MPV -> Off: no overlay appears, and no second mpv request fires
        //    off the back of the click itself.
        const mpvRequestsAtOff = requests.filter(isMpvRequest).length;
        await clickToolbar();
        await expectMode('off', 'clicking the glowing MPV icon');
        await browser.pause(3000);
        expect(await hasOverlayPlayer()).toBe(false);
        expect(requests.filter(isMpvRequest).length).toBe(mpvRequestsAtOff);

        // 3. Off -> On: the overlay iframe actually replaces the page's
        //    video, built from the stream already detected while idle - no
        //    reload, so no new network request for it either.
        const cdnRequestsAtOn = requests.length;
        await clickToolbar();
        await expectMode('on', 'clicking Off');
        await browser.waitUntil(hasOverlayPlayer, {
          timeout: 15000,
          timeoutMsg: 'the in-page player never appeared after Off -> On',
        });
        expect(requests.length).toBe(cdnRequestsAtOn);

        // 4. On -> MPV: the overlay has to come down (there is no message
        //    that retracts one, so the tab reloads), and the reload's fresh
        //    stream detection has to reach mpv on its own, through the
        //    ordinary auto-forward path.
        await clickToolbar();
        await browser.waitUntil(async () => !(await hasOverlayPlayer()), {
          timeout: 15000,
          timeoutMsg: 'the overlay iframe never came down after On -> MPV',
        });
        await expectMode('mpv', 'clicking On');
        try {
          await browser.waitUntil(
              async () => requests.filter(isMpvRequest).length > mpvRequestsAtOff,
              {timeout: 45000, interval: 500});
        } catch (e) {
          // Built here, not as timeoutMsg, which would be evaluated before the
          // wait and miss everything the reload requested. Whether the
          // browser asked for the reloaded page's video at all tells a
          // detection failure apart from a hand-off failure.
          throw new Error('mpv never received a fresh request after On -> MPV. CDN saw: ' +
              JSON.stringify(requests.map((r) => (isMpvRequest(r) ? 'mpv ' : 'browser ') + r.url)));
        }
        expect(await hasOverlayPlayer()).toBe(false);
      });
});
