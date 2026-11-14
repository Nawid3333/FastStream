// A video FastStream cannot load itself, and its page can: loaded through the page (page-fetch.js,
// PageFetch.mjs, PageFetchRelay.mjs).
//
// FastStream's player loads from its extension page, which is no part of the page that showed
// the video. Two kinds of site answer that request with something other than the video:
//
// - A video only the page's service worker answers (abyss.to's player, #665). Its <video> names
//   an address with the video's id in the fragment; the worker reads the fragment and answers
//   with the file it fetches itself, and the server answers that address "Video not found" to
//   anyone else. Firefox tells add-ons nothing of an answer a service worker gives: content.js
//   reports the file the page's <video> has (loadedmetadata), fragment and all, and the player,
//   refused, loads it through the page.
// - A link only the page's cookie as it is now opens: the server renews the page's session
//   cookie with the video's first answer, and refuses the old one. The headers FastStream took
//   from the page's request carry the old one; the page's own requests carry the new one. The
//   player is refused, tries once more through the page, and loads through it from then on.
//
// Both are played here from a local server, and the requests it saw are logged per test.
//
// Saving takes the same loader, so the same way through the page: each kind is saved through
// the Save button and the name prompt, and the file Firefox writes must be the film byte for
// byte. A save cancelled half-way must leave the player able to save again.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';
import {byteRange, sendFile} from '../serveFile.mjs';

const PORT = 41901;
const SITE = `http://127.0.0.1:${PORT}`;
const FILM = path.resolve(import.meta.dirname, '../fixtures/long-av.mp4');
// The folder wdio.extension.conf.mjs points Firefox's downloads at.
const DOWNLOADS = path.resolve(import.meta.dirname, '../../../.e2e-downloads');
// The player fetches from a moz-extension:// frame: CORS, preflight included.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
};

// The service worker's site: the page, its worker, and the files only the worker may fetch
// (it names itself with X-Worker). The video's id in the fragment picks the file.
const SW_PAGE = `<!doctype html><title>sw video</title>
  <body style="margin:0;background:#000">
  <script>
    const sw = navigator.serviceWorker;
    if (sw.controller) {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      video.style.cssText = 'width:640px;height:360px';
      // One address for every video; the id after '#' picks it (?clip=, mp4/clip-1 by default; a path, as abyss.to's).
      video.src = '/sw/video/play#' + (new URLSearchParams(location.search).get('clip') || 'mp4/clip-1');
      document.body.append(video);
    } else if (!sessionStorage.getItem('reloaded')) {
      // A page the worker does not control yet: once more, under it.
      sessionStorage.setItem('reloaded', '1');
      sw.register('/sw/worker.js', {scope: '/sw/'}).then(() => sw.ready).then(() => location.reload());
    } else {
      document.title = 'no service worker';
    }
  </script>`;
const SW_SCRIPT = `
  const FILES = {'mp4/clip-1': '/sw/store/long-av.mp4', 'mp4/clip-2': '/sw/store/long-av.mp4',
    'mp4/clip-3': '/sw/store/long-av.mp4', 'mp4/clip-4': '/sw/store/long-av.mp4'};
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (!url.pathname.startsWith('/sw/video/')) return;
    // The video's id is in the fragment, which only the worker reads (the server never sees it).
    const file = FILES[url.hash.slice(1)];
    if (!file) return;
    event.respondWith((async () => {
      const headers = {'X-Worker': '1'};
      const range = event.request.headers.get('range');
      if (range) headers.Range = range;
      const upstream = await fetch(file + '?for=' + encodeURIComponent(url.pathname + url.hash), {headers});
      // A response of its own, as a worker that decrypts its video makes: no URL of the file's.
      return new Response(upstream.body, {status: upstream.status, statusText: upstream.statusText,
        headers: upstream.headers});
    })());
  });`;

let server;
/**
 * What the server saw, per request.
 * @type {Array<{path: string, status: number, range: string, cookie: string, referer: string,
 *   origin: string, site: string, mode: string, dest: string, worker: string}>}
 */
