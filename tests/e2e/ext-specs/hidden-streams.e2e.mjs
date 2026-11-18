// Streams a page hides, on the installed extension in a real Firefox (its webRequest.filterResponseData,
// not a stand-in): the shapes measured on a streaming hoster in 2026-11 (docs/notes/player.md,
// "Streams that hide what they are"), and players in frames that have no address of their own.
//
// - An HLS master at an address that names no type, as text/plain; its playlists and segments only
//   with the master address's key (403 without); segments named page-N.html, as text/html.
// - A DASH manifest as application/xml at an address that names no type.
// - A <video> in an about:blank frame the page wrote, and in a srcdoc frame.
//
// The site is on the auto-enable list. Each: FastStream's player takes over and plays.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';

const SITE_PORT = 41968;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
const KEY = 'k3y';

let siteServer;
/** @type {Array<{path: string, key: ?string, status: number}>} */
const seen = [];

/** The HLS media playlist, its segments renamed page-N.html and listed without the key. */
function mediaPlaylist() {
  let n = 0;
  return fs.readFileSync(path.join(FIXTURES, 'hls-ts/index.m3u8'), 'utf8')
      .replace(/^seg-\d+\.ts$/gm, () => `/content/page-${n++}.html`);
}

/**
 * A page that fetches a manifest as a player script does, over a <video> it has not given a source yet.
 * @param {string} manifest - Its address.
 * @return {string}
 */
function pageFetching(manifest) {
  return `<!doctype html><body style="margin:0"><video muted controls width="640" height="360"></video>
    <script>fetch(${JSON.stringify(manifest)}).then((r) => r.text());</script></body>`;
}

/**
 * A video with an address of its own: Firefox's media cache would serve one the test before loaded with no request
 * FastStream sees.
 * @param {string} name
 * @return {string}
 */
const video = (name) => `<video muted autoplay controls width="640" height="360" src="/media/sample.mp4?${name}"></video>`;

const PAGES = {
  '/hoster': pageFetching(`/pl/7?token=${KEY}`),
  '/dash': pageFetching('/api/manifest?id=7'),
  '/blank': `<!doctype html><body style="margin:0"><iframe width="660" height="380"></iframe><script>
    const doc = document.querySelector('iframe').contentDocument;
    doc.open();
    doc.write(${JSON.stringify(`<!doctype html><body style="margin:0">${video('blank')}</body>`)});
    doc.close();
  </script></body>`,
  '/srcdoc': `<!doctype html><body style="margin:0"><iframe width="660" height="380"
    srcdoc="${`<!doctype html><body style='margin:0'>${video('srcdoc').replaceAll('"', '\'')}</body>`}"></iframe></body>`,
};

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} type
 * @param {string|Buffer} body
 */
function send(res, status, type, body) {
  res.writeHead(status, {'Content-Type': type, 'Access-Control-Allow-Origin': '*'});
  res.end(body);
}

