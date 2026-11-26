// FastStream's player in four tabs at once, each downloading a whole video of its own from a fast line, with one
// RAM budget for all of them and the rest on the disk: what one player does must not break another's, and a tab
// that closes takes its files with it ("Off": at once).
//
// Each tab's page reports what it holds, many times a second, over a BroadcastChannel to the others (the driver
// switching tabs would bring each to the front, and change what is measured); the first one opened sees all of it.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';
import {loopedPlaylist} from '../loopedPlaylist.mjs';
import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const PORT = 41905;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SEGMENTS = path.resolve(import.meta.dirname, '../fixtures/hls-ts');
const TABS = ['a', 'b', 'c', 'd'];
// Each about 70 MB: 280 MB for a budget of 60 MB together.
const SECONDS = 243;
const BUDGET = 60e6;
// One fast home line for all of them: the budget is kept on the client's tick, once a second, and a player
// downloads up to a second of the line past its share before it (a local server unpaced: 2-2.7 budgets at most).
const LINE_BYTES_PER_S = 25e6;
// Per player, its next seconds (MemoryBudget.KEEP_AT_LEAST, 2-3 MB here) and the downloads in flight.
const SLACK_PER_PLAYER = 6e6;
const PLAYER = `moz-extension://${EXTENSION_UUID}/player/index.html`;

let server;
// Segments wait until every tab reports (released): a burst before a tab's probe went unseen.
/** @type {?Array<() => void>} */
let held = [];

/**
 * Sends a segment in 64 KiB pieces, no sooner than the one line for all answers allows.
 * @param {http.ServerResponse} res
 * @param {Buffer} bytes
 * @param {{freeAt: number}} line
 */
function sendPaced(res, bytes, line) {
  let at = 0;
  const next = () => {
    if (res.destroyed) return;
    if (at >= bytes.length) {
      res.end();
      return;
    }
    const piece = bytes.subarray(at, at + 65536);
    at += piece.length;
    const now = performance.now();
    line.freeAt = Math.max(now, line.freeAt) + piece.length / LINE_BYTES_PER_S * 1000;
    setTimeout(() => {
      if (!res.destroyed) res.write(piece) ? next() : res.once('drain', next);
    }, line.freeAt - now);
  };
  next();
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

/**
 * Opens FastStream's player in a tab of its own with a video's address, as for a video link opened in a tab.
 * @param {string} source
 * @return {Promise<string>} The tab's handle, found by its address.
 */
async function openPlayerTab(source) {
  const target = `${PLAYER}#${source}`;
  const handles = await browser.getWindowHandles();
  await browser.switchToWindow(handles[0]);
  await browser.url(OPENER_URL);
  await browser.execute((url) => void window.open(url, '_blank'), target);
  let found = null;
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      if (handles.includes(handle)) continue;
      await browser.switchToWindow(handle);
      if ((await browser.getUrl()) === target) {
        found = handle;
        return true;
      }
    }
    return false;
  }, {timeout: 20000, interval: 250, timeoutMsg: `no tab with the player of ${source}`});
  return /** @type {string} */ (found);
}

/**
 * Starts the probe in this tab's page: every 200 ms it posts what its player holds, and its own timer's lateness;
 * every tab keeps each tab's latest and the most all of them held in RAM at once (the first tab from the start).
 * @param {string} who
 * @return {Promise<void>}
 */
