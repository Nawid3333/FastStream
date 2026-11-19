// A page's player inside wrappers that have no box of their own (display: contents, as component frameworks
// write them): FastStream's player takes the place and the size of the player, not of a wrapper.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';

const PORT = 41904;
const SITE = `http://127.0.0.1:${PORT}`;
const MP4 = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'sample.mp4'));
const PLAYER = 'iframe[src*="player/index.html"]';

const PAGE = `<!doctype html><title>boxless</title>
  <style>body { margin: 0; } .contents { display: contents; }</style>
  <div id="column" style="width: 640px">
    <div class="contents">
      <x-island style="display: contents">
        <div id="stage" style="display: block; position: relative; width: 640px; height: 360px; overflow: hidden; background: black">
          <video muted playsinline preload="metadata" style="position: absolute; inset: 0; width: 100%; height: 100%" src="${SITE}/video.mp4"></video>
        </div>
      </x-island>
    </div>
    <section id="below" style="height: 68px">below the player</section>
  </div>`;

let server;

describe('A player inside wrappers without a box', function() {
  before(async function() {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      if (url.pathname === '/watch') {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        return res.end(PAGE);
      }
      if (url.pathname === '/video.mp4') {
        const headers = {'Access-Control-Allow-Origin': '*', 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'};
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        if (!range) {
          res.writeHead(200, {...headers, 'Content-Length': MP4.length});
          return res.end(MP4);
        }
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), MP4.length - 1) : MP4.length - 1;
        res.writeHead(206, {...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${MP4.length}`});
        return res.end(MP4.subarray(start, end + 1));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
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

  it('gets FastStream\'s player where the page\'s player stood, as large as it was', async function() {
    await browser.url(`${SITE}/watch`);
    // The page's player, by the page's own styles. Not measured: FastStream may have taken it over already.
    const stage = {x: 0, y: 0, width: 640, height: 360};

    await browser.waitUntil(() => browser.$(PLAYER).isExisting(), {timeout: 20000, interval: 200, timeoutMsg: 'the player never opened'});
    /** @type {{x: number, y: number, width: number, height: number, shown: boolean, below: number}} */
    let placed;
    await browser.waitUntil(async () => {
      placed = await browser.execute((selector) => {
        const player = document.querySelector(selector);
        const box = player.getBoundingClientRect();
        return {x: box.x, y: box.y, width: box.width, height: box.height, shown: getComputedStyle(player).display !== 'none',
          below: Math.round(document.getElementById('below').getBoundingClientRect().top)};
      }, PLAYER);
      return placed.shown && placed.width === 640 && placed.height === 360;
    }, {timeout: 10000, interval: 250}).catch(() => {});
    expect({x: placed.x, y: placed.y, width: placed.width, height: placed.height, shown: placed.shown}).toEqual({...stage, shown: true});
    // What follows the player keeps its place, give or take the line an inline box stands on.
    expect(placed.below).toBeGreaterThanOrEqual(360);
    expect(placed.below).toBeLessThanOrEqual(368);
  });
});
