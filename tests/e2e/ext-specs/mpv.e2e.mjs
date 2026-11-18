// End-to-end: MPV mode reaches mpv with the headers the CDN checks (allowlisted page -> webRequest
// -> MpvBackend -> native host -> mpv -> HTTP).
//
// Needs the native host (native-host/install.ps1) and mpv; skipped, not failed, without them.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as url from 'node:url';

import {browser, expect} from '@wdio/globals';

import {closeSpecMpv, hostInstalled} from '../mpvTestProcesses.mjs';
import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';
import {hasExtensionApi} from '../extension-api.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../../..');
const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

// Two origins: a CDN apart from the page puts an Origin on the request, which a same-origin <video
// src> never has.
const SITE_PORT = 41993;
const CDN_PORT = 41994;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
// Same server, different hostname: that is all "a different site" means to
// the background, which compares URL.hostname to decide a tab has moved on.
const SITE_B = `http://localhost:${SITE_PORT}`;
const CDN = `http://127.0.0.1:${CDN_PORT}`;

// Requests carrying icy-metadata come from mpv's libavformat HTTP client; the
// browser never sends it. That is how a recorded request is attributed.
const isMpvRequest = (r) => 'icy-metadata' in r.headers;

let siteServer;
let cdnServer;
const requests = [];

// Decided at load time so the case reports as pending rather than as a pass
// that never ran anything.
const HAVE_HOST = hostInstalled();

// The page's subtitles (the subtitles case): a file the page's player asks the CDN for, and
// a <track> element on the page.
const CDN_VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello from the CDN\n';
const PAGE_VTT = 'WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nHallo von der Seite\n';

/**
 * The subtitle files the host wrote for mpv since a time: each send's own folder in the
 * temp folder (writeSubtitleFiles in native-host/faststream-mpv-host.mjs).
 * @param {number} since - ms since the epoch.
 * @return {Array<string>} Their texts.
 */
function subtitleFilesSince(since) {
  const texts = [];
  for (const entry of fs.readdirSync(os.tmpdir(), {withFileTypes: true})) {
    if (!entry.isDirectory() || !entry.name.startsWith('faststream-mpv-subs-')) continue;
    const dir = path.join(os.tmpdir(), entry.name);
    // A second of slack: some file systems keep times to the second.
    if (fs.statSync(dir).mtimeMs < since - 1000) continue;
    for (const name of fs.readdirSync(dir)) {
      texts.push(fs.readFileSync(path.join(dir, name), 'utf8'));
    }
  }
  return texts;
}

