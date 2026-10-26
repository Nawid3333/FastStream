// Downloaded video stays in RAM up to the RAM budget, and only what does not fit goes to disk
// (FastStreamClient.enforceMemoryBudget, MemoryBudget) - or, with "Keep video on disk" off,
// is let go of and downloaded again when needed. Every fragment used to be written to
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

// A page call that has not come back in this time is a finding of its own. On CI's Windows
// runner (#456) one never came back: the test ran into mocha's 120 s cap with nothing said
// about where it was, or whether the page or its video had stopped. Every call here has
// this limit, and each wait stays well inside the cap (a test's this.timeout() does not lift
// it, testTimeout.mjs), so the step that got stuck says so, with the state it saw last.
const PAGE_ANSWER_MS = 5000;
const NO_ANSWER = 'no answer from the page';

/**
 * browser.execute, with a time limit.
 * @param {Function} fn - Run in the page.
 * @param {...*} args - Its arguments; an extra number as the last one sets the answer
 *     limit in ms, for the call that is IO and not a plain page read.
 * @return {Promise<*>} What fn returned, or NO_ANSWER.
 */
async function inPage(fn, ...args) {
  const last = args.length && typeof args[args.length - 1] === 'number' ? args.pop() : PAGE_ANSWER_MS;
  const call = browser.execute(fn, ...args);
  // Given up on, it may still fail later, with the session.
  call.catch(() => {});
  let timer;
  try {
    return await Promise.race([call, new Promise((resolve) => {
      timer = setTimeout(() => resolve(NO_ANSWER), last);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opens the looped stream (two minutes) with a RAM budget and waits until all of it is
 * downloaded.
 * @param {number} budget - Bytes.
 * @param {string} [playlist] - /long.m3u8, or /slow/long.m3u8: its segments come 150 ms late.
 * @param {number} [timeout] - For all of it to be downloaded.
 * @param {boolean} [disk] - "Keep video on disk when this RAM is full".
 * @return {Promise<void>}
 */
async function downloadAll(budget, playlist = '/long.m3u8', timeout = 60000, disk = true) {
  await browser.url(`/player/index.html?t=${Date.now()}#${ORIGIN}${playlist}`);
  await browser.waitUntil(async () => (await inPage((bytes, disk) => {
    const client = window.fastStream;
    if (!client?.player || !client.fragments?.length) return false;
    client.options.ramBudget = bytes;
    client.options.bufferToDisk = disk;
    client.downloadManager.setBufferToDisk(disk);
    // Every fragment the player lets go of, to be downloaded again when needed (holdings'
    // letGo). With the disk on, the budget writes what does not fit and lets go of none.
    if (client.letGo === undefined) {
      client.letGo = 0;
      const free = client.freeFragment;
      client.freeFragment = function(fragment) {
        client.letGo++;
        return free.call(this, fragment);
      };
    }
    return true;
  }, budget, disk)) === true, {timeout: 30000, interval: 250, timeoutMsg: 'the stream never loaded'});
  let left;
  try {
    await browser.waitUntil(async () => {
      left = await inPage(() => {
        const fragments = window.fastStream.fragments;
        return fragments.length > 50 ? fragments.filter((fragment) => !fragment || fragment.status !== 3).length : -1;
      });
      return left === 0;
    }, {timeout, interval: 500});
  } catch (e) {
    // -1: the playlist not read yet. What the player held then: a fragment let go of while
    // it was being written was downloaded again and again (letGo), FastStreamClient.
    // keepWithinMemoryBudget.
    throw new Error(`the stream never finished downloading in ${timeout} ms: ${left} fragments to go, ` +
        `holding ${JSON.stringify(await holdings())}`);
  }
}

/**
 * Plays the stream from its start - on disk, or let go of long ago - and waits for it to run
 * past 2 s. Polled from here, a short call at a time: the loop that waited in the page was
 * the call that never came back (#456).
 * @param {string} when - What is played, for the failure message.
 * @return {Promise<Object>} The video's state then: time, failed and more.
 */
async function playFromStart(when) {
  await inPage(() => {
    const client = window.fastStream;
    client.currentTime = 1;
    client.player.getVideo().play().catch(() => {});
  });
  let state;
  try {
    await browser.waitUntil(async () => {
      state = await inPage(() => {
        const client = window.fastStream;
        const video = client.player.getVideo();
        const buffered = [];
        for (let i = 0; i < video.buffered.length; i++) {
          buffered.push([Math.round(video.buffered.start(i) * 10) / 10, Math.round(video.buffered.end(i) * 10) / 10]);
        }
        return {
          time: video.currentTime, seeking: video.seeking, paused: video.paused, readyState: video.readyState,
          buffered, failed: !!client.interfaceController.failed, visibility: document.visibilityState,
          // The start's fragments: 3 is downloaded, in RAM or on disk.
          start: client.fragments.slice(0, 4).map((fragment) => fragment?.status),
        };
      });
      return state !== NO_ANSWER && (state.failed || (state.time > 2 && !state.seeking));
    }, {timeout: 20000, interval: 500});
  } catch (e) {
    throw new Error(`${when}: the start never played past 2 s (${e.message}). Last seen: ${JSON.stringify(state)}`);
  }
  return state;
}

/**
 * Waits until what the player holds passes a check. The failure says what it held last: the
 * message these waits had was made before their first look, and said "undefined" whatever
 * the player held (#456).
 * @param {function(Object): boolean} check - On holdings().
 * @param {number} timeout - ms.
 * @param {string} failure - What did not happen, for the message.
 * @return {Promise<Object>} The holdings that passed.
 */
async function holdingsUntil(check, timeout, failure) {
  let state;
  try {
    await browser.waitUntil(async () => {
      state = await holdings();
      return state !== NO_ANSWER && check(state);
    }, {timeout, interval: 500});
  } catch (e) {
    throw new Error(`${failure} after ${timeout} ms: ${JSON.stringify(state)}`);
  }
  return state;
}

/**
 * @return {Promise<Object|string>} What the player holds where: in RAM (with what is being
 *     written to disk, as leaving), on disk (files: in this player's own OPFS session; others:
 *     in the sessions the players of the tests before left), in all (total), and how many
 *     fragments it let go of (letGo, downloadAll). NO_ANSWER when the page did not answer
 *     in time.
 */
async function holdings() {
  // The call walks every OPFS session's files; with the disk writes of this test's budget
  // in flight it now and then took over the usual 5 s on the Windows runner, every poll of
  // holdingsUntil said "no answer from the page", and 60 s ran out with nothing said (once
  // in a week; the retry's writes were done in 15.7 s). Its own window: stuck is stuck at
  // 20 s, slow-but-alive IO answers.
  return inPage(() => new Promise((done) => {
    (async () => {
      const client = window.fastStream;
      const manager = client.downloadManager;
      const store = manager.blobStore;
      // Counted over every session, the earlier tests' files counted for this player's.
      const own = store.opfsManager?.sessionName;
      let files = 0;
      let others = 0;
      try {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('fsblob');
        for await (const [session, dir] of root.entries()) {
          for await (const [name] of dir.entries()) {
            if (name === '_meta.json') continue;
            if (session === own) files++;
            else others++;
          }
        }
      } catch (e) {
        files = -1;
      }
      const total = client.fragments.reduce((sum, fragment) => sum + (fragment?.dataSize || 0), 0);
      done({ram: manager.ramBytes(), leaving: manager.spillingBytes(), total, files, others,
        letGo: client.letGo, opfs: !!store.opfsManager, full: manager.memoryFull});
    })();
  }), PAGE_ANSWER_MS * 4);
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

  it('with "Keep video on disk" off, lets go of what does not fit, writes none of it, and plays it again', async function() {
    // The option (2026-10-10): as in a private window, what does not fit in the budget is let
    // go of and downloaded again when needed. All of it in first (it fits in 2 GB), then a
    // budget it does not fit in.
    await downloadAll(2e9, '/long.m3u8', 60000, false);
    await inPage(() => {
      window.fastStream.options.ramBudget = 2e6;
    });
    const bound = 2e6 + 4e6;
    const state = await holdingsUntil((held) => held.ram < bound, 30000, 'still more in RAM than its share');
    const released = await inPage(() => window.fastStream.fragments.filter((fragment) => fragment && fragment.status !== 3).length);
    console.log(`      no disk, over the budget: ${JSON.stringify(state)}, ${released} fragments let go`);
    expect(state.files).toBe(0);
    expect(released).toBeGreaterThan(20);

    // The start, let go of long ago, is downloaded again and plays.
    const played = await playFromStart('the start, let go of');
    console.log(`      downloaded again: ${JSON.stringify(played)}`);
    expect(played.failed).toBe(false);
    expect(played.time).toBeGreaterThan(2);
    expect((await holdings()).files).toBe(0);
  });

  it('writes what does not fit to disk, and still plays it from there', async function() {
    const budget = 2e6;
    // Down to its share and the next seconds (MemoryBudget.KEEP_AT_LEAST: 10 s, here 2-3 MB).
    const bound = budget + 4e6;
    await downloadAll(budget);
    // The local server mostly sends the whole stream before the client's next tick (once a
    // second) keeps the budget; when not, the downloads ahead wait for the writes. A RAM copy
    // goes only once it is on disk: 13-16 of the ~65 files were there after 4 s on the Windows
    // runner (PR #366), all of them locally.
    const start = Date.now();
    const state = await holdingsUntil((held) => held.ram < bound, 60000, 'still more in RAM than its share');
    console.log(`      over the budget, after ${Date.now() - start} ms: ${JSON.stringify(state)}`);
    expect(state.files).toBeGreaterThan(0);
    // Written, none let go of. A fragment still being written when the next tick chose it
    // again was (FastStreamClient.keepWithinMemoryBudget), and downloaded again: on the
    // Windows runner the stream then never finished downloading.
    expect(state.letGo).toBe(0);

    // The start, long written to disk, plays again.
    const played = await playFromStart('the start, on disk');
    console.log(`      from disk: ${JSON.stringify(played)}`);
    expect(played.failed).toBe(false);
    expect(played.time).toBeGreaterThan(2);
  });

  it('with a budget of 0, downloads ahead to disk and keeps only the next seconds in RAM', async function() {
    // 0 was nothing ahead: no download ahead at all, the stream never in (the user's
    // decision, 2026-10-09: 0 RAM is straight to disk). Slow segments, for the budget to be
    // set long before the stream is in.
    await downloadAll(0, '/slow/long.m3u8', 60000);
    // The next 10 s (MemoryBudget.KEEP_AT_LEAST), here 2-3 MB.
    const state = await holdingsUntil((held) => held.ram < 4e6, 30000, 'more in RAM than the next seconds');
    console.log(`      budget 0: ${JSON.stringify(state)}`);
    // About 60 fragments: all but the next seconds on disk, written by this player (holdings).
    expect(state.files).toBeGreaterThan(40);
    expect(state.full).toBe(false);
    // With a budget of 0 the next seconds are never let go of, so every tick asked for more
    // than the rest held, and chose fragments still being written: let go of, downloaded
    // again, written again. RAM stayed at 7-13 MB for 30 s on the Windows runner.
    expect(state.letGo).toBe(0);
  });
});
