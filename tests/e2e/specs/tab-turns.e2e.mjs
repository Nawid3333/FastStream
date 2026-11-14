// Players in several tabs share the line: the one the user looks at downloads first, the ones
// in background tabs after it (PlayerTurns, PlayerPeers.shouldWait, DownloadManager.setWaiting).
//
// Before, a player in a background tab stepped aside only while the watched one was short of
// video (under 10 s ahead). Past that, each took its share of the line: the video in front
// buffered at a fraction of the line's speed for as long as the others had anything left to
// download. Measured with tools/bench-ab.mjs (--scenarios tabs, three players in background
// tabs, 8 Mbit/s): the one in front had its whole video after 66 s, and after 30 s with turns.
//
// Here: one line of 6 Mbit/s for both videos (about 2.1 Mbit/s each, so nobody leaves room
// for the other), each video on a host of its own - on one host Firefox itself serves the
// active tab first, which tabs on different sites do not get. The server's log tells who
// asked for a segment when.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {loopedPlaylist} from '../loopedPlaylist.mjs';

const PORT = 41903;
const HOSTS = {back: '127.0.0.2', front: '127.0.0.3'};
const SEGMENTS = path.resolve(import.meta.dirname, '../fixtures/hls-ts');
const LINE_MBIT = 6;
// The video in the background tab is the longer one: it has plenty left when the one in
// front starts, and after it.
const SECONDS = {back: 72, front: 63};
// A player hears of the other within a message; what it had asked for by then comes in.
const SETTLE_MS = 2000;
// The segments a player paused in its first seconds asks for itself, for its playback's
// 10 s ahead: up to this place (15 s in).
const OWN_NEXT_PLACES = 7;

/** @type {http.Server[]} */
let servers = [];
/** @type {Array<{who: string, place: number, at: number}>} */
let asked = [];
/** @type {Array<{who: string, place: number, at: number}>} */
let sent = [];

/**
 * One line for every answer: a byte goes out no sooner than the line's rate allows after
 * the bytes before it, whichever answer they were in.
 * @return {(bytes: number) => number} How long to wait, in ms, before sending so many bytes.
 */
function sharedLine() {
  let freeAt = 0;
  const bytesPerMs = LINE_MBIT * 1e6 / 8 / 1000;
  return (bytes) => {
    const now = performance.now();
    freeAt = Math.max(now, freeAt) + bytes / bytesPerMs;
    return freeAt - now;
  };
}

/**
 * Sends a segment in 32 KiB pieces at the line's rate.
 * @param {http.ServerResponse} res
 * @param {Buffer} bytes
 * @param {(bytes: number) => number} line
 * @param {() => void} done - Called once all of it went out.
 */
function sendPaced(res, bytes, line, done) {
  let at = 0;
  const next = () => {
    if (res.destroyed) return;
    if (at >= bytes.length) {
      res.end();
      done();
      return;
    }
    const piece = bytes.subarray(at, at + 32768);
    at += piece.length;
    setTimeout(() => {
      if (res.destroyed) return;
      res.write(piece) ? next() : res.once('drain', next);
    }, line(piece.length));
  };
  next();
}

/**
 * The places of a player's video the server has sent whole.
 * @param {string} who - 'back' or 'front'.
 * @return {Set<number>}
 */
const sentOf = (who) => new Set(sent.filter((entry) => entry.who === who).map((entry) => entry.place));

/**
 * How many segments a video of so many seconds has (the fixture's 9 s are 5 segments).
 * @param {number} seconds
 * @return {number}
 */
const segmentsOf = (seconds) => Math.ceil(seconds / 9) * 5;

/**
 * Plays the player in this tab, and waits until it does.
 * @param {string} what - For the failure.
 * @return {Promise<void>}
 */
async function playing(what) {
  await browser.waitUntil(async () => browser.execute(() => {
    const video = document.querySelector('video');
    if (!video || !window.fastStream?.player) return false;
    if (video.paused) video.play().catch(() => {});
    return video.currentTime > 0.5;
  }), {timeout: 60000, interval: 250, timeoutMsg: `${what} never played`});
}