describe('MPV mode, end to end', function() {
  before(async function() {
    const clip = fs.readFileSync(path.join(root, 'tests/e2e/fixtures/sample.mp4'));

    siteServer = http.createServer((req, res) => {
      requests.push({origin: 'site', url: req.url, headers: req.headers});
      if (req.url === '/subs/de.vtt') {
        res.writeHead(200, {'Content-Type': 'text/vtt'});
        res.end(PAGE_VTT);
        return;
      }
      if (req.url.startsWith('/subtitled')) {
        // The player asks for its subtitle file as it loads (as JW Player does); the
        // <track> is only read, by content.js. The video comes 1.5 s in, as on /watch.
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(`<!doctype html><title>mpv subtitles test</title>
          <video id="v" muted autoplay loop preload="auto" crossorigin="anonymous">
            <track kind="subtitles" label="Deutsch" srclang="de" src="/subs/de.vtt">
          </video>
          <script>
            fetch('${CDN}/subs/episode-en.vtt').catch(() => {});
            setTimeout(() => {
              const v = document.getElementById('v');
              v.src = '${CDN}/clip5.mp4';
              v.load();
              v.play().catch(() => {});
            }, 1500);
          </script>`);
        return;
      }
      if (req.url.startsWith('/watch')) {
        // /watch2 points at a different clip, so a second navigation is
        // distinguishable from a repeat of the first.
        const clipName = req.url.includes('4') ? 'clip4.mp4' :
          req.url.includes('3') ? 'clip3.mp4' :
          req.url.includes('2') ? 'clip2.mp4' : 'clip.mp4';
        res.writeHead(200, {'Content-Type': 'text/html'});
        // crossorigin makes it a CORS request (Origin); the source comes after a beat so the tab is
        // in MPV mode first.
        res.end(`<!doctype html><title>mpv test</title>
          <video id="v" muted autoplay loop preload="auto"
                 crossorigin="anonymous"></video>
          <script>
            setTimeout(() => {
              const v = document.getElementById('v');
              v.src = '${CDN}/' + '${clipName}';
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
      if (req.url === '/subs/episode-en.vtt') {
        res.writeHead(200, {'Content-Type': 'text/vtt', 'Access-Control-Allow-Origin': '*'});
        res.end(CDN_VTT);
        return;
      }
      if (/^\/clip[2-5]?\.mp4/.test(req.url)) {
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
    // Only the windows this run started; see mpvTestProcesses.mjs.
    await closeSpecMpv([SITE, SITE_B, CDN]);
  });

  (HAVE_HOST ? it : it.skip)(
      'hands a detected stream to mpv with Referer, Origin and User-Agent',
      async function() {
        // 1. Turn on MPV mode and allowlist the test server, then make the
        //    background re-read options.
        await browser.url(OPENER_URL);
        await browser.execute((u) => window.open(u, '_blank'),
            ORIGIN + '/player/index.html');
        // the extension window by its URL: handle order is not guaranteed
        await browser.waitUntil(async () => {
          for (const handle of await browser.getWindowHandles()) {
            await browser.switchToWindow(handle);
            if ((await browser.getUrl()).startsWith(ORIGIN) && await hasExtensionApi()) {
              return true;
            }
          }
          return false;
        }, {timeout: 20000, timeoutMsg: 'the extension page never opened'});

        const stored = await browser.execute((site, site2) => new Promise((done) => {
          chrome.storage.local.set({
            options: JSON.stringify({
              mpvMode: true,
              mpvAllowlist: [site, site2],
            }),
          }, () => {
            chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
              void chrome.runtime.lastError;
              chrome.storage.local.get('options', (r) => done(r.options));
            });
          });
        }), SITE, SITE_B);
        expect(JSON.parse(stored).mpvMode).toBe(true);

        // Give the background a moment to apply the reloaded options.
        await browser.pause(1000);

        // 2. Drop the extension page and drive the remaining window: focus must not decide the
        // media fetch.
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
        // The three headers the CDN checks; Referer is origin-only (strict-origin-when-cross-origin
        // on a cross-origin request).
        expect(h.referer).toBe(`${SITE}/`);
        expect(h.origin).toBe(SITE);
        // The whole point of relaying User-Agent: without it this is "libmpv".
        expect(h['user-agent']).toContain('Firefox');

        // 5. One page, one mpv window.
        expect(fromMpv.filter((r) => r.url.startsWith('/clip.mp4')).length)
            .toBe(1);

        // 6. The hand-off pauses the page; the clip loops, so it cannot have stopped at its end.
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

        // 7. A second video on the same site reaches mpv too: the auto-open latch does not outlive
        // the page.
        await browser.url(`${SITE}/watch2`);

        await browser.waitUntil(async () => {
          return requests.some(
              (r) => isMpvRequest(r) && r.url.startsWith('/clip2.mp4'));
        }, {
          timeout: 45000,
          interval: 500,
          timeoutMsg: 'the second video never reached mpv: ' +
            JSON.stringify(requests.filter(isMpvRequest).map((r) => r.url)),
        });

        const second = requests.filter(
            (r) => isMpvRequest(r) && r.url.startsWith('/clip2.mp4'));
        console.log(`      second video reached mpv (${second.length} request)`);
        expect(second[0].headers.referer).toBe(`${SITE}/`);

        // 8. Crossing to another allowlisted host keeps the tab in MPV mode through tab.reset().
        await browser.url(`${SITE_B}/watch3`);

        await browser.waitUntil(async () => {
          return requests.some(
              (r) => isMpvRequest(r) && r.url.startsWith('/clip3.mp4'));
        }, {
          timeout: 45000,
          interval: 500,
          timeoutMsg: 'a second allowlisted site never reached mpv: ' +
            JSON.stringify(requests.filter(isMpvRequest).map((r) => r.url)),
        });

        const third = requests.filter(
            (r) => isMpvRequest(r) && r.url.startsWith('/clip3.mp4'));
        console.log(`      second allowlisted site reached mpv ` +
          `(${third.length} request)`);
        // Referer follows the new origin, proving the handoff came from the
        // page on SITE_B and not from a replay of the earlier one.
        expect(third[0].headers.referer).toBe(`${SITE_B}/`);
      });

  // A tab FastStream took over on an auto-enabled site switches to mpv on an allowlisted one.
  (HAVE_HOST ? it : it.skip)(
      'switches to mpv when an auto-enabled tab reaches an allowlisted site',
      async function() {
        // MPV is allowlisted for SITE_B only; SITE is merely auto-enabled.
        await browser.url(OPENER_URL);
        await browser.execute((u) => window.open(u, '_blank'),
            ORIGIN + '/player/index.html');
        await browser.waitUntil(async () => {
          for (const handle of await browser.getWindowHandles()) {
            await browser.switchToWindow(handle);
            if ((await browser.getUrl()).startsWith(ORIGIN) && await hasExtensionApi()) {
              return true;
            }
          }
          return false;
        }, {timeout: 20000, timeoutMsg: 'the extension page never opened'});

        await browser.execute((site, site2) => new Promise((done) => {
          chrome.storage.local.set({
            options: JSON.stringify({
              mpvMode: true,
              mpvAllowlist: [site2],
              autoEnableURLs: [site],
            }),
          }, () => {
            chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
              void chrome.runtime.lastError;
              done(true);
            });
          });
        }), SITE, SITE_B);
        await browser.pause(1000);

        const remaining = await browser.getWindowHandles();
        if (remaining.length > 1) {
          await browser.closeWindow();
          await browser.switchToWindow((await browser.getWindowHandles())[0]);
        }

        // A fresh tab, so none of the first spec's per-tab state carries over.
        await browser.newWindow(`${SITE}/watch`);
        // Long enough for the auto-enable branch to have marked the tab.
        await browser.pause(3000);

        const before = requests.filter(
            (r) => isMpvRequest(r) && r.url.startsWith('/clip4.mp4')).length;
        expect(before).toBe(0);

        await browser.url(`${SITE_B}/watch4`);

        await browser.waitUntil(async () => {
          return requests.some(
              (r) => isMpvRequest(r) && r.url.startsWith('/clip4.mp4'));
        }, {
          timeout: 45000,
          interval: 500,
          timeoutMsg: 'an auto-enabled tab never switched to mpv on the ' +
            'allowlisted site. mpv fetched: ' +
            JSON.stringify(requests.filter(isMpvRequest).map((r) => r.url)),
        });

        const handed = requests.filter(
            (r) => isMpvRequest(r) && r.url.startsWith('/clip4.mp4'));
        console.log(`      auto-enabled tab switched to mpv ` +
          `(${handed.length} request)`);
        expect(handed[0].headers.referer).toBe(`${SITE_B}/`);

        await browser.closeWindow();
        await browser.switchToWindow((await browser.getWindowHandles())[0]);
      });

  // The page's subtitles go with the stream: read as the player reads them, written as SubRip for
  // mpv.
  (HAVE_HOST ? it : it.skip)(
      'sends the page\'s subtitles with its stream: a file its player asked for, and its <track>',
      async function() {
        const since = Date.now();
        await browser.url(OPENER_URL);
        await browser.execute((u) => window.open(u, '_blank'),
            ORIGIN + '/player/index.html');
        await browser.waitUntil(async () => {
          for (const handle of await browser.getWindowHandles()) {
            await browser.switchToWindow(handle);
            if ((await browser.getUrl()).startsWith(ORIGIN) && await hasExtensionApi()) {
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

        const remaining = await browser.getWindowHandles();
        if (remaining.length > 1) {
          await browser.closeWindow();
          await browser.switchToWindow((await browser.getWindowHandles())[0]);
        }

        // A fresh tab, so none of the other cases' per-tab state carries over.
        await browser.newWindow(`${SITE}/subtitled`);

        await browser.waitUntil(async () => {
          return requests.some((r) => isMpvRequest(r) && r.url.startsWith('/clip5.mp4'));
        }, {
          timeout: 45000,
          interval: 500,
          timeoutMsg: 'the subtitled page\'s video never reached mpv: ' +
            JSON.stringify(requests.filter(isMpvRequest).map((r) => r.url)),
        });

        // The page asked for the file, and the background again, with the page's Referer and
        // Origin (its header rule, as the player's subtitle requests get).
        const fetched = requests.filter((r) => r.origin === 'cdn' && r.url === '/subs/episode-en.vtt');
        console.log('      the subtitle file was asked for', fetched.length, 'times:',
            JSON.stringify(fetched.map((r) => ({referer: r.headers.referer, origin: r.headers.origin}))));
        expect(fetched.length).toBeGreaterThanOrEqual(2);
        for (const request of fetched) {
          expect(request.headers.referer).toBe(`${SITE}/`);
          expect(request.headers.origin).toBe(SITE);
        }

        // Both tracks, as SubRip, in the folder the host gave mpv.
        const written = subtitleFilesSince(since);
        console.log('      the host wrote', written.length, 'subtitle file(s)');
        expect(written.some((text) => text.includes('00:00:01,000 --> 00:00:02,500') &&
            text.includes('Hello from the CDN'))).toBe(true);
        expect(written.some((text) => text.includes('00:00:03,000 --> 00:00:04,000') &&
            text.includes('Hallo von der Seite'))).toBe(true);

        await browser.closeWindow();
        await browser.switchToWindow((await browser.getWindowHandles())[0]);
      });
});
