// A video file another page of the site already played is detected again.
//
// The background learns of a page's stream from the request for it (onHeadersReceived).
// Firefox played a file that an earlier page of the same site had played with no request
// at all, not one the extension sees (not even onBeforeSendHeaders) nor one reaching the
// server - with the file served no-store, and with the earlier page out of the back-forward
// cache (an unload listener) too: measured with this spec. On a site FastStream
// was already on for, nothing asked the page what it plays either (that happens when it is
// turned on: recoverSources), so the second page's player never opened: the same video
// opened again from a link, say. Found by live-specs/players.e2e.mjs, whose pages of one
// site play the same MP4 one after another: every MP4 page after the first missed. content.js
// now tells the background a video's file once the video has it (loadedmetadata).
//
// Driven on the installed extension: the site on the auto-enable list, one page plays the
// MP4 (FastStream takes it over), then another page of the site plays the same file. The
// server counts the requests of the pages' own videos, to show the second one made none.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';

const SITE_PORT = 41961;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const VIDEO = `${SITE}/video.mp4`;
const MP4 = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'sample.mp4'));

let siteServer;
// The requests a page's <video> made for the file (Sec-Fetch-Dest: video), not the
// player's own.
let videoRequests = 0;

/**
 * Answers a request for the file, a range of it when asked, not to be cached: the reuse
 * under test is not the HTTP cache's. The player fetches it from a partitioned
 * moz-extension:// frame, so it needs CORS, preflight included.
 * @param {http.IncomingMessage} req - The request.
 * @param {http.ServerResponse} res - The response.
 */
function serveVideo(req, res) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.headers['sec-fetch-dest'] === 'video') {
    videoRequests++;
  }
  const headers = {...cors, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'};
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
 * Waits for FastStream's player in the page, and reads the source it plays once it can.
 * @param {string} what - For the error message.
 * @return {Promise<{source: ?string, readyState: number}>}
 */
async function playerOnPage(what) {
  await browser.switchFrame(null);
  await browser.waitUntil(async () => browser.execute(() => {
    return Array.from(document.querySelectorAll('iframe')).some((f) => f.src.includes('player/index.html'));
  }), {timeout: 20000, timeoutMsg: `the player never opened on ${what}`});
  await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
  let state;
  await browser.waitUntil(async () => {
    state = await browser.execute(() => {
      const video = window.fastStream?.player?.getVideo?.();
      return {source: window.fastStream?.source?.url || null, readyState: video ? video.readyState : -1};
    });
    return state.readyState >= 2;
  }, {timeout: 20000, interval: 250}).catch(() => {});
  await browser.switchFrame(null);
  console.log(`      ${what}:`, JSON.stringify(state));
  return state;
}

describe('A video file another page of the site already played', function() {
  before(async function() {
    siteServer = http.createServer((req, res) => {
      const {pathname} = new URL(req.url, SITE);
      if (pathname === '/video.mp4') {
        serveVideo(req, res);
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      // Both pages play the file at once, as a site's player started by a visitor does.
      res.end(`<!doctype html><title>${pathname === '/watch' ? 'watch' : 'home'}</title>
        <video muted autoplay playsinline preload="auto" style="width: 640px; height: 360px" src="${VIDEO}"></video>`);
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
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
    if (siteServer) {
      siteServer.closeAllConnections();
      await new Promise((resolve) => siteServer.close(resolve));
    }
  });

  it('opens the player on the next page that plays it', async function() {
    await browser.url(`${SITE}/home`);
    expect((await playerOnPage('the first page')).source).toBe(VIDEO);
    const before = videoRequests;
    expect(before).toBeGreaterThan(0);

    await browser.url(`${SITE}/watch`);
    const state = await playerOnPage('the next page');
    // What made the case: the page's video asked for nothing.
    expect(videoRequests).toBe(before);
    expect(state.source).toBe(VIDEO);
    expect(state.readyState).toBeGreaterThanOrEqual(2);
  });
});
