// A reload of the page keeps what the player had buffered (BufferStash; his wish, 2026-10-28):
// the player going away hands its downloads to the background, and the next player of the
// same video on the same page takes them back - from RAM, and from the disk (OPFS). What
// nobody takes back within 20 s is let go of, its files deleted.
//
// The site signs its link anew at every load of its page, as vidmoly does (?sig=s<n>, n
// counting the page's loads), and its segments carry the signature: the same file under the
// new link has another address, and is found all the same (DownloadManager.adopt).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';
import {loopedPlaylist} from '../loopedPlaylist.mjs';

const PORT = 41875;
const SITE = `http://127.0.0.1:${PORT}`;
const SEGMENTS = path.resolve(import.meta.dirname, '../fixtures/hls-ts');
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

/**
 * The page's player's state, in its frame; player false while the page has none.
 * @return {Promise<Object>}
 */
async function playerState() {
  if (!await intoPlayer()) {
    return {player: false};
  }
  const state = await browser.execute(() => {
    const client = window.fastStream;
    const video = client?.player?.getVideo?.();
    return {player: true, url: client?.source?.url || '', time: client?.currentTime || 0,
      readyState: video?.readyState || 0, failed: !!client?.interfaceController?.failed,
      tookBack: client?.bufferTakenBack || null};
  });
  await browser.switchFrame(null);
  return state;
}

/**
 * The OPFS session directories the player's frame sees (its storage, partitioned or not).
 * @return {Promise<string[]>}
 */
async function sessions() {
  if (!await intoPlayer()) {
    return [];
  }
  const names = await browser.execute(async () => {
    try {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('fsblob');
      const found = [];
      for await (const name of root.keys()) found.push(name);
      return found;
    } catch (e) {
      return [];
    }
  });
  await browser.switchFrame(null);
  return names;
}

/**
 * The files in one session directory, from the player's frame.
 * @param {string} session
 * @return {Promise<string[]>}
 */
async function sessionFiles(session) {
  if (!await intoPlayer()) {
    return [];
  }
  const names = await browser.execute(async (session) => {
    try {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('fsblob');
      const dir = await root.getDirectoryHandle(session);
      const found = [];
      for await (const name of dir.keys()) found.push(name);
      return found;
    } catch (e) {
      return [];
    }
  }, session);
  await browser.switchFrame(null);
  return names.filter((name) => name !== '_meta.json');
}

/**
 * The session directories, read from an extension page: with no player in the tab.
 * @return {Promise<string[]>}
 */
const sessionsFromExtension = () => inExtensionPage(async (arg, done) => {
  try {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('fsblob');
    const found = [];
    for await (const name of root.keys()) found.push(name);
    done(found);
  } catch (e) {
    done([]);
  }
}, null);

/**
 * Waits until the reloaded player took back all it was handed (what it moves from the disk comes
 * a moment later), and then plays 4 s of it: from what it took back, read where it keeps it
 * now. What it asked for meanwhile under the new link is what it did not have.
 * @return {Promise<{taken: number, of: number}>}
 */
async function tookBackAll() {
  let tookBack = null;
  try {
    await browser.waitUntil(async () => {
      tookBack = (await playerState()).tookBack;
      return !!tookBack && tookBack.taken === tookBack.of;
    }, {timeout: 15000, interval: 300});
  } catch (e) {
    throw new Error(`the player did not take back all it was handed: ${JSON.stringify(tookBack)}`);
  }
  await intoPlayer();
  await browser.execute(() => window.fastStream.play());
  await browser.switchFrame(null);
  let state = null;
  try {
    await browser.waitUntil(async () => (state = await playerState()).time >= 4, {timeout: 30000, interval: 500});
  } catch (e) {
    throw new Error(`the player did not play what it took back: ${JSON.stringify(state)}`);
  }
  return tookBack;
}

/**
 * Waits until the page's player plays the link signed sig.
 * @param {string} sig
 * @param {string} what - For the failure.
 * @return {Promise<void>}
 */
async function playsLink(sig, what) {
  let state = null;
  try {
    await browser.waitUntil(async () => {
      state = await playerState();
      return state.player && state.readyState >= 2 && state.url.includes(`sig=${sig}&`);
    }, {timeout: 30000, interval: 500});
  } catch (e) {
    throw new Error(`${what}: ${JSON.stringify(state)}; segments for ${sig}: ${placesFor(sig).size}, all: ${JSON.stringify(segments.slice(-5))}`);
  }
}

/**
 * Reloads the page as F5 does (WebDriver's refresh did not reload it here).
 * @return {Promise<void>}
 */
async function reloadPage() {
  const before = pages;
  await browser.switchFrame(null);
  await browser.execute(() => location.reload());
  await browser.waitUntil(async () => pages > before, {timeout: 10000, timeoutMsg: 'the page never loaded again'});
}

/**
 * The newest of the session directories: the player's that played last (fsblob-<time>-<n>). The
 * earlier tests' players' are there too, until the prune 60 s past their last heartbeat.
 * @param {string[]} names
 * @return {string}
 */
const newest = (names) => names.reduce((a, b) => (Number(b.split('-')[1]) > Number(a.split('-')[1]) ? b : a));

