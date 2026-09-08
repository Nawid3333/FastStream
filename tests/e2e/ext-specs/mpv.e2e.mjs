// End-to-end proof that MPV mode reaches mpv with usable headers.
//
// Every other check on this feature is a unit test or a hand-run of the
// native host. Neither covers the part that was actually broken: the
// background's webRequest path, where the Referer/Origin the CDN checks were
// being dropped before they were ever read. This drives the whole chain --
//
//   allowlisted page -> webRequest detection -> MpvBackend
//     -> com.faststream.mpv native host -> mpv -> HTTP request
//
// -- and inspects what mpv actually put on the wire.
//
// Requires the native host to be installed (native-host/install.ps1) and mpv
// on the machine. Both are skipped, not failed, when missing: this suite also
// runs on machines that have neither.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import * as url from 'node:url';

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../../..');
const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

// Two origins on purpose. A real stream sits on a CDN separate from the page,
// and that is what puts an Origin header on the request -- a same-origin
// <video src> has none, so a single-origin test could never prove Origin is
// relayed.
const SITE_PORT = 41993;
const CDN_PORT = 41994;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const CDN = `http://127.0.0.1:${CDN_PORT}`;

// Requests carrying icy-metadata come from mpv's libavformat HTTP client; the
// browser never sends it. That is how a recorded request is attributed.
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

// Decided at load time so the case reports as pending rather than as a pass
// that never ran anything.
const HAVE_HOST = hostInstalled();

describe('MPV mode, end to end', function() {
  before(async function() {
    const clip = fs.readFileSync(path.join(root, 'tests/e2e/fixtures/sample.mp4'));

    siteServer = http.createServer((req, res) => {
      requests.push({origin: 'site', url: req.url, headers: req.headers});
      if (req.url.startsWith('/watch')) {
        res.writeHead(200, {'Content-Type': 'text/html'});
        // crossorigin makes the media load a CORS request, which is what adds
        // the Origin header. The source is attached after a beat so the
        // background has certainly processed tabs.onUpdated and put the tab
        // in MPV mode first; that race is not what this test measures.
        res.end(`<!doctype html><title>mpv test</title>
          <video id="v" muted autoplay loop preload="auto"
                 crossorigin="anonymous"></video>
          <script>
            setTimeout(() => {
              const v = document.getElementById('v');
              v.src = '${CDN}/clip.mp4';
              // load() and play() are belt and braces: a window that is not
              // focused will not start a media fetch on src alone.
              v.load();
              v.play().catch(() => {});
            }, 1500);
          </script>`);
        return;
      }
      res.writeHead(404);
      res.end('no');
    });

    cdnServer = http.createServer((req, res) => {
      requests.push({origin: 'cdn', url: req.url, headers: req.headers});
      if (req.url.startsWith('/clip.mp4')) {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(clip.length),
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(req.method === 'HEAD' ? undefined : clip);
        return;
      }
      res.writeHead(404);
      res.end('no');
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
    // mpv is launched detached, so it outlives the host and must be cleaned
    // up here rather than left on the developer's desktop.
    try {
      execFileSync('taskkill', ['/F', '/IM', 'mpv.exe'],
          {stdio: 'ignore'});
    } catch (e) {
      // No mpv running: nothing to clean up.
    }
  });

  (HAVE_HOST ? it : it.skip)(
      'hands a detected stream to mpv with Referer, Origin and User-Agent',
      async function() {
        // 1. Turn on MPV mode and allowlist the test server, then make the
        //    background re-read options.
        await browser.url(OPENER_URL);
        await browser.execute((u) => window.open(u, '_blank'),
            ORIGIN + '/player/index.html');
        // Find the extension window by its URL rather than by assuming it is
        // the newest handle. Handle order is not guaranteed, and landing on
        // the opener page instead gives a bare "chrome is not defined".
        await browser.waitUntil(async () => {
          for (const handle of await browser.getWindowHandles()) {
            await browser.switchToWindow(handle);
            if ((await browser.getUrl()).startsWith(ORIGIN)) {
              return true;
            }
          }
          return false;
        }, {timeout: 20000, timeoutMsg: 'the extension page never opened'});

        const stored = await browser.executeAsync((site, done) => {
          chrome.storage.local.set({
            options: JSON.stringify({
              mpvMode: true,
              mpvAllowlist: [site],
            }),
          }, () => {
            chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
              void chrome.runtime.lastError;
              chrome.storage.local.get('options', (r) => done(r.options));
            });
          });
        }, SITE);
        expect(JSON.parse(stored).mpvMode).toBe(true);

        // Give the background a moment to apply the reloaded options.
        await browser.pause(1000);

        // 2. Drop the extension page and drive the remaining window. Leaving
        //    two windows open makes the media fetch depend on which one has
        //    focus, which is not what this test is measuring.
        const remaining = await browser.getWindowHandles();
        if (remaining.length > 1) {
          await browser.closeWindow();
          await browser.switchToWindow(
              (await browser.getWindowHandles())[0]);
        }

        // 3. Visit the allowlisted page. The <video> source appears 1.5s in.
        await browser.url(`${SITE}/watch`);

        // 4. Wait for mpv itself to fetch the stream.
        await browser.waitUntil(
            async () => requests.some(isMpvRequest),
            {
              timeout: 45000,
              interval: 500,
              timeoutMsg: 'mpv never requested the stream. Recorded: ' +
                JSON.stringify(requests.map((r) => ({
                  url: r.url,
                  ua: r.headers['user-agent'],
                }))),
            });

        const fromMpv = requests.filter(isMpvRequest);
        console.log(`      mpv made ${fromMpv.length} request(s)`);
        console.log('      headers:', JSON.stringify(fromMpv[0].headers, null, 2)
            .split('\n').join('\n      '));

        const h = fromMpv[0].headers;
        expect(fromMpv[0].origin).toBe('cdn');
        expect(fromMpv[0].url).toContain('/clip.mp4');
        // The three headers the fix is about. Before it, all three were
        // absent: the background read them after its first await, by which
        // point deleteHeaderCache had already dropped them.
        // Origin-only, not `${SITE}/watch`: Firefox's default referrer policy
        // is strict-origin-when-cross-origin, so the page path is stripped on
        // a cross-origin media request. That is the value a CDN checks, and
        // the value mpv must be given.
        expect(h.referer).toBe(`${SITE}/`);
        expect(h.origin).toBe(SITE);
        // The whole point of relaying User-Agent: without it this is "libmpv".
        expect(h['user-agent']).toContain('Firefox');

        // 5. One page, one mpv window.
        expect(fromMpv.filter((r) => r.url.startsWith('/clip.mp4')).length)
            .toBe(1);

        // 6. Handing off to mpv pauses the page, so the site is not still
        //    streaming behind the external player. The clip loops, so it
        //    cannot have stopped by reaching its end.
        await browser.waitUntil(async () => {
          return await browser.execute(() => {
            const v = document.getElementById('v');
            return !!v && v.paused;
          });
        }, {
          timeout: 15000,
          interval: 250,
          timeoutMsg: 'the page video kept playing after the mpv handoff',
        });

        const ended = await browser.execute(() => {
          return document.getElementById('v').ended;
        });
        expect(ended).toBe(false);
      });
});
