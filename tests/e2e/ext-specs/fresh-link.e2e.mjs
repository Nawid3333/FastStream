// A stream link the server refuses is got anew from its page (#592, FreshLink.mjs).
//
// A hoster signs its stream link with the time it was issued (vidmoly: …&s=<issued>&e=43200,
// twelve hours), and every load of its page issues a new one. Back gives a page its old
// document from Firefox's cache, and with it the old link: once that ran out, the segments
// were refused (403), and FastStream's player sat at 0:00 without an error, or stopped where
// it had downloaded to (both measured on vidmoly's own server, 2026-10-27).
//
// This site does what vidmoly does: its page names the playlist with a signature of its own
// (sig=s<n>, n counting the page's loads), the playlist takes any signature and hands it on to
// its segments, and a segment with an expired signature is refused. The player gets the page
// again and plays on with the new link.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';
import {loopedPlaylist} from '../loopedPlaylist.mjs';

const PORT = 41900;
const SITE = `http://127.0.0.1:${PORT}`;
const SEGMENTS = path.resolve(import.meta.dirname, '../fixtures/hls-ts');
// The player fetches from a moz-extension:// frame: CORS, preflight included.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
};

let server;
// The page's loads so far: the signature the next one issues.
let pages = 0;
// The signatures the server refuses from now on.
const expired = new Set();
// How long a segment takes: a slow server, so the video is not all downloaded at once.
let segmentDelay = 0;
/** @type {Array<{sig: ?string, place: ?string, status: number}>} */
let segments = [];

/**
 * The player's state, in its frame; player false while the page has none.
 * @return {Promise<{player?: boolean, url: string, time: number, paused: boolean, readyState: number, failed: boolean}>}
 */
async function playerState() {
  await browser.switchFrame(null);
  if (!(await browser.$('iframe[src*="player/index.html"]').isExisting())) {
    return {player: false, url: '', time: 0, paused: true, readyState: 0, failed: false};
  }
  await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
  return browser.execute(() => {
    const client = window.fastStream;
    const video = client?.player?.getVideo?.();
    return {url: client?.source?.url || '', time: client?.currentTime || 0, paused: !!video?.paused,
      readyState: video?.readyState || 0, failed: !!client?.interfaceController?.failed};
  });
}

/**
 * Waits until the player's state passes a check.
 * @param {(state: Object) => boolean} check
 * @param {string} what - For the timeout's message.
 * @param {number} [timeout]
 * @return {Promise<Object>} The state that passed.
 */
async function waitForPlayer(check, what, timeout = 30000) {
  let state = null;
  try {
    await browser.waitUntil(async () => check(state = await playerState()), {timeout, interval: 500});
  } catch (e) {
    // The state when it gave up (a timeoutMsg is made when the wait starts).
    throw new Error(`${what}; the player: ${JSON.stringify(state)}, segments: ${JSON.stringify(segments.slice(-6))}`);
  }
  return state;
}

describe('A stream link the server refuses', function() {
  before(async function() {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
      }
      if (url.pathname === '/embed') {
        pages++;
        // Cached for five minutes, as vidmoly's page is: the link in it is what Back brings.
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300'});
        res.end(`<!doctype html><title>embed</title>
          <video muted style="width: 640px; height: 360px"></video>
          <script>var setup = {sources: [{file: "${SITE}/v/master.m3u8?sig=s${pages}&e=43200"}]};
            fetch(setup.sources[0].file);</script>`);
        return;
      }
      if (url.pathname === '/v/master.m3u8') {
        const sig = url.searchParams.get('sig');
        res.writeHead(200, {...CORS, 'Content-Type': 'application/vnd.apple.mpegurl'});
        res.end(loopedPlaylist(180, '/v/seg/', {unique: true}).replace(/\.ts\?i=/g, `.ts?sig=${sig}&i=`));
        return;
      }
      if (url.pathname.startsWith('/v/seg/')) {
        const sig = url.searchParams.get('sig');
        const status = expired.has(/** @type {string} */ (sig)) ? 403 : 200;
        segments.push({sig, place: url.searchParams.get('i'), status});
        setTimeout(() => {
          if (status !== 200) {
            res.writeHead(status, CORS);
            res.end();
            return;
          }
          res.writeHead(200, {...CORS, 'Content-Type': 'video/mp2t'});
          res.end(fs.readFileSync(path.join(SEGMENTS, path.basename(url.pathname))));
        }, segmentDelay);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
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
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('plays a page whose link has run out, with the page\'s new one', async function() {
    // Back with the page from the cache: its link (the next one issued) is refused already.
    expired.add(`s${pages + 1}`);
    const before = pages;
    await browser.url(`${SITE}/embed`);
    const state = await waitForPlayer((s) => /[?&]sig=s\d+/.test(s.url) && !s.url.includes(`sig=s${before + 1}&`) &&
      s.readyState >= 2, 'the player never played the page\'s new link');
    console.log('      on the new link:', JSON.stringify(state));
    // The page was asked once more, and the player plays what that gave.
    expect(pages).toBe(before + 2);
    expect(state.url).toContain(`sig=s${before + 2}&`);
    expect(state.failed).toBe(false);
    expect(segments.some((s) => s.sig === `s${before + 2}` && s.status === 200)).toBe(true);
  });

  it('plays on where it was when its link runs out mid-video', async function() {
    expired.clear();
    segments = [];
    segmentDelay = 1000;
    const before = pages;
    const first = `s${before + 1}`;
    // A page of its own: the first test's is in Firefox's cache, link and all.
    await browser.url(`${SITE}/embed?mid`);
    await waitForPlayer((s) => s.url.includes(`sig=${first}&`) && s.readyState >= 2, 'the first link never played');
    await browser.execute(() => window.fastStream.play());
    const playing = await waitForPlayer((s) => s.time > 3 && !s.paused, 'the first link never played 3 s');

    // The link runs out.
    expired.add(first);
    // The new player reads 0 while it is set up: its time once it has the new link's data.
    const renewed = await waitForPlayer((s) => s.url.includes(`sig=s${before + 2}&`) && s.readyState >= 2,
        'the player never played the new link');
    // Where it was, not from 0 (a few seconds' play between).
    expect(renewed.time).toBeGreaterThan(playing.time - 1);
    const after = await waitForPlayer((s) => s.time > renewed.time + 2 && !s.paused, 'the video did not play on', 20000);
    console.log('      ran out at', playing.time.toFixed(1), 's; on the new link at', renewed.time.toFixed(1),
        's, then:', JSON.stringify(after));
    expect(after.failed).toBe(false);
  });
});