/**
 * The segments the server sent for a signature.
 * @param {string} sig
 * @return {Set<string>} Their places.
 */
const placesFor = (sig) => new Set(segments.filter((s) => s.sig === sig).map((s) => s.place));

/**
 * Loads the page, and waits until its player plays and has downloaded `ahead` segments.
 * @param {string} page
 * @param {number} ahead
 * @return {Promise<string>} The signature this load of the page issued.
 */
async function loadAndBuffer(page, ahead) {
  await browser.url(`${SITE}${page}`);
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

describe('A reload of the page', function() {
  before(async function() {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
      }
      if (url.pathname === '/watch' || url.pathname === '/watch-disk' || url.pathname === '/watch-gone') {
        pages++;
        // Never from the cache: every load issues a new link.
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        return res.end(`<!doctype html><title>watch</title>
          <video muted style="width: 640px; height: 360px"></video>
          <script>fetch("${SITE}/v/master.m3u8?sig=s${pages}&e=43200");</script>`);
      }
      if (url.pathname === '/elsewhere') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        return res.end('<!doctype html><title>elsewhere</title><p>elsewhere');
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
  });

  after(async function() {
    await browser.switchFrame(null);
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps what was buffered in RAM: the new player asks for none of it again', async function() {
    await setOptions({autoEnableURLs: [SITE + '/']});
    segments = [];
    const first = await loadAndBuffer('/watch', 8);
    const buffered = placesFor(first);
    await reloadPage();
    const second = `s${pages}`;
    await playsLink(second, 'the reloaded page\'s player never played');
    const tookBack = await tookBackAll();
    const again = [...placesFor(second)].filter((place) => buffered.has(place));
    console.log(`      buffered ${buffered.size} before the reload; took back ${JSON.stringify(tookBack)};`,
        `asked for again after it: ${again.length} (${placesFor(second).size} under the new link)`);
    expect(tookBack.of).toBeGreaterThan(0);
    expect(again).toEqual([]);
    expect((await playerState()).failed).toBe(false);
  });

  it('keeps what was on the disk too, and deletes the old player\'s files', async function() {
    // No RAM for the buffer: all but the next seconds goes to the disk (OPFS). With 2 MB it all
    // stayed in RAM until the reload, and this tested RAM again (glm's review, 2026-10-28).
    await setOptions({autoEnableURLs: [SITE + '/'], ramBudget: 0, bufferToDisk: true});
    segments = [];
    const first = await loadAndBuffer('/watch-disk', 12);
    const oldSessions = await sessions();
    // On the disk indeed: files in the player's session.
    let onDisk = [];
    await browser.waitUntil(async () => (onDisk = await sessionFiles(newest(oldSessions))).length >= 5,
        {timeout: 30000, timeoutMsg: 'the player wrote no files to the disk'});
    const buffered = placesFor(first);
    await reloadPage();
    const second = `s${pages}`;
    await playsLink(second, 'the reloaded page\'s player never played');
    const tookBack = await tookBackAll();
    const again = [...placesFor(second)].filter((place) => buffered.has(place));
    const nowSessions = await sessions();
    console.log(`      ${onDisk.length} files on the disk; took back ${JSON.stringify(tookBack)}`);
    expect((await playerState()).failed).toBe(false);
    console.log(`      buffered ${buffered.size} (disk sessions ${JSON.stringify(oldSessions)}); asked for again: ${again.length};`,
        `sessions now ${JSON.stringify(nowSessions)}`);
    expect(oldSessions.length).toBeGreaterThan(0);
    expect(again).toEqual([]);
    // The old player's directory went once its files were moved into the new player's.
    expect(nowSessions).not.toContain(newest(oldSessions));
  });

  it('lets go of what nobody takes back within 20 s, files and all', async function() {
    await setOptions({autoEnableURLs: [SITE + '/'], ramBudget: 2e6, bufferToDisk: true});
    segments = [];
    const first = await loadAndBuffer('/watch-gone', 12);
    const buffered = placesFor(first);
    const oldSessions = await sessions();
    expect(oldSessions.length).toBeGreaterThan(0);
    const handedOver = newest(oldSessions);
    await browser.url(`${SITE}/elsewhere`);
    const left = Date.now();
    // Kept for now: the next player could still take it back.
    await browser.pause(5000);
    expect(await sessionsFromExtension()).toContain(handedOver);
    await browser.pause(Math.max(0, 22000 - (Date.now() - left)));
    // Flushed: its files deleted, by nobody but the stash (the 60 s prune is far off).
    expect(await sessionsFromExtension()).not.toContain(handedOver);
    await browser.url(`${SITE}/watch-gone`);
    const second = `s${pages}`;
    await playsLink(second, 'the page\'s player never played');
    await browser.pause(3000);
    const again = [...placesFor(second)].filter((place) => buffered.has(place));
    const nowSessions = await sessions();
    console.log(`      buffered ${buffered.size}; 22 s later asked for again: ${again.length};`,
        `old sessions ${JSON.stringify(oldSessions)}, now ${JSON.stringify(nowSessions)}`);
    expect(again.length).toBeGreaterThan(0);
    // Its directory deleted with it.
    expect(nowSessions).not.toContain(newest(oldSessions));
  });
});
