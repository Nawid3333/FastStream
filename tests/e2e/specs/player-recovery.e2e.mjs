// A player error after the video has played builds the player again, at the same time,
// with what was downloaded (FastStreamClient.recoverPlayer).
//
// Every such error ended the video for good ("Failed to load video!"); the user reloaded the
// tab, which downloaded everything again. Seeks were the usual trigger: Firefox can fail to
// decode what a seek appends late (bug 2069633), and only a new MediaSource plays again.
// Here the error is the player's own event, the way every player reports one.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {loopedPlaylist} from '../loopedPlaylist.mjs';

const PORT = 41894;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SEGMENTS = path.resolve(import.meta.dirname, '../fixtures/hls-ts');

let server;
let requests = [];

/**
 * Opens the looped stream and plays it from a time.
 * @param {number} time - Where it plays from.
 * @return {Promise<void>}
 */
async function playAt(time) {
  await browser.url(`/player/index.html?t=${Date.now()}#${ORIGIN}/long.m3u8`);
  await browser.waitUntil(async () => browser.execute(() => {
    const v = window.fastStream?.player?.getVideo();
    if (!v) return false;
    if (v.paused) v.play().catch(() => {});
    return v.currentTime > 1;
  }), {timeout: 60000, interval: 250, timeoutMsg: 'the stream never played'});
  await browser.execute((to) => {
    window.fastStream.currentTime = to;
  }, time);
  await browser.waitUntil(async () => browser.execute((to) => {
    const v = window.fastStream.player.getVideo();
    if (v.paused) v.play().catch(() => {});
    return v.currentTime > to + 1;
  }, time), {timeout: 30000, interval: 250, timeoutMsg: 'it never played at ' + time});
  // Counts the players the client builds from here on.
  await browser.execute(() => {
    window.__players = [window.fastStream.player];
    window.__countPlayers = setInterval(() => {
      const player = window.fastStream.player;
      if (player && !window.__players.includes(player)) window.__players.push(player);
    }, 20);
  });
}

/**
 * Has the player report an error, as every player does (DefaultPlayerEvents.ERROR).
 * @return {Promise<void>}
 */
async function playerError() {
  await browser.execute(() => {
    window.__oldPlayer = window.fastStream.player;
    window.fastStream.player.emit('error', 'injected by the test');
  });
}

/**
 * What the client shows after an error: failed, or a new player that has a frame.
 * @return {Promise<Object>}
 */
async function afterError() {
  let state;
  await browser.waitUntil(async () => {
    state = await browser.execute(() => {
      const player = window.fastStream.player;
      const video = player?.getVideo();
      return {
        failed: !!window.fastStream.interfaceController.failed,
        rebuilt: !!player && player !== window.__oldPlayer && video?.readyState >= 2,
        time: video ? video.currentTime : 0,
        paused: video ? video.paused : null,
        players: window.__players.length,
        message: window.fastStream.interfaceController.statusManager.statusMessages.get('error')?.message,
      };
    });
    return state.failed || state.rebuilt;
  }, {timeout: 30000, interval: 250}).catch(() => {});
  return state;
}

describe('A player error after the video played', function() {
  before(async function() {
    const playlist = loopedPlaylist(600, '/seg/', {unique: true});
    server = http.createServer((req, res) => {
      const url = new URL(req.url, ORIGIN);
      const headers = {'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'};
      if (url.pathname === '/long.m3u8') {
        res.writeHead(200, {...headers, 'Content-Type': 'application/vnd.apple.mpegurl'});
        res.end(playlist);
        return;
      }
      const name = url.pathname.startsWith('/seg/') && path.basename(url.pathname);
      const file = name && /^seg-\d+\.ts$/.test(name) && path.join(SEGMENTS, name);
      if (!file || !fs.existsSync(file)) {
        res.writeHead(404, headers);
        res.end();
        return;
      }
      requests.push(Number(url.searchParams.get('i')));
      res.writeHead(200, {...headers, 'Content-Type': 'video/mp2t'});
      res.end(fs.readFileSync(file));
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
  });

  afterEach(async function() {
    await browser.execute(() => clearInterval(window.__countPlayers));
  });

  after(async function() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('builds the player again and plays on from the same time, without downloading again', async function() {
    requests = [];
    await playAt(60);
    // What is downloaded by now stays: none of it is asked for again.
    const downloaded = await browser.execute(() => window.fastStream.fragments
        .filter((fragment) => fragment && fragment.status === 3).map((fragment) => fragment.sn));
    const before = requests.length;

    await playerError();
    const rebuilt = await afterError();
    // Plays on, in the new player's own element.
    let time = 0;
    await browser.waitUntil(async () => {
      time = await browser.execute(() => window.fastStream.player.getVideo().currentTime);
      return time > 61;
    }, {timeout: 15000, interval: 250}).catch(() => {});
    // Whatever was on its way has arrived.
    await browser.pause(1500);
    const state = {...rebuilt, time};
    console.log(`      after the error: ${JSON.stringify(state)}`);

    expect(state.failed).toBe(false);
    expect(state.rebuilt).toBe(true);
    expect(state.players).toBe(2);
    // From where it was (whole seconds), not from the start.
    expect(state.time).toBeGreaterThan(61);
    const again = requests.slice(before).filter((place) => downloaded.includes(place));
    expect(again).toEqual([]);
  });

  it('stays paused when it was paused', async function() {
    await playAt(40);
    await browser.execute(() => window.fastStream.pause());
    await browser.pause(300);
    await playerError();
    const state = await afterError();
    await browser.pause(1000);
    const paused = await browser.execute(() => window.fastStream.player.getVideo().paused);
    console.log(`      paused, after the error: ${JSON.stringify({...state, paused})}`);
    expect(state.rebuilt).toBe(true);
    expect(paused).toBe(true);
  });

  it('builds it again three times, then ends in the error with its reason', async function() {
    await playAt(30);
    let state;
    for (let i = 0; i < 4; i++) {
      await playerError();
      state = await afterError();
      if (state.failed) break;
    }
    console.log(`      after four errors: ${JSON.stringify(state)}`);
    expect(state.failed).toBe(true);
    // The first player and its three rebuilds.
    expect(state.players).toBe(4);
    expect(state.message).toContain('injected by the test');
  });
});
