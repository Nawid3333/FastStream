// A buffer kept longer than the event page lives (BufferStash on the disk, KeptBufferDisk): the user picked
// 5 minutes, the tab with the video closed, Firefox unloaded the idle event page and its RAM with it, and the page
// opened again takes all of it back from the disk, downloading none of it again. Firefox unloads an idle event page
// after 30 s; this spec lowers that to 2 s (extensions.background.idle.timeout), and puts it back after.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';
import {loopedPlaylist} from '../loopedPlaylist.mjs';

const PORT = 41965;
const SITE = `http://127.0.0.1:${PORT}`;
const SEGMENTS = path.resolve(import.meta.dirname, '../fixtures/hls-ts');
const ADDON_ID = 'thanatus@Nawid';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
};

let server;
let pages = 0;
/** @type {Array<{sig: ?string, place: ?string}>} */
let segments = [];

/**
 * Runs a script in Firefox's own (privileged) scope: WebDriver classic's execute (`execute` goes over BiDi, which
 * runs in the page).
 * @param {string} body - A function body; `arguments` are args.
 * @param {...*} args
 * @return {Promise<*>}
 */
async function inChrome(body, ...args) {
  const handle = await browser.getWindowHandle();
  await browser.setMozContext('chrome');
  try {
    return await browser.executeScript(body, args);
  } finally {
    await browser.setMozContext('content');
    await browser.switchToWindow(handle);
  }
}

/** @return {Promise<string>} The event page's state: "running", "stopped", ... */
const backgroundState = () => inChrome(
    'return String(WebExtensionPolicy.getByID(arguments[0])?.extension?.backgroundState);', ADDON_ID);

/**
 * Switches into the page's player frame.
 * @return {Promise<boolean>} Whether the page has one.
 */
async function intoPlayer() {
  await browser.switchFrame(null);
  if (!(await browser.$('iframe[src*="player/index.html"]').isExisting())) {
    return false;
  }
  await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
  return true;
}

/** @return {Promise<Object>} The page's player's state; player false while the page has none. */
async function playerState() {
  if (!await intoPlayer()) {
    return {player: false};
  }
  const state = await browser.execute(() => {
    const client = window.fastStream;
    const video = client?.player?.getVideo?.();
    return {player: true, url: client?.source?.url || '', readyState: video?.readyState || 0,
      failed: !!client?.interfaceController?.failed, tookBack: client?.bufferTakenBack || null};
  });
  await browser.switchFrame(null);
  return state;
}

/**
 * The segments the server sent for a signature.
 * @param {string} sig
 * @return {Set<string>} Their places.
 */
const placesFor = (sig) => new Set(segments.filter((s) => s.sig === sig).map((s) => s.place));

/**
 * Waits until the page's player plays its link and has downloaded `ahead` segments of it.
 * @param {number} ahead
 * @return {Promise<string>} The signature this load of the page issued.
 */
async function buffered(ahead) {
  const sig = `s${pages}`;
  await browser.waitUntil(async () => {
    const state = await playerState();
    return state.player && state.readyState >= 2 && state.url.includes(`sig=${sig}&`);
  }, {timeout: 30000, timeoutMsg: `the player never played the page's link (${sig})`});
  await browser.waitUntil(async () => placesFor(sig).size >= ahead,
      {timeout: 30000, timeoutMsg: `fewer than ${ahead} segments were downloaded ahead`});
  return sig;
}

/**
 * The options, saved as the options page does and loaded by the background.
 * @param {Object} options
 * @return {Promise<void>}
 */
async function setOptions(options) {
  await inExtensionPage((options, done) => {
    chrome.storage.local.set({options: JSON.stringify(options)}, () => {
      chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
        void chrome.runtime.lastError;
        setTimeout(() => done(true), 500);
      });
    });
  }, options);
}

describe('A buffer kept for minutes', function() {
  before(async function() {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
      }
      if (url.pathname === '/watch') {
        pages++;
        const sig = `s${pages}`;
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        return res.end(`<!doctype html><title>watch</title>
          <video muted style="width: 640px; height: 360px"></video>
          <script>fetch("${SITE}/v/master.m3u8?sig=${sig}&e=43200");</script>`);
      }
      if (url.pathname === '/v/master.m3u8') {
        const sig = url.searchParams.get('sig');
        res.writeHead(200, {...CORS, 'Content-Type': 'application/vnd.apple.mpegurl'});
        return res.end(loopedPlaylist(180, '/v/seg/', {unique: true}).replace(/\.ts\?i=/g, `.ts?sig=${sig}&i=`));
      }
      if (url.pathname.startsWith('/v/seg/')) {
        segments.push({sig: url.searchParams.get('sig'), place: url.searchParams.get('i')});
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
    await inChrome('Services.prefs.setIntPref("extensions.background.idle.timeout", 2000);');
  });

  after(async function() {
    await browser.switchFrame(null);
    await inChrome('Services.prefs.clearUserPref("extensions.background.idle.timeout");');
    await setOptions({});
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('comes back from the disk after its tab closed and Firefox unloaded the event page', async function() {
    await setOptions({autoEnableURLs: [SITE + '/'], bufferKeep: 300});
    segments = [];
    await browser.url(`${SITE}/watch`);
    const first = await buffered(8);
    const kept = placesFor(first);
    // Its tab closes; another stays open.
    const watching = await browser.getWindowHandle();
    await browser.newWindow('about:blank');
    const other = (await browser.getWindowHandles()).find((handle) => handle !== watching);
    await browser.switchToWindow(watching);
    await browser.closeWindow();
    const closedAt = Date.now();
    await browser.switchToWindow(other);

    // Nothing else happens: the event page goes, and its RAM with it.
    let state = '';
    await browser.waitUntil(async () => (state = await backgroundState()) === 'stopped',
        {timeout: 30000, interval: 500, timeoutMsg: 'the event page was never unloaded'}).catch(() => {});
    console.log(`      event page after the tab closed: ${state}`);
    expect(state).toBe('stopped');
    // Past the 20 s the RAM kept it before.
    await browser.pause(Math.max(0, closedAt + 25000 - Date.now()));

    await browser.url(`${SITE}/watch`);
    const second = `s${pages}`;
    let tookBack = null;
    await browser.waitUntil(async () => {
      tookBack = (await playerState()).tookBack;
      return !!tookBack && tookBack.taken === tookBack.of;
    }, {timeout: 20000, interval: 300}).catch(() => {});
    await buffered(1);
    const again = [...placesFor(second)].filter((place) => kept.has(place));
    console.log(`      buffered ${kept.size} before the tab closed; took back ${JSON.stringify(tookBack)};`,
        `asked for again: ${again.length}`);
    expect(tookBack?.of).toBeGreaterThan(0);
    expect(tookBack.taken).toBe(tookBack.of);
    expect(again).toEqual([]);
    expect((await playerState()).failed).toBe(false);
  });
});
