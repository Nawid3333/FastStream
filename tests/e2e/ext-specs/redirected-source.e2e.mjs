// A stream the page asks for through a redirect is the one at the end of it (upstream #585,
// asked on #592).
//
// A hoster's link (…/clip.mp4) answers with a redirect to its CDN, whose address names no
// type. FastStream took the redirect's own response for the stream, by the .mp4 in the link:
// - the player opened on the link, and the CDN, which wants the page's Referer, refused the
//   player's request at the end of the redirect: the Referer was set for the link's address.
// - a CDN slower than the player's opening delay was never seen: by its answer the frame had a
//   player, and streams found then are dropped.
// - a link that has run out, redirected to the hoster's "expired" page, opened a player on it.
// The redirect's response is no stream; the request's final one is, by its own URL or
// Content-Type, or by the type the link named.
//
// The same site checks a fetch with a header of its own, which Firefox precedes with a CORS
// preflight (OPTIONS): the stream's headers are the fetch's, not the preflight's.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';
import {loopedPlaylist} from '../loopedPlaylist.mjs';
import {byteRange, sendFile} from '../serveFile.mjs';

const PORT = 41878;
const SITE = `http://127.0.0.1:${PORT}`;
// Another origin for the preflighted fetch.
const CROSS = `http://localhost:${PORT}`;
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
const VIDEO = path.join(FIXTURES, 'sample.mp4');
const SEGMENTS = path.join(FIXTURES, 'hls-ts');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type, X-Token',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
};
// How long the slow CDN takes to answer.
const SlowCdnMs = 2500;

let server;
/** @type {Array<{method: string, path: string, status: number, referer?: string, token?: string}>} */
let requests = [];

/**
 * Sends the video, or the part of it a Range header asks for.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function sendVideo(req, res) {
  const size = fs.statSync(VIDEO).size;
  const range = byteRange(req.headers.range, size);
  if (range && range !== 'unsatisfiable') {
    res.writeHead(206, {...CORS, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': range.end - range.start + 1});
    sendFile(res, VIDEO, range);
    return;
  }
  res.writeHead(200, {...CORS, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size});
  sendFile(res, VIDEO);
}

/**
 * The page's player's state, or player false when no player replaced the page's video.
 * @return {Promise<{player: boolean, source?: string, sources?: string[], readyState?: number, failed?: boolean}>}
 */
async function playerState() {
  await browser.switchFrame(null);
  if (!(await browser.$('iframe[src*="player/index.html"]').isExisting())) {
    return {player: false};
  }
  await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
  const state = await browser.execute(() => {
    const client = window.fastStream;
    const video = client?.player?.getVideo?.();
    return {
      player: true,
      source: client?.source?.url || '',
      sources: (client?.sourcesBrowser?.sources || []).map((source) => source.url).filter(Boolean),
      readyState: video?.readyState || 0,
      failed: !!client?.interfaceController?.failed,
    };
  });
  await browser.switchFrame(null);
  return state;
}

/**
 * Opens a page and waits until its player plays.
 * @param {string} page - The page's path.
 * @return {Promise<Object>} The player's state then (playerState).
 */
async function playsOn(page) {
  requests = [];
  await browser.url(SITE + page);
  let state = null;
  try {
    await browser.waitUntil(async () => {
      state = await playerState();
      return state.player && state.readyState >= 2;
    }, {timeout: 30000, interval: 500});
  } catch (e) {
    throw new Error(`the player never played ${page}; the player: ${JSON.stringify(state)}, ` +
      `requests: ${JSON.stringify(requests)}`);
  }
  console.log('      player:', JSON.stringify(state));
  return state;
}

