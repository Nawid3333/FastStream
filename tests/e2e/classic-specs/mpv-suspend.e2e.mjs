// One page, one mpv window - even when Firefox suspended the background in
// between.
//
// MPV mode hands only the first stream a page produces to mpv; the rest stay
// tracked for the player's buttons. That latch lived only in the background's
// memory, and Firefox unloads the background after about 30 idle seconds -
// typically while the user is watching in mpv. The page's next stream request
// then woke a background that no longer knew it had already handed this page
// off, and opened a second mpv window.
//
// Like mpv.e2e.mjs this drives the real native host and mpv, and skips when
// the host is not installed.

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

const SITE_PORT = 41996;
const CDN_PORT = 41997;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const CDN = `http://127.0.0.1:${CDN_PORT}`;

// See mpv.e2e.mjs: only mpv's HTTP client sends icy-metadata.
const isMpvRequest = (r) => 'icy-metadata' in r.headers;

let siteServer;
let cdnServer;
const requests = [];

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
 * Suspends the background event page, as Firefox does once it has been idle.
 * @return {Promise<void>}
 */
async function suspendBackground() {
  await browser.setMozContext('chrome');
  let result;
  try {
    result = await browser.executeAsync((extId, done) => {
      (async () => {
        try {
          await WebExtensionPolicy.getByID(extId).extension.terminateBackground();
          done({ok: true});
        } catch (e) {
          done({err: String(e)});
        }
      })();
    }, EXTENSION_ID);
  } finally {
    await browser.setMozContext('content');
  }
  if (!result || !result.ok) {
    throw new Error('could not suspend the background: ' + JSON.stringify(result));
  }
}

describe('MPV mode across a suspended background', function() {
  before(async function() {
    const clip = fs.readFileSync(path.join(root, 'tests/e2e/fixtures/sample.mp4'));

    siteServer = http.createServer((req, res) => {
      res.writeHead(200, {'Content-Type': 'text/html'});
      // window.loadAgain() is how the spec makes the page ask for its stream
      // again later, the way a site's player does on a seek or a quality
      // switch. The query string keeps it off the media cache, so the request
      // really reaches the network, and webRequest, again.
      res.end(`<!doctype html><title>mpv suspend test</title>
        <video id="v" muted autoplay loop preload="auto"
               crossorigin="anonymous"></video>
        <script>
          function load(src) {
            const v = document.getElementById('v');
            v.src = src;
            v.load();
            v.play().catch(() => {});
          }
          window.loadAgain = () => load('${CDN}/clip.mp4?again=' + Date.now());
          // Named after the page, so mpv's request says which page it
          // came from.
          setTimeout(() => load('${CDN}/clip.mp4?page=' + location.pathname), 1500);
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
  });

  after(async function() {
    if (siteServer) await new Promise((r) => siteServer.close(r));
    if (cdnServer) await new Promise((r) => cdnServer.close(r));
    // Only the mpv windows this run started; see mpv.e2e.mjs.
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
      'does not hand the same page to mpv a second time',
      async function() {
        await browser.url(OPENER_URL);
        await browser.execute((u) => window.open(u, '_blank'),
            ORIGIN + '/player/index.html');
        await browser.waitUntil(async () => {
          for (const handle of await browser.getWindowHandles()) {
            await browser.switchToWindow(handle);
            if ((await browser.getUrl()).startsWith(ORIGIN)) {
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
        await browser.closeWindow();
        await browser.switchToWindow((await browser.getWindowHandles())[0]);

        await browser.url(`${SITE}/watch`);
        await browser.waitUntil(async () => requests.some(isMpvRequest), {
          timeout: 45000,
          interval: 500,
          timeoutMsg: 'mpv never requested the stream',
        });

        // Control: with the background awake, a repeat request from the same
        // page is held back by the latch.
        await browser.execute(() => window.loadAgain());
        await browser.pause(5000);
        expect(requests.filter(isMpvRequest).length).toBe(1);

        await suspendBackground();
        const browserRequestsBefore = requests.filter((r) => !isMpvRequest(r)).length;
        await browser.execute(() => window.loadAgain());
        // The page's request itself has to have happened, or "mpv was not
        // asked again" would prove nothing.
        await browser.waitUntil(
            async () => requests.filter((r) => !isMpvRequest(r)).length > browserRequestsBefore,
            {timeout: 15000, timeoutMsg: 'the page never asked for its stream again'});
        await browser.pause(8000);

        expect(requests.filter(isMpvRequest).map((r) => r.url))
            .toEqual(['/clip.mp4?page=/watch']);

        // The latch is per page. Restored as set, it must still be cleared by
        // the next episode, or every page after a wake is silently dropped.
        await suspendBackground();
        await browser.url(`${SITE}/watch2`);
        await browser.waitUntil(
            async () => requests.some((r) => isMpvRequest(r) && r.url === '/clip.mp4?page=/watch2'),
            {
              timeout: 45000,
              interval: 500,
              timeoutMsg: 'the next page never reached mpv after a wake: ' +
                JSON.stringify(requests.filter(isMpvRequest).map((r) => r.url)),
            });
        await browser.pause(3000);
        expect(requests.filter(isMpvRequest).map((r) => r.url))
            .toEqual(['/clip.mp4?page=/watch', '/clip.mp4?page=/watch2']);
      });
});