let seen = [];
// The cookie site's session: the page's load issues `initial`; the video's first answer with
// it renews it to `current`, and from then on only `current` opens the video.
const session = {loads: 0, initial: '', current: ''};
// While set, the worker's file answers a range past its first quarter only after this many
// milliseconds: a save then takes long enough to be cancelled half-way.
let storeDelayMs = 0;

/**
 * Notes a request and its answer's status.
 * @param {http.IncomingMessage} req
 * @param {URL} url
 * @param {number} status
 */
function note(req, url, status) {
  const h = req.headers;
  seen.push({path: url.pathname + url.search, status, range: String(h.range || ''), cookie: String(h.cookie || ''),
    referer: String(h.referer || ''), origin: String(h.origin || ''), site: String(h['sec-fetch-site'] || ''),
    mode: String(h['sec-fetch-mode'] || ''), dest: String(h['sec-fetch-dest'] || ''),
    worker: String(h['x-worker'] || '')});
}

/**
 * Answers with the film, or the range of it asked for.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url
 * @param {Object<string, string>} [extra] - More headers (Set-Cookie).
 */
function sendFilm(req, res, url, extra = {}) {
  // Never from Firefox's cache: a range an earlier test loaded came back from it, and the
  // server never saw which way a save asked.
  extra = {'Cache-Control': 'no-store', ...extra};
  const size = fs.statSync(FILM).size;
  const range = byteRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    note(req, url, 416);
    res.writeHead(416, {...CORS, 'Content-Range': `bytes */${size}`});
    res.end();
    return;
  }
  if (range) {
    note(req, url, 206);
    res.writeHead(206, {...CORS, ...extra, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': range.end - range.start + 1});
    sendFile(res, FILM, range);
    return;
  }
  note(req, url, 200);
  res.writeHead(200, {...CORS, ...extra, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size});
  sendFile(res, FILM);
}

/**
 * The value of the session cookie a request carries, or ''.
 * @param {http.IncomingMessage} req
 * @return {string}
 */
function sessionOf(req) {
  return /(?:^|;\s*)sess=([^;]*)/.exec(String(req.headers.cookie || ''))?.[1] || '';
}

// The page's iframe the player opens in (a selector), or null for the top page.
let playerPage = null;

/**
 * The player's state, in its frame; player false while the page has none.
 * @return {Promise<{player?: boolean, url: string, time: number, paused: boolean, readyState: number, failed: boolean}>}
 */
async function playerState() {
  await browser.switchFrame(null);
  if (playerPage) {
    if (!(await browser.$(playerPage).isExisting())) {
      return {player: false, url: '', time: 0, paused: true, readyState: 0, failed: false};
    }
    await browser.switchFrame(await browser.$(playerPage));
  }
  if (!(await browser.$('iframe[src*="player/index.html"]').isExisting())) {
    return {player: false, url: '', time: 0, paused: true, readyState: 0, failed: false};
  }
  await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
  return browser.execute(() => {
    const client = window.fastStream;
    const video = client?.player?.getVideo?.();
    const buffered = [];
    for (let i = 0; video?.buffered && i < video.buffered.length; i++) {
      buffered.push([Math.round(video.buffered.start(i)), Math.round(video.buffered.end(i))]);
    }
    return {url: client?.source?.url || '', time: client?.currentTime || 0,
      paused: !!video?.paused, readyState: video?.readyState || 0, failed: !!client?.interfaceController?.failed,
      // For a failure's message: what the player is, and what its element has.
      kind: client?.player?.constructor?.name || '', duration: client?.duration || 0, buffered,
      error: video?.error ? `${video.error.code} ${video.error.message}` : ''};
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
    await browser.switchFrame(null);
    const title = await browser.getTitle().catch(() => '?');
    throw new Error(`${what}; the player: ${JSON.stringify(state)}, the page's title: ${title}, ` +
      `the server saw: ${JSON.stringify(seen.slice(-12))}`);
  }
  return state;
}

/**
 * Plays the player from where it is, and waits until it has played past a time.
 * @param {number} past - Seconds.
 * @param {string} what
 * @return {Promise<Object>} The state that passed.
 */
async function playPast(past, what) {
  await playerState();
  await browser.execute(() => window.fastStream.play());
  return waitForPlayer((s) => s.time > past && !s.paused && !s.failed, what);
}

/**
 * Logs the requests the server saw in a test: those with the same address, headers and answer in
 * one line, with their count and their first and last Range.
 */
function logSeen() {
  console.log(`      the server saw ${seen.length} requests:`);
  const lines = new Map();
  for (const r of seen) {
    const {range, ...rest} = r;
    const key = JSON.stringify(rest);
    const line = lines.get(key) || {count: 0, firstRange: range, lastRange: range};
    line.count++;
    line.lastRange = range;
    lines.set(key, line);
  }
  for (const [key, line] of lines) {
    console.log(`        ${line.count}x ${key} ranges ${line.firstRange} .. ${line.lastRange}`);
  }
}

/**
 * A file's SHA-256, in hex.
 * @param {string} file
 * @return {string}
 */
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * The save's status line and whether its banner shows, in the player's frame; and, for a
 * timeout's message, the dialog open and where the save manager stands. A save that never
 * began on the Linux runner (2026-11-14, passed on its retry) left nothing else to go by.
 * @return {Promise<{banner: boolean, status: string, dialog: ?string, asking: boolean,
 *   making: boolean}>}
 */
async function saveState() {
  await playerState();
  return browser.execute(() => {
    const banner = document.querySelector('#save_notif_banner');
    const dialog = document.querySelector('dialog.fs-dialog[open]');
    const save = /** @type {any} */ (window).fastStream?.interfaceController?.saveManager;
    return {banner: !!banner && banner.style.display !== 'none',
      status: Array.from(document.querySelectorAll('.status_message'), (m) => m.textContent.trim()).filter(Boolean).join(' | '),
      dialog: dialog ? dialog.textContent.trim().slice(0, 200) : null,
      asking: !!save?.askingToSave, making: !!save?.makingDownload};
  });
}

/**
 * Starts a save as the user does: the Save button, then the name prompt, given a name.
 * @param {string} name - The file's name, without '.mp4'.
 */
async function startSave(name) {
  await playerState();
  await browser.waitUntil(() => browser.execute(() => !!document.querySelector('.main_download, #download')),
      {timeout: 15000, timeoutMsg: 'the player has no Save button'});
  await browser.execute(() => {
    /** @type {HTMLElement} */ (document.querySelector('.main_download') || document.querySelector('#download')).click();
  });
  await browser.waitUntil(() => browser.execute(() => !!document.querySelector('.fs-dialog .fs-dialog-input')),
      {timeout: 15000, timeoutMsg: 'the name prompt never appeared'});
  await browser.execute((given) => {
    /** @type {HTMLInputElement} */ (document.querySelector('.fs-dialog .fs-dialog-input')).value = given;
    /** @type {HTMLElement} */ (document.querySelector('.fs-dialog-confirm')).click();
  }, name);
}

/**
 * Waits until Firefox has written a save whole (its size, no '.part' beside it), and returns
 * its path.
 * @param {string} name - As given to startSave.
 * @param {string} what - For the timeout's message.
 * @return {Promise<string>}
 */
async function savedFile(name, what) {
  const file = path.join(DOWNLOADS, name + '.mp4');
  const size = fs.statSync(FILM).size;
  let state = null;
  try {
    await browser.waitUntil(async () => {
      state = await saveState();
      return fs.existsSync(file) && !fs.existsSync(file + '.part') && fs.statSync(file).size === size;
    }, {timeout: 75000, interval: 500});
  } catch (e) {
    const there = fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : [];
    throw new Error(`${what}; the save: ${JSON.stringify(state)}, the downloads: ${JSON.stringify(there)}, ` +
      `the server saw: ${JSON.stringify(seen.slice(-12))}`);
  }
  return file;
}

describe('A video only its page can load', function() {
  before(async function() {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
      }
      if (url.pathname === '/outer') {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        res.end(`<!doctype html><title>outer</title><body style="margin:0">
          <iframe src="${SITE}/sw/page?clip=mp4/clip-2" width="800" height="450" allow="autoplay; fullscreen"></iframe>`);
        return;
      }
      if (url.pathname === '/sw/page') {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        res.end(SW_PAGE);
        return;
      }
      if (url.pathname === '/sw/worker.js') {
        res.writeHead(200, {'Content-Type': 'text/javascript', 'Cache-Control': 'no-store'});
        res.end(SW_SCRIPT);
        return;
      }
      // The video's address, from anywhere but the worker: "Video not found".
      if (url.pathname.startsWith('/sw/video/')) {
        note(req, url, 404);
        res.writeHead(404, {...CORS, 'Content-Type': 'text/html; charset=utf-8'});
        res.end('<!doctype html><title>Video not found</title><h1>Video not found</h1>');
        return;
      }
      if (url.pathname === '/sw/store/long-av.mp4') {
        if (req.headers['x-worker'] !== '1') {
          note(req, url, 403);
          res.writeHead(403, CORS);
          res.end();
          return;
        }
        const start = Number(/^bytes=(\d+)-/.exec(String(req.headers.range || ''))?.[1] ?? 0);
        if (storeDelayMs && start > fs.statSync(FILM).size / 4) {
          setTimeout(() => sendFilm(req, res, url), storeDelayMs);
          return;
        }
        sendFilm(req, res, url);
        return;
      }
      if (url.pathname === '/c/page') {
        session.loads++;
        session.initial = `a${session.loads}`;
        session.current = '';
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Set-Cookie': `sess=${session.initial}; Path=/c/; SameSite=Lax`});
        res.end(`<!doctype html><title>cookie video</title><body style="margin:0;background:#000">
          <video muted preload="auto" style="width:640px;height:360px" src="/c/video.mp4${url.search}"></video>`);
        return;
      }
      if (url.pathname === '/c/video.mp4') {
        const sess = sessionOf(req);
        if (!session.current && sess === session.initial) {
          // The first answer renews the session: the cookie the page loaded with is spent.
          session.current = `b${session.loads}`;
          sendFilm(req, res, url, {'Set-Cookie': `sess=${session.current}; Path=/c/; SameSite=Lax`});
          return;
        }
        if (sess && sess === session.current) {
          sendFilm(req, res, url);
          return;
        }
        note(req, url, 403);
        res.writeHead(403, {...CORS, 'Content-Type': 'text/plain'});
        res.end('session expired');
        return;
      }
      res.writeHead(404, CORS);
      res.end();
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
    await inExtensionPage((site, done) => {
      chrome.storage.local.set({options: JSON.stringify({autoEnableURLs: [site + '/', site.replace('127.0.0.1', 'localhost') + '/']})}, () => {
        chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
          void chrome.runtime.lastError;
          setTimeout(() => done(true), 500);
        });
      });
    }, SITE);
  });

  afterEach(() => {
    logSeen();
  });

  after(async function() {
    await browser.switchFrame(null);
    // The saves (17 MB each); the folder is emptied only when the next session starts.
    for (const name of fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : []) {
      if (name.startsWith('page-fetch-')) fs.rmSync(path.join(DOWNLOADS, name), {force: true});
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('plays a video its service worker answers, and seeks far into it', async function() {
    seen = [];
    playerPage = null;
    await browser.url(`${SITE}/sw/page`);
    const ready = await waitForPlayer((s) => s.readyState >= 2 || s.failed, 'FastStream never played the worker\'s video', 45000);
    console.log('      ready:', JSON.stringify(ready));
    expect(ready.failed).toBe(false);
    // The address the page's video has, its fragment (the video's id) kept.
    expect(ready.url).toBe(`${SITE}/sw/video/play#mp4/clip-1`);

    const playing = await playPast(3, 'the worker\'s video never played 3 s');
    console.log('      playing:', JSON.stringify(playing));

    await browser.execute(() => {
      window.fastStream.currentTime = 120;
    });
    const far = await playPast(123, 'the worker\'s video did not play on after a seek to 120 s');
    console.log('      after the seek:', JSON.stringify(far));

    // What it played came through the worker: the file's start and, after the seek, its far part
    // (120 s of 160 is past three quarters of the file).
    const size = fs.statSync(FILM).size;
    const fromWorker = seen.filter((r) => r.path.startsWith('/sw/store/') && r.status === 206);
    const starts = fromWorker.map((r) => Number(/^bytes=(\d+)-/.exec(r.range)?.[1] ?? -1));
    expect(starts.some((start) => start === 0)).toBe(true);
    expect(starts.some((start) => start > size * 0.6)).toBe(true);
  });

  it('plays a video only the page\'s current cookie opens', async function() {
    seen = [];
    playerPage = null;
    await browser.url(`${SITE}/c/page`);
    const ready = await waitForPlayer((s) => s.readyState >= 2 || s.failed, 'FastStream never played the cookie site\'s video', 45000);
    console.log('      ready:', JSON.stringify(ready));
    expect(ready.failed).toBe(false);
    expect(ready.url).toBe(`${SITE}/c/video.mp4`);

    const playing = await playPast(3, 'the cookie site\'s video never played 3 s');
    console.log('      playing:', JSON.stringify(playing));
    await browser.execute(() => {
      window.fastStream.currentTime = 120;
    });
    const far = await playPast(123, 'the cookie site\'s video did not play on after a seek to 120 s');
    console.log('      after the seek:', JSON.stringify(far));

    const video = seen.filter((r) => r.path.startsWith('/c/video.mp4'));
    // A request with the spent cookie, or none, was refused: FastStream's own.
    const refused = video.filter((r) => r.status === 403);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((r) => !r.cookie.includes(`sess=${session.current}`))).toBe(true);
    // The film was loaded with the page's cookie as it is now, past the page's own <video>'s
    // requests (those ask as a video, Sec-Fetch-Dest: video).
    const size = fs.statSync(FILM).size;
    const pageFetched = video.filter((r) => r.status === 206 && r.dest !== 'video' &&
      r.cookie.includes(`sess=${session.current}`));
    expect(pageFetched.length).toBeGreaterThan(0);
    expect(pageFetched.some((r) => Number(/^bytes=(\d+)-/.exec(r.range)?.[1] ?? -1) > size * 0.6)).toBe(true);
  });

  it('plays a worker\'s video in an iframe of another site, as abyss.to\'s player is embedded', async function() {
    // The player opens in the iframe, and loads through that frame (not the top page's). Another
    // video at the first test's address, its id another fragment: it starts from its beginning,
    // not where the first test's video was left (VideoSource.identifier keeps the fragment).
    seen = [];
    playerPage = `iframe[src="${SITE}/sw/page?clip=mp4/clip-2"]`;
    await browser.url(`${SITE.replace('127.0.0.1', 'localhost')}/outer`);
    const ready = await waitForPlayer((s) => s.readyState >= 2 || s.failed, 'FastStream never played the embedded worker\'s video', 45000);
    console.log('      ready:', JSON.stringify(ready));
    expect(ready.failed).toBe(false);
    expect(ready.url).toBe(`${SITE}/sw/video/play#mp4/clip-2`);
    expect(ready.time).toBeLessThan(5);
    const playing = await playPast(3, 'the embedded worker\'s video never played 3 s');
    console.log('      playing:', JSON.stringify(playing));
    // Its file came from the worker of the iframe's page, past the page's own <video>'s request.
    const fromWorker = seen.filter((r) => r.path.startsWith('/sw/store/') && r.path.includes('clip-2') && r.status === 206);
    expect(fromWorker.length).toBeGreaterThan(1);
  });

  // Each save is of a video no test played before (another fragment, another query): a player
  // takes over what the previous player of the same video loaded, and the save then asked for
  // nothing.

  /**
   * Whether the server answered a range starting in the film's last tenth to a request that
   * passes a check.
   * @param {(r: Object) => boolean} check
   * @return {boolean}
   */
  function farEndSeen(check) {
    const size = fs.statSync(FILM).size;
    return seen.some((r) => r.status === 206 && check(r) && Number(/^bytes=(\d+)-/.exec(r.range)?.[1] ?? -1) > size * 0.9);
  }

  it('saves a video its service worker answers, byte for byte', async function() {
    // The address answers anyone but the worker "Video not found", so a whole file of the
    // film's bytes came through the page.
    seen = [];
    playerPage = null;
    await browser.url(`${SITE}/sw/page?clip=mp4/clip-3`);
    const ready = await waitForPlayer((s) => s.readyState >= 2 || s.failed, 'FastStream never played the worker\'s video', 45000);
    expect(ready.failed).toBe(false);
    const name = `page-fetch-worker-${Date.now()}`;
    await startSave(name);
    const file = await savedFile(name, 'the worker\'s video was never saved whole');
    const after = await saveState();
    console.log('      saved:', JSON.stringify(after));
    expect(after.status).not.toMatch(/fail/i);
    expect(sha256(file)).toBe(sha256(FILM));
    expect(farEndSeen((r) => r.worker === '1' && r.path.includes('clip-3'))).toBe(true);
  });

  it('saves a video only the page\'s current cookie opens, byte for byte', async function() {
    seen = [];
    playerPage = null;
    await browser.url(`${SITE}/c/page?for=save`);
    const ready = await waitForPlayer((s) => s.readyState >= 2 || s.failed, 'FastStream never played the cookie site\'s video', 45000);
    expect(ready.failed).toBe(false);
    const name = `page-fetch-cookie-${Date.now()}`;
    await startSave(name);
    const file = await savedFile(name, 'the cookie site\'s video was never saved whole');
    expect(sha256(file)).toBe(sha256(FILM));
    // Its far end came with the page's cookie as it is now (FastStream's own is spent), past
    // the page's own <video>'s requests.
    expect(farEndSeen((r) => r.path.startsWith('/c/video.mp4') && r.dest !== 'video' &&
      r.cookie.includes(`sess=${session.current}`))).toBe(true);
  });

  it('cancels a save half-way through the page, and saves whole the next time', async function() {
    seen = [];
    playerPage = null;
    // Every range past the first quarter takes 4 s: the save is still running when it is cancelled.
    storeDelayMs = 4000;
    try {
      await browser.url(`${SITE}/sw/page?clip=mp4/clip-4`);
      const ready = await waitForPlayer((s) => s.readyState >= 2 || s.failed, 'FastStream never played the worker\'s video', 45000);
      expect(ready.failed).toBe(false);
      const cancelled = `page-fetch-cancelled-${Date.now()}`;
      await startSave(cancelled);
      await browser.waitUntil(async () => (await saveState()).banner, {timeout: 15000, interval: 200, timeoutMsg: 'the save never began'});
      // Save, clicked while a save runs, cancels it.
      await browser.execute(() => {
        /** @type {HTMLElement} */ (document.querySelector('.main_download') || document.querySelector('#download')).click();
      });
      const said = new Set();
      let ended = null;
      await browser.waitUntil(async () => {
        ended = await saveState();
        if (ended.status) said.add(ended.status);
        return !ended.banner;
      }, {timeout: 20000, interval: 200, timeoutMsg: 'the cancelled save never ended'});
      await browser.pause(300);
      const last = await saveState();
      if (last.status) said.add(last.status);
      const dialog = await browser.execute(() => document.querySelector('.fs-dialog')?.textContent || '');
      console.log('      the cancel said:', JSON.stringify([...said]), 'dialog:', JSON.stringify(dialog),
          'downloads:', JSON.stringify(fs.readdirSync(DOWNLOADS)));
      // Said as cancelled, with no "failed, save what there is?" to answer.
      expect([...said].some((s) => /cancelled/i.test(s))).toBe(true);
      expect(dialog).toBe('');
      const partFile = path.join(DOWNLOADS, cancelled + '.mp4');
      expect(fs.existsSync(partFile) && fs.statSync(partFile).size === fs.statSync(FILM).size).toBe(false);

      storeDelayMs = 0;
      const again = `page-fetch-again-${Date.now()}`;
      await startSave(again);
      const file = await savedFile(again, 'the save after the cancelled one was never whole');
      expect(sha256(file)).toBe(sha256(FILM));
    } finally {
      storeDelayMs = 0;
    }
  });
});