describe('A stream the page asks for through a redirect', function() {
  before(async function() {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      const entry = {method: req.method, path: url.pathname, status: 200,
        referer: req.headers.referer, token: req.headers['x-token']};
      requests.push(entry);
      const answer = (status, headers) => {
        entry.status = status;
        res.writeHead(status, headers);
      };
      // The preflight answered 200, as many servers do (204 is no stream already).
      if (req.method === 'OPTIONS') {
        answer(200, {...CORS, 'Content-Length': 0});
        return res.end();
      }
      const page = /^\/page\/(\w+)$/.exec(url.pathname);
      if (page) {
        answer(200, {'Content-Type': 'text/html; charset=utf-8'});
        if (page[1] === 'preflight') {
          return res.end(`<!doctype html><title>preflight</title>
            <video muted style="width: 640px; height: 360px"></video>
            <script>fetch("${CROSS}/pf/clip.m3u8", {headers: {"X-Token": "abc"}});</script>`);
        }
        return res.end(`<!doctype html><title>${page[1]}</title>
          <video muted preload="auto" style="width: 640px; height: 360px" src="/go/${page[1]}/clip.mp4"></video>`);
      }
      // The hoster's link: a redirect to its CDN, or for a link run out to its "expired" page.
      const link = /^\/go\/(\w+)\/clip\.mp4$/.exec(url.pathname);
      if (link) {
        answer(302, {...CORS, 'Location': link[1] === 'gone' ? `${SITE}/expired` : `${SITE}/cdn/${link[1]}/v7?tok=${Date.now()}`});
        return res.end();
      }
      if (url.pathname === '/expired') {
        answer(200, {'Content-Type': 'text/html; charset=utf-8'});
        return res.end('<!doctype html><title>expired</title><p>This link has expired.');
      }
      const cdn = /^\/cdn\/(\w+)\/v7$/.exec(url.pathname);
      if (cdn) {
        // Hotlink protection: the page's Referer, or nothing.
        if (cdn[1] === 'referer' && !(req.headers.referer || '').startsWith(`${SITE}/page/`)) {
          answer(403, CORS);
          return res.end();
        }
        const delay = cdn[1] === 'slow' ? SlowCdnMs : 0;
        setTimeout(() => {
          entry.status = req.headers.range ? 206 : 200;
          sendVideo(req, res);
        }, delay);
        return;
      }
      if (url.pathname === '/pf/clip.m3u8') {
        if (req.headers['x-token'] !== 'abc') {
          answer(403, CORS);
          return res.end();
        }
        answer(200, {...CORS, 'Content-Type': 'application/vnd.apple.mpegurl'});
        return res.end(loopedPlaylist(63, '/pf/seg/'));
      }
      if (url.pathname.startsWith('/pf/seg/')) {
        answer(200, {...CORS, 'Content-Type': 'video/mp2t'});
        return res.end(fs.readFileSync(path.join(SEGMENTS, path.basename(url.pathname))));
      }
      answer(404, CORS);
      res.end();
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
    await inExtensionPage((sites, done) => {
      chrome.storage.local.set({options: JSON.stringify({autoEnableURLs: sites})}, () => {
        chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
          void chrome.runtime.lastError;
          setTimeout(() => done(true), 500);
        });
      });
    }, [SITE + '/', CROSS + '/']);
  });

  after(async function() {
    await browser.switchFrame(null);
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('plays the CDN\'s address, with the page\'s Referer', async function() {
    const state = await playsOn('/page/referer');
    expect(state.source).toContain('/cdn/referer/v7?tok=');
    // One video, listed once: not the link beside the address it led to.
    expect(state.sources.filter((url) => url.includes('/go/'))).toEqual([]);
    expect(state.failed).toBe(false);
  });

  it('waits for a CDN slower than the player\'s opening', async function() {
    const state = await playsOn('/page/slow');
    expect(state.source).toContain('/cdn/slow/v7?tok=');
    expect(state.sources.filter((url) => url.includes('/go/'))).toEqual([]);
    expect(state.failed).toBe(false);
  });

  it('opens no player on a link that led to an "expired" page', async function() {
    requests = [];
    await browser.url(SITE + '/page/gone');
    // The page's video asked for its link and got the page.
    await browser.waitUntil(() => requests.some((r) => r.path === '/expired'),
        {timeout: 10000, timeoutMsg: 'the page\'s video never asked for its link'});
    // Longer than the player's opening delay and the wait for the stream's length.
    await browser.pause(6000);
    const state = await playerState();
    console.log('      player:', JSON.stringify(state), 'requests:', JSON.stringify(requests));
    expect(state.player).toBe(false);
  });

  it('takes a preflighted fetch\'s own headers', async function() {
    const state = await playsOn('/page/preflight');
    expect(state.source).toBe(`${CROSS}/pf/clip.m3u8`);
    expect(state.failed).toBe(false);
    console.log('      requests:', JSON.stringify(requests.filter((r) => r.path === '/pf/clip.m3u8')));
  });
});