describe('Players in several tabs', function() {
  before(async function() {
    const line = sharedLine();
    const cache = new Map();
    const handler = (/** @type {http.IncomingMessage} */ req, /** @type {http.ServerResponse} */ res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const headers = {'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store'};
      const [, who, kind, name] = url.pathname.split('/');
      if (!(who in SECONDS)) {
        res.writeHead(404, headers);
        return res.end();
      }
      if (kind === 'video.m3u8') {
        res.writeHead(200, {...headers, 'Content-Type': 'application/vnd.apple.mpegurl'});
        return res.end(loopedPlaylist(SECONDS[who], `/${who}/seg/`, {unique: true}));
      }
      if (kind !== 'seg' || !/^seg-\d+\.ts$/.test(name || '')) {
        res.writeHead(404, headers);
        return res.end();
      }
      if (!cache.has(name)) cache.set(name, fs.readFileSync(path.join(SEGMENTS, name)));
      const place = Number(url.searchParams.get('i'));
      asked.push({who, place, at: Date.now()});
      res.writeHead(200, {...headers, 'Content-Type': 'video/mp2t', 'Content-Length': cache.get(name).length});
      sendPaced(res, cache.get(name), line, () => sent.push({who, place, at: Date.now()}));
    };
    servers = await Promise.all(Object.values(HOSTS).map((host) => new Promise((resolve, reject) => {
      const server = http.createServer(handler);
      server.on('error', reject);
      server.listen(PORT, host, () => resolve(server));
    })));
  });

  after(async function() {
    await Promise.all(servers.map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }));
  });

  it('download in turns on a slow line: the one in front first, the others after it', async function() {
    asked = [];
    sent = [];
    const first = await browser.getWindowHandle();
    const run = Date.now();
    let opened = null;
    try {
      // A video the user started and left paused, in a tab that goes to the background.
      await browser.url(`/player/index.html?t=${run}a#http://${HOSTS.back}:${PORT}/back/video.m3u8?run=${run}`);
      await playing('the first tab\'s video');
      await browser.execute(() => window.fastStream.pause());

      // The tab in front: opening it hides the first.
      opened = await browser.createWindow('tab');
      await browser.switchToWindow(opened.handle);
      await browser.url(`/player/index.html?t=${run}b#http://${HOSTS.front}:${PORT}/front/video.m3u8?run=${run}`);
      await playing('the video in front');

      // Until the one in front has asked for its last segment.
      const total = segmentsOf(SECONDS.front);
      const frontAsked = () => new Set(asked.filter((entry) => entry.who === 'front').map((entry) => entry.place));
      await browser.waitUntil(async () => frontAsked().size >= total, {timeout: 90000, interval: 250,
        timeoutMsg: `the video in front never asked for all its segments (${frontAsked().size} of ${total})`});
      const frontFirst = Math.min(...asked.filter((entry) => entry.who === 'front').map((entry) => entry.at));
      const frontLast = Math.max(...asked.filter((entry) => entry.who === 'front').map((entry) => entry.at));
      const backBefore = asked.filter((entry) => entry.who === 'back' && entry.at < frontFirst).length;
      // What the background tab asked for while the one in front still had segments to ask
      // for, once it had heard of it.
      const meanwhile = asked.filter((entry) => entry.who === 'back' && entry.at > frontFirst + SETTLE_MS && entry.at < frontLast);
      console.log(`      the one in front asked for its ${total} segments within ${((frontLast - frontFirst) / 1000).toFixed(1)} s;`,
          `the background tab had asked for ${backBefore} of ${segmentsOf(SECONDS.back)} before, and asked for ${meanwhile.length} meanwhile`,
          JSON.stringify(meanwhile.map((entry) => [entry.place, entry.at - frontFirst])));
      // It had not finished before (then there was nothing to wait with).
      expect(backBefore).toBeLessThan(segmentsOf(SECONDS.back) - 10);
      // Its own next seconds it still gets (it is paused near its start, and its playback
      // keeps 10 s ahead: the first six or seven segments), to play at once when the user
      // comes back. Past those it starts nothing. (Without turns: segments 8 to 12 here.)
      const ahead = meanwhile.filter((entry) => entry.place > OWN_NEXT_PLACES);
      expect(ahead.map((entry) => entry.place)).toEqual([]);

      // Then the background tab's turn: it gets the rest, with nobody watching it.
      await browser.waitUntil(async () => sentOf('back').size >= segmentsOf(SECONDS.back), {timeout: 90000, interval: 500,
        timeoutMsg: `the background tab never got its video (${sentOf('back').size} of ${segmentsOf(SECONDS.back)} segments)`});
      expect(sentOf('front').size).toBe(total);
      // And the one in front still plays.
      const state = await browser.execute(() => ({failed: !!window.fastStream.interfaceController?.failed,
        time: document.querySelector('video').currentTime}));
      expect(state.failed).toBe(false);
      expect(state.time).toBeGreaterThan(1);
    } finally {
      if (opened) {
        await browser.switchToWindow(opened.handle).then(() => browser.closeWindow()).catch(() => {});
      }
      await browser.switchToWindow(first);
    }
  });
});
