// Switching FastStream on in a tab whose video already loaded opens the player on it, even
// once the background has been suspended.
//
// The background learns a page's streams from its requests as they go by. Firefox runs it
// as an event page and suspends it after about 30 idle seconds, which drops every stream
// it had seen; only whether each tab is on survives. A page that loaded its video before
// that - one watched with FastStream off, then switched on from the toolbar - left it
// nothing to open, and the player came only with a reload (vixeo.io). It now asks the
// page for what it loaded (the browser's Resource Timing entries, and what its videos
// play) when it knows no stream of the tab at all.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {loopedPlaylist} from '../loopedPlaylist.mjs';
import {clickToolbar as clickToolbarIn, suspendBackground} from '../classic-helpers.mjs';

const SITE_PORT = 41992;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
const PLAYER = 'iframe[src*="player/index.html"]';

// The player fetches from a partitioned moz-extension:// frame: everything it plays needs
// CORS (see source-length).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
};

let siteServer;
// What the site was asked for, in order.
const requested = [];
// A 1x1 GIF, for the busy page's images.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * Clicks the extension's toolbar button for the site's tab: the one selected, over the
 * welcome page the add-on opened when it was installed.
 */
const clickToolbar = async () => clickToolbarIn(await browser.getWindowHandle());

/**
 * Waits for the player to replace the page's video, and reads the source it plays.
 * @return {Promise<Object>} What the player has.
 */
async function playerSource() {
  await browser.waitUntil(async () => browser.$(PLAYER).isExisting(),
      {timeout: 20000, timeoutMsg: 'the player never replaced the page\'s video'});
  await browser.switchFrame(await browser.$(PLAYER));
  let state;
  try {
    await browser.waitUntil(async () => {
      state = await browser.execute(() => {
        const client = window.fastStream;
        const video = client?.player?.getVideo?.();
        return {
          source: client?.source?.url || null,
          sources: (client?.sourcesBrowser?.sources || []).map((source) => source.url).filter(Boolean),
          readyState: video ? video.readyState : null,
        };
      });
      return state.readyState >= 2;
    }, {timeout: 20000, interval: 250}).catch(() => {});
  } finally {
    await browser.switchFrame(null);
  }
  console.log('      player:', JSON.stringify(state));
  return state;
}

describe('Switching FastStream on after the page loaded its video', function() {
  before(async function() {
    const segmentDir = path.join(FIXTURES, 'hls-ts');
    siteServer = http.createServer((req, res) => {
      const {pathname} = new URL(req.url, SITE);
      requested.push(req.url);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
      } else if (pathname === '/page') {
        // A page whose player fetched its stream, as hls.js does.
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        res.end(`<!doctype html><title>watching</title>
          <video muted preload="auto" style="width: 640px; height: 360px"></video>
          <script>fetch('/hls/clip.m3u8' + location.search);</script>`);
      } else if (pathname === '/busy') {
        // A page laden with ads: 300 images, more than its Resource Timing buffer keeps
        // (250), before its player fetches the stream.
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        res.end(`<!doctype html><title>watching, among ads</title>
          <video muted preload="auto" style="width: 640px; height: 360px"></video>
          <script>
            const loads = [];
            for (let i = 0; i < 300; i++) {
              const img = new Image();
              loads.push(new Promise((resolve) => {
                img.onload = img.onerror = resolve;
              }));
              img.src = '/px.gif?i=' + i + '&' + location.search.slice(1);
            }
            Promise.all(loads).then(() => fetch('/hls/clip.m3u8' + location.search));
          </script>`);
      } else if (pathname === '/px.gif') {
        res.writeHead(200, {'Content-Type': 'image/gif', 'Content-Length': PIXEL.length});
        res.end(PIXEL);
      } else if (pathname === '/hls/clip.m3u8') {
        res.writeHead(200, {...CORS, 'Content-Type': 'application/vnd.apple.mpegurl'});
        res.end(loopedPlaylist(270, '/hls-ts/'));
      } else if (pathname.startsWith('/hls-ts/') && pathname.endsWith('.ts')) {
        const file = path.join(segmentDir, path.basename(pathname));
        res.writeHead(200, {...CORS, 'Content-Type': 'video/mp2t', 'Content-Length': fs.statSync(file).size});
        fs.createReadStream(file).pipe(res);
      } else {
        res.writeHead(404, {'Content-Type': 'text/plain'});
        res.end('not found');
      }
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    if (siteServer) await new Promise((resolve) => siteServer.close(resolve));
  });

  for (const suspended of [false, true]) {
    it(`opens the player on the page's stream${suspended ? ', the background suspended since' : ''}`, async function() {
      const c = Date.now();
      await browser.url(`${SITE}/page?c=${c}`);
      await browser.waitUntil(async () => browser.execute(() => {
        return performance.getEntriesByType('resource').some((entry) => entry.name.includes('/hls/clip.m3u8'));
      }), {timeout: 10000, timeoutMsg: 'the page never fetched its stream'});
      // FastStream is off here: nothing replaced the page's video.
      await browser.pause(1500);
      expect(await browser.$(PLAYER).isExisting()).toBe(false);

      if (suspended) {
        await suspendBackground();
        await browser.pause(1000);
      }

      await clickToolbar();
      const state = await playerSource();
      expect(state.source).toBe(`${SITE}/hls/clip.m3u8?c=${c}`);
      expect(state.readyState).toBeGreaterThanOrEqual(2);

      // Off again, for the next case to switch on.
      await clickToolbar();
      await browser.waitUntil(async () => !(await browser.$(PLAYER).isExisting()),
          {timeout: 10000, timeoutMsg: 'the player stayed after FastStream was switched off'});
    });
  }

  // The page's Resource Timing entries keep its first 250 requests, and a page laden with
  // ads makes that many before its player asks for the stream: the stream was never among
  // them, and a suspended background found nothing to open (#231). content.js's observer
  // is told of every request.
  it('opens the player on the stream of a page that made 300 requests before it, the background suspended since', async function() {
    const c = Date.now();
    await browser.url(`${SITE}/busy?c=${c}`);
    await browser.waitUntil(async () => requested.includes(`/hls/clip.m3u8?c=${c}`),
        {timeout: 20000, timeoutMsg: 'the page never fetched its stream'});
    await browser.pause(1500);
    // The premise: the page's own timeline has no room left for the stream.
    expect(await browser.execute(() => performance.getEntriesByType('resource')
        .some((entry) => entry.name.includes('/hls/clip.m3u8')))).toBe(false);
    expect(await browser.$(PLAYER).isExisting()).toBe(false);

    await suspendBackground();
    await browser.pause(1000);

    await clickToolbar();
    const state = await playerSource();
    expect(state.source).toBe(`${SITE}/hls/clip.m3u8?c=${c}`);

    await clickToolbar();
    await browser.waitUntil(async () => !(await browser.$(PLAYER).isExisting()),
        {timeout: 10000, timeoutMsg: 'the player stayed after FastStream was switched off'});
  });
});
