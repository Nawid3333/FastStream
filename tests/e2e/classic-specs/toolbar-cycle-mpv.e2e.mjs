// The toolbar cycle MPV -> Off -> On -> MPV does what each state implies: Off leaves the page
// alone, On swaps in the overlay from the detected stream, MPV reloads the tab and the fresh stream
// reaches mpv.
//
// Drives the real native host and mpv; skips when the host is not installed.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {browser, expect} from '@wdio/globals';

import {closeSpecMpv, hostInstalled} from '../mpvTestProcesses.mjs';
import {clickToolbar as clickToolbarIn} from '../classic-helpers.mjs';
import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';
import {hasExtensionApi} from '../extension-api.mjs';

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
// Loads of the page itself: a reload is one more.
let pageLoads = 0;
let extHandle;
let siteHandle;

const HAVE_HOST = hostInstalled();

/** Clicks the extension's toolbar button for the focused window. */
const clickToolbar = () => clickToolbarIn(siteHandle);

/**
 * Reads the site tab's mode off its toolbar button.
 * @return {Promise<string>} 'mpv', 'on' or 'off'.
 */
async function tabMode() {
  await browser.switchToWindow(extHandle);
  return await browser.execute((site) => new Promise((done) => {
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
  }), SITE);
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
      // Not /favicon.ico, which the same server answers.
      if (req.url.startsWith('/watch')) pageLoads++;
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
    await browser.execute((u) => void window.open(u, '_blank'),
        ORIGIN + '/player/index.html');
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

    await browser.execute((site) => new Promise((done) => {
      chrome.storage.local.set({
        options: JSON.stringify({mpvMode: true, mpvAllowlist: [site]}),
      }, () => {
        chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
          void chrome.runtime.lastError;
          done(true);
        });
      });
    }), SITE);
    await browser.pause(1000);

    siteHandle = (await browser.getWindowHandles()).find((h) => h !== extHandle);
  });

  after(async function() {
    if (siteServer) await new Promise((r) => siteServer.close(r));
    if (cdnServer) await new Promise((r) => cdnServer.close(r));
    // Only the mpv windows this run started; see mpvTestProcesses.mjs.
    await closeSpecMpv([SITE, CDN]);
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

        // 3. Off -> On: the overlay replaces the video from the stream detected while idle, no
        // reload (that would load the page again).
        const pageLoadsAtOn = pageLoads;
        const cdnRequestsAtOn = requests.length;
        const detected = requests.filter((r) => !isMpvRequest(r)).pop().url;
        await clickToolbar();
        await expectMode('on', 'clicking Off');
        await browser.waitUntil(hasOverlayPlayer, {
          timeout: 15000,
          timeoutMsg: 'the in-page player never appeared after Off -> On',
        });
        expect(pageLoads).toBe(pageLoadsAtOn);
        const strays = requests.slice(cdnRequestsAtOn)
            .filter((r) => isMpvRequest(r) || r.url !== detected)
            .map((r) => `${isMpvRequest(r) ? 'mpv' : 'browser'} ${r.url}`);
        expect(strays).toEqual([]);

        // 4. On -> MPV: the tab reloads to take the overlay down, and the fresh detection reaches
        // mpv on its own.
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
          // built after the wait, not as timeoutMsg: whether the reload asked for the video tells
          // detection from hand-off
          throw new Error('mpv never received a fresh request after On -> MPV. CDN saw: ' +
              JSON.stringify(requests.map((r) => (isMpvRequest(r) ? 'mpv ' : 'browser ') + r.url)));
        }
        expect(await hasOverlayPlayer()).toBe(false);
      });
});
