// A page FastStream is on for is loaded again, and FastStream takes its video over again
// (the owner's report, 2026-11-14: after a reload the page's own player stayed, and playing
// it changed nothing).
//
// The background opens the player about half a second after the page's first stream request.
// A page's own player that is still starting then has no video on the screen yet, and
// content.js answers 'no_video'. Nothing tried again: every later request was for a stream
// the background knew already. Now a missed open is tried again - by itself for the first
// seconds, and when the user starts the page's video (background.mjs noteOpenMissed,
// reopenMissed, reopenOnUserPlay; the cases one by one in
// tests/unit/backgroundReloadTakeover.test.mjs).
//
// Driven on the installed extension, the site on the auto-enable list. Two pages:
// /watch asks for its stream at once, and has its video on the page at once on its first
// load and 2.5 s late on every later one; /below has its video under three screens of page,
// where the open misses it until the user scrolls there and plays it.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';
import {loopedPlaylist} from '../loopedPlaylist.mjs';

const PORT = 41902;
const SITE = `http://127.0.0.1:${PORT}`;
const VIDEO = `${SITE}/video.mp4`;
const SEGMENTS = path.resolve(import.meta.dirname, '../fixtures/hls-ts');
const MP4 = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'sample.mp4'));
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
};
// How late the page's player has its video on the page, on a load after the first.
const LATE_MS = 2500;
// The tries the background makes by itself end 7 s after the first miss (1, 2 and 4 s
// apart): past them, only a play the user starts opens the player.
const OWN_TRIES_OVER_MS = 9500;

let server;
let watchLoads = 0;

/**
 * The file, or the range of it asked for.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function serveVideo(req, res) {
  const headers = {...CORS, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'};
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), MP4.length - 1) : MP4.length - 1;
    res.writeHead(206, {...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${MP4.length}`});
    res.end(MP4.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, {...headers, 'Content-Length': MP4.length});
  res.end(MP4);
}

/**
 * Whether the page has FastStream's player.
 * @return {Promise<boolean>}
 */
async function hasPlayer() {
  await browser.switchFrame(null);
  return browser.$('iframe[src*="player/index.html"]').isExisting();
}

/**
 * Waits for FastStream's player on the page, and until it can play.
 * @param {string} what - For the failure.
 * @param {number} within - How long the player may take to open, in ms.
 * @return {Promise<{source: string, readyState: number, failed: boolean}>}
 */
async function playerOnPage(what, within) {
  await browser.waitUntil(hasPlayer, {timeout: within, interval: 200, timeoutMsg: `${what}: the player never opened`});
  await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
  let state = {source: '', readyState: -1, failed: false};
  await browser.waitUntil(async () => {
    state = await browser.execute(() => {
      const client = window.fastStream;
      const video = client?.player?.getVideo?.();
      return {source: client?.source?.url || '', readyState: video ? video.readyState : -1,
        failed: !!client?.interfaceController?.failed};
    });
    return state.readyState >= 2;
  }, {timeout: 30000, interval: 250}).catch(() => {});
  await browser.switchFrame(null);
  console.log(`      ${what}:`, JSON.stringify(state));
  return state;
}

/**
 * Reloads the page as F5 does.
 * @return {Promise<void>}
 */
async function reloadPage() {
  const before = watchLoads;
  await browser.switchFrame(null);
  await browser.execute(() => location.reload());
  await browser.waitUntil(async () => watchLoads > before, {timeout: 10000, timeoutMsg: 'the page never loaded again'});
}

describe('A page FastStream is on for, loaded again', function() {
  before(async function() {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
      }
      if (url.pathname === '/watch') {
        watchLoads++;
        const late = watchLoads > 1 ? LATE_MS : 0;
        // Never from the cache: every load is counted. The stream is asked for at once, as
        // a page's player does while it starts; its video is on the page `late` ms later.
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        return res.end(`<!doctype html><title>watch</title>
          <div id="stage" style="width: 640px; height: 360px"></div>
          <script>
            fetch("${SITE}/v/master.m3u8?load=${watchLoads}");
            setTimeout(() => {
              const video = document.createElement('video');
              video.muted = true;
              video.style.cssText = 'display: block; width: 640px; height: 360px';
              document.getElementById('stage').append(video);
            }, ${late});
          </script>`);
      }
      if (url.pathname === '/below') {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        // The page's own play button, as a site's player has one: the video starts in the
        // press, so the play is the user's.
        return res.end(`<!doctype html><title>below</title>
          <script>history.scrollRestoration = 'manual';</script>
          <div style="height: 3000px"></div>
          <button id="play" onclick="document.querySelector('video').play()">play</button>
          <video muted playsinline preload="metadata" style="display: block; width: 640px; height: 360px" src="${VIDEO}"></video>`);
      }
      if (url.pathname === '/video.mp4') {
        return serveVideo(req, res);
      }
      if (url.pathname === '/v/master.m3u8') {
        res.writeHead(200, {...CORS, 'Content-Type': 'application/vnd.apple.mpegurl'});
        return res.end(loopedPlaylist(60, '/v/seg/'));
      }
      if (url.pathname.startsWith('/v/seg/')) {
        res.writeHead(200, {...CORS, 'Content-Type': 'video/mp2t'});
        return res.end(fs.readFileSync(path.join(SEGMENTS, path.basename(url.pathname))));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });

    // The site on the auto-enable list: FastStream is on for every page of it.
    await inExtensionPage((site, done) => {
      chrome.storage.local.set({options: JSON.stringify({autoEnableURLs: [site]})}, () => {
        chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
          void chrome.runtime.lastError;
          setTimeout(() => done(true), 500);
        });
      });
    }, `${SITE}/`);
  });

  after(async function() {
    await browser.switchFrame(null);
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('is taken over again when its own player has its video on the page late', async function() {
    await browser.url(`${SITE}/watch`);
    const first = await playerOnPage('the first load', 20000);
    expect(first.source).toContain('/v/master.m3u8?load=1');
    expect(first.readyState).toBeGreaterThanOrEqual(2);

    await reloadPage();
    // The open half a second after the stream request finds no video; the tries after it
    // do, within seconds of the video being there.
    const again = await playerOnPage('after the reload', LATE_MS + 10000);
    expect(again.source).toContain(`/v/master.m3u8?load=${watchLoads}`);
    expect(again.readyState).toBeGreaterThanOrEqual(2);
    expect(again.failed).toBe(false);
  });

  it('is taken over when the user plays a video no open had found', async function() {
    await browser.url(`${SITE}/below`);
    // The video is three screens down: every open the background tries by itself misses it.
    await browser.pause(OWN_TRIES_OVER_MS);
    expect(await hasPlayer()).toBe(false);

    // The user scrolls to the video. That alone asks for nothing and opens nothing.
    await browser.execute(() => document.querySelector('video').scrollIntoView({block: 'center'}));
    await browser.pause(1000);
    expect(await hasPlayer()).toBe(false);

    // And plays it, with the page's button.
    await browser.$('#play').click();
    const state = await playerOnPage('after the user played the page\'s video', 5000);
    expect(state.source).toBe(VIDEO);
    expect(state.readyState).toBeGreaterThanOrEqual(2);
    expect(state.failed).toBe(false);
  });
});