async function probe(who) {
  await browser.waitUntil(async () => browser.execute((who) => {
    const client = window.fastStream;
    if (!client?.player || !(client.fragments?.length > 0)) return false;
    if (window.__probe) return true;
    const channel = new BroadcastChannel('many-tabs-probe');
    const own = window.__probe = {failed: false, played: 0, late: 0};
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      own.late = Math.max(own.late, now - last - 50);
      last = now;
    }, 50);
    const all = window.__all = {latest: {}, mostRam: 0, mostRamAt: null};
    const take = (state) => {
      all.latest[state.who] = state;
      // What is on its way to the disk is still in RAM until written.
      const ram = Object.values(all.latest).reduce((sum, tab) => sum + tab.ram, 0);
      if (ram > all.mostRam) {
        all.mostRam = ram;
        all.mostRamAt = Object.fromEntries(Object.values(all.latest).map((tab) => [tab.who, tab.ram]));
      }
    };
    channel.onmessage = (event) => take(event.data);
    setInterval(() => {
      const manager = client.downloadManager;
      own.failed ||= !!client.interfaceController?.failed;
      own.played = Math.max(own.played, client.player?.getVideo()?.currentTime || 0);
      const state = {who, failed: own.failed, played: own.played, late: own.late, ram: manager.ramBytes(),
        leaving: manager.spillingBytes(), left: client.fragments.filter((fragment) => !fragment || fragment.status !== 3).length,
        session: manager.blobStore?.opfsManager?.sessionName || null};
      take(state);
      channel.postMessage(state);
    }, 200);
    const video = client.player.getVideo();
    video.muted = true;
    video.play().catch(() => {});
    return true;
  }, who), {timeout: 30000, interval: 250, timeoutMsg: `the player in tab ${who} never loaded its video`});
}

/** @return {Promise<Object>} What this tab collected. */
const collected = () => browser.execute(() => JSON.parse(JSON.stringify(window.__all)));

/**
 * @param {Object} all
 * @return {string} Each tab's latest, short.
 */
const summary = (all) => Object.values(all.latest).map((tab) =>
  `${tab.who}: ${(tab.ram / 1e6).toFixed(1)} MB in RAM (${(tab.leaving / 1e6).toFixed(1)} on its way to the disk), ` +
  `${tab.left} left, played ${tab.played.toFixed(1)} s${tab.failed ? ', FAILED' : ''}`).join('; ');