describe('Streams a page hides', function() {
  before(async function() {
    siteServer = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      const key = url.searchParams.get('token');
      const record = (status) => seen.push({path: url.pathname, key, status});
      if (PAGES[url.pathname]) {
        send(res, 200, 'text/html; charset=utf-8', PAGES[url.pathname]);
        return;
      }
      if (url.pathname.startsWith('/pl/') || url.pathname.startsWith('/content/')) {
        if (key !== KEY) {
          record(403);
          send(res, 403, 'text/html', '<html><body>Forbidden</body></html>');
          return;
        }
        record(200);
        if (url.pathname === '/pl/7') {
          send(res, 200, 'text/plain; charset=utf-8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180\n/pl/7/a\n');
        } else if (url.pathname === '/pl/7/a') {
          send(res, 200, 'text/plain; charset=utf-8', mediaPlaylist());
        } else {
          const n = Number(/page-(\d+)\.html$/.exec(url.pathname)?.[1]);
          const file = path.join(FIXTURES, 'hls-ts', `seg-${String(n).padStart(3, '0')}.ts`);
          if (!fs.existsSync(file)) {
            send(res, 404, 'text/html', 'not found');
            return;
          }
          send(res, 200, 'text/html; charset=UTF-8', fs.readFileSync(file));
        }
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const name = url.pathname === '/api/manifest' ? 'manifest.mpd' : path.basename(url.pathname);
        const file = path.join(FIXTURES, 'dash-template', name);
        if (!fs.existsSync(file)) {
          send(res, 404, 'text/plain', 'not found');
          return;
        }
        send(res, 200, name.endsWith('.mpd') ? 'application/xml' : 'video/iso.segment', fs.readFileSync(file));
        return;
      }
      if (url.pathname === '/media/sample.mp4') {
        send(res, 200, 'video/mp4', fs.readFileSync(path.join(FIXTURES, 'sample.mp4')));
        return;
      }
      send(res, 404, 'text/plain', 'not found');
    });
    await new Promise((resolve) => siteServer.listen(SITE_PORT, '127.0.0.1', resolve));

    await inExtensionPage((site, done) => {
      chrome.storage.local.set({options: JSON.stringify({autoEnableURLs: [site + '/']})}, () => {
        chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
          void chrome.runtime.lastError;
          setTimeout(() => done(true), 500);
        });
      });
    }, SITE);
  });

  after(async function() {
    await browser.switchFrame(null);
    if (siteServer) {
      siteServer.closeAllConnections();
      await new Promise((resolve) => siteServer.close(resolve));
    }
  });

  /**
   * Waits for FastStream's player in the page or in its first frame, switches into it, and waits
   * until it shows the video.
   * @param {string} what - For the messages.
   * @return {Promise<Object>} The player's state.
   */
  async function playerShowing(what) {
    const selector = 'iframe[src*="player/index.html"]';
    await browser.waitUntil(async () => {
      await browser.switchFrame(null);
      if (await browser.$(selector).isExisting()) return true;
      const frame = await browser.$('iframe');
      if (!await frame.isExisting()) return false;
      await browser.switchFrame(frame);
      return browser.$(selector).isExisting();
    }, {timeout: 30000, interval: 500, timeoutMsg: `FastStream's player never took over ${what}`});
    await browser.switchFrame(await browser.$(selector));
    let state;
    await browser.waitUntil(async () => {
      state = await browser.execute(() => {
        const client = window.fastStream;
        const video = client?.player?.getVideo?.();
        return {mode: client?.source?.mode, url: client?.source?.url, readyState: video?.readyState ?? -1,
          width: video?.videoWidth ?? 0, error: video?.error?.message ?? null};
      });
      return state.readyState >= 2 && state.width > 0;
    }, {timeout: 30000, interval: 500, timeoutMsg: `FastStream's player never showed ${what}: ${JSON.stringify(state)}`});
    await browser.switchFrame(null);
    return state;
  }

  it('plays an HLS stream that names no type, needs its key on every file and calls its segments pages', async function() {
    seen.length = 0;
    await browser.url(`${SITE}/hoster`);
    const state = await playerShowing('the HLS stream');
    expect(state.mode).toBe('accelerated_hls');
    expect(state.url).toBe(`${SITE}/pl/7?token=${KEY}`);
    // Each file was refused once at most without the key; the segments came with it.
    const refused = seen.filter((s) => s.status === 403).map((s) => s.path);
    expect(refused.length).toBeLessThanOrEqual(2);
    expect(seen.filter((s) => s.path.startsWith('/content/') && s.status === 200).length).toBeGreaterThan(0);
  });

  it('plays a DASH manifest its server calls application/xml, at an address that names no type', async function() {
    await browser.url(`${SITE}/dash`);
    const state = await playerShowing('the DASH stream');
    expect(state.mode).toBe('accelerated_dash');
    expect(state.url).toBe(`${SITE}/api/manifest?id=7`);
  });

  for (const [where, page] of [['an about:blank frame the page wrote', '/blank'], ['a srcdoc frame', '/srcdoc']]) {
    it(`takes over a video in ${where}`, async function() {
      await browser.url(`${SITE}${page}`);
      const state = await playerShowing(`the video in ${where}`);
      expect(state.url).toBe(`${SITE}/media/sample.mp4?${page.slice(1)}`);
    });
  }
});
