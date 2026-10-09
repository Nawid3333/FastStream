// Downloaded video stays in RAM up to the RAM budget, and only what does not fit goes to disk
// (FastStreamClient.enforceMemoryBudget, MemoryBudget). Every fragment used to be written to
// OPFS at once - 44 ms for a 1.5 MB fragment, measured - even for a video that fits in RAM
// many times over.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {loopedPlaylist} from '../loopedPlaylist.mjs';

const PORT = 41895;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SEGMENTS = path.resolve(import.meta.dirname, '../fixtures/hls-ts');

let server;

/**
 * Opens the looped stream (two minutes) with a RAM budget and waits until all of it is
 * downloaded.
 * @param {number} budget - Bytes.
 * @param {string} [playlist] - /long.m3u8, or /slow/long.m3u8: its segments come 150 ms late.
 * @param {number} [timeout] - For all of it to be downloaded.
 * @return {Promise<void>}
 */
async function downloadAll(budget, playlist = '/long.m3u8', timeout = 120000) {
  await browser.url(`/player/index.html?t=${Date.now()}#${ORIGIN}${playlist}`);
  await browser.waitUntil(async () => browser.execute((bytes) => {
    const client = window.fastStream;
    if (!client?.player || !client.fragments?.length) return false;
    client.options.ramBudget = bytes;
    return true;
  }, budget), {timeout: 60000, interval: 250, timeoutMsg: 'the stream never loaded'});
  await browser.waitUntil(async () => browser.execute(() => {
    const fragments = window.fastStream.fragments;
    return fragments.length > 50 && fragments.every((fragment) => fragment && fragment.status === 3);
  }), {timeout, interval: 500, timeoutMsg: 'the stream never finished downloading'});
}

/**
 * @return {Promise<Object>} What the player holds where: in RAM (with what is being written
 *     to disk, as leaving), on disk (files), and in all (total).
 */
async function holdings() {
  return browser.executeAsync(async (done) => {
    const client = window.fastStream;
    const manager = client.downloadManager;
    const store = manager.blobStore;
    let files = 0;
    try {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('fsblob');
      for await (const [, dir] of root.entries()) {
        for await (const [name] of dir.entries()) {
          if (name !== '_meta.json') files++;
        }
      }
    } catch (e) {
      files = -1;
    }
    const total = client.fragments.reduce((sum, fragment) => sum + (fragment?.dataSize || 0), 0);
    done({ram: manager.ramBytes(), leaving: manager.spillingBytes(), total, files, opfs: !!store.opfsManager,
      full: manager.memoryFull});
  });
}

describe('The RAM budget', function() {
  before(async function() {
    const playlist = loopedPlaylist(120, '/seg/', {unique: true});
    const slowPlaylist = loopedPlaylist(120, '/slow/seg/', {unique: true});
    server = http.createServer((req, res) => {
      const url = new URL(req.url, ORIGIN);
      const slow = url.pathname.startsWith('/slow/');
      if (slow) url.pathname = url.pathname.slice('/slow'.length);
      const headers = {'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'};
      if (url.pathname === '/long.m3u8') {
        res.writeHead(200, {...headers, 'Content-Type': 'application/vnd.apple.mpegurl'});
        res.end(slow ? slowPlaylist : playlist);
        return;
      }
      const name = url.pathname.startsWith('/seg/') && path.basename(url.pathname);
      const file = name && /^seg-\d+\.ts$/.test(name) && path.join(SEGMENTS, name);
      if (!file || !fs.existsSync(file)) {
        res.writeHead(404, headers);
        res.end();
        return;
      }
      const send = () => {
        res.writeHead(200, {...headers, 'Content-Type': 'video/mp2t'});
        res.end(fs.readFileSync(file));
      };
      if (slow) setTimeout(send, 150);
      else send();
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('keeps a video that fits in RAM, and writes none of it to disk', async function() {
    await downloadAll(2e9);
    // The budget is kept on the client's tick, once a second: a few ticks, to see that none of
    // them writes anything.
    await browser.pause(4000);
    const state = await holdings();
    console.log(`      fits: ${JSON.stringify(state)}`);
    expect(state.opfs).toBe(true);
    expect(state.files).toBe(0);
    expect(state.total).toBeGreaterThan(0);
    // All of it, and the playlist.
    expect(state.ram).toBeGreaterThanOrEqual(state.total);
  });

  it('writes what does not fit to disk, and still plays it from there', async function() {
    const budget = 2e6;
    // Down to its share and the next seconds (MemoryBudget.KEEP_AT_LEAST: 10 s, here 2-3 MB).
    const bound = budget + 4e6;
    await downloadAll(budget);
    // The local server sends the whole stream before the test sets the budget, and a RAM copy
    // goes only once it is on disk: 13-16 of the ~65 files were there after 4 s on the Windows
    // runner (PR #366), all of them locally.
    const start = Date.now();
    let state;
    await browser.waitUntil(async () => {
      state = await holdings();
      return state.ram < bound;
    }, {timeout: 60000, interval: 500, timeoutMsg: `still more in RAM than its share: ${JSON.stringify(state)}`});
    console.log(`      over the budget, after ${Date.now() - start} ms: ${JSON.stringify(state)}`);
    expect(state.files).toBeGreaterThan(0);

    // The start, long written to disk, plays again.
    const played = await browser.executeAsync(async (done) => {
      const client = window.fastStream;
      client.currentTime = 1;
      const video = client.player.getVideo();
      video.play().catch(() => {});
      const start = Date.now();
      while (Date.now() - start < 15000) {
        if (video.currentTime > 2 && !video.seeking) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      done({time: video.currentTime, failed: !!client.interfaceController.failed});
    });
    console.log(`      from disk: ${JSON.stringify(played)}`);
    expect(played.failed).toBe(false);
    expect(played.time).toBeGreaterThan(2);
  });

  it('with a budget of 0, downloads ahead to disk and keeps only the next seconds in RAM', async function() {
    // 0 was nothing ahead: no download ahead at all, the stream never in (the user's
    // decision, 2026-10-09: 0 RAM is straight to disk). Slow segments, for the budget to be
    // set long before the stream is in.
    await downloadAll(0, '/slow/long.m3u8', 60000);
    let state;
    await browser.waitUntil(async () => {
      state = await holdings();
      // The next 10 s (MemoryBudget.KEEP_AT_LEAST), here 2-3 MB.
      return state.ram < 4e6;
    }, {timeout: 30000, interval: 500, timeoutMsg: `more in RAM than the next seconds: ${JSON.stringify(state)}`});
    console.log(`      budget 0: ${JSON.stringify(state)}`);
    // About 60 fragments: all but the next seconds on disk.
    expect(state.files).toBeGreaterThan(40);
    expect(state.full).toBe(false);
  });
});