describe('Players in four tabs at once', function() {
  before(async function() {
    const playlist = loopedPlaylist(SECONDS, '/seg/', {unique: true});
    const cache = new Map();
    const line = {freeAt: 0};
    server = http.createServer((req, res) => {
      const url = new URL(req.url, ORIGIN);
      const headers = {'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store'};
      // /<tab>/video.m3u8, /<tab>/seg/seg-NNN.ts?i=<place>: each tab's video is its own download.
      const [, who, kind, name] = url.pathname.split('/');
      if (!TABS.includes(who)) {
        res.writeHead(404, headers);
        return res.end();
      }
      if (kind === 'video.m3u8') {
        res.writeHead(200, {...headers, 'Content-Type': 'application/vnd.apple.mpegurl'});
        return res.end(playlist.replaceAll('/seg/', `/${who}/seg/`));
      }
      if (kind !== 'seg' || !/^seg-\d+\.ts$/.test(name || '')) {
        res.writeHead(404, headers);
        return res.end();
      }
      if (!cache.has(name)) cache.set(name, fs.readFileSync(path.join(SEGMENTS, name)));
      const send = () => {
        res.writeHead(200, {...headers, 'Content-Type': 'video/mp2t', 'Content-Length': cache.get(name).length});
        sendPaced(res, cache.get(name), line);
      };
      // Well inside FetchLoader's 30 s stall timeout.
      if (held) held.push(send);
      else send();
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    await setOptions({});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('all play and download, hold no more RAM together than the one budget, and delete their files as they close', async function() {
    const run = Date.now();
    /** @type {Object<string, string>} */
    const handles = {};
    try {
      // One budget for all, the rest on the disk, each downloading its whole video; a closed tab's files deleted at
      // once.
      await setOptions({ramBudget: BUDGET, bufferToDisk: true, downloadAll: true, maxVideoSize: -1, bufferAhead: 300,
        storeProgress: false, bufferKeep: 0});
      // The last one opened stays in front; the first collects from the start.
      for (const who of ['b', 'c', 'd', 'a']) {
        handles[who] = await openPlayerTab(`${ORIGIN}/${who}/video.m3u8?run=${run}`);
        await probe(who);
      }
      const waiting = held ?? [];
      held = null;
      for (const send of waiting) send();

      // Until every tab has all of its video, and has written what goes to the disk.
      let all;
      try {
        await browser.waitUntil(async () => {
          all = await collected();
          return TABS.every((who) => all.latest[who]?.left === 0 && all.latest[who].leaving === 0);
        }, {timeout: 120000, interval: 1000});
      } catch (e) {
        throw new Error(`not every tab downloaded and wrote all of its video: ${all ? summary(all) : 'nothing collected'}`);
      }
      // Its share kept on the client's tick: a few of them, then what they hold.
      await browser.pause(4000);
      all = await collected();
      const ramNow = TABS.reduce((sum, who) => sum + all.latest[who].ram, 0);
      // The first tab saw all of it (the switch brings it to the front, all downloaded by now).
      await browser.switchToWindow(handles.b);
      const fromStart = await collected();
      await browser.switchToWindow(handles.a);
      console.log(`      ${summary(all)}`);
      console.log(`      in RAM together now ${(ramNow / 1e6).toFixed(1)} MB, at most ${(fromStart.mostRam / 1e6).toFixed(1)} MB`,
          `(${JSON.stringify(fromStart.mostRamAt)}); the tab in front's 50 ms timer at worst ${Math.round(all.latest.a.late)} ms late`);
      for (const who of TABS) {
        expect(all.latest[who].failed).toBe(false);
        expect(all.latest[who].played).toBeGreaterThan(0);
      }
      expect(ramNow).toBeLessThan(BUDGET + TABS.length * SLACK_PER_PLAYER);
      // Each kept to its share while it downloaded: at most the budget and a second of the line (each with the
      // whole budget would be 240 MB, none kept to it 280 MB).
      expect(fromStart.mostRam).toBeLessThan(BUDGET + LINE_BYTES_PER_S + TABS.length * SLACK_PER_PLAYER);
      // No freeze in the tab in front.
      expect(all.latest.a.late).toBeLessThan(1500);

      // Three tabs close: their files go with them (the directory with its last heartbeat waits for a prune), and the
      // one left gets the whole budget.
      const gone = ['b', 'c', 'd'].map((who) => all.latest[who].session);
      expect(gone.every(Boolean)).toBe(true);
      for (const who of ['b', 'c', 'd']) {
        await browser.switchToWindow(handles[who]);
        await browser.closeWindow();
        delete handles[who];
      }
      await browser.switchToWindow(handles.a);
      const played = all.latest.a.played;
      let left = null;
      try {
        await browser.waitUntil(async () => {
          left = await browser.execute(async (gone) => {
            const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('fsblob');
            const files = [];
            for await (const [name, dir] of root.entries()) {
              if (!gone.includes(name)) continue;
              for await (const file of dir.keys()) {
                if (file !== '_meta.json') files.push(`${name}/${file}`);
              }
            }
            return {files: files.length, some: files.slice(0, 3), share: window.fastStream.memoryShare().share};
          }, gone);
          return left.files === 0 && left.share === BUDGET;
        }, {timeout: 15000, interval: 500});
      } catch (e) {
        throw new Error(`the closed tabs' files or share stayed: ${JSON.stringify(left)}`);
      }
      // And it still plays.
      await browser.pause(3000);
      const after = (await collected()).latest.a;
      console.log(`      after the others closed: ${JSON.stringify({played: after.played, failed: after.failed})}`);
      expect(after.failed).toBe(false);
      expect(after.played).toBeGreaterThan(played);
    } finally {
      for (const handle of Object.values(handles)) {
        await browser.switchToWindow(handle).then(() => browser.closeWindow()).catch(() => {});
      }
      await browser.switchToWindow((await browser.getWindowHandles())[0]);
    }
  });
});
