// A file is what its bytes are, not what its server calls it.
//
// A hoster served a Matroska file as video/mp4, from a URL ending in .mp4. The page's own
// <video> played it: Firefox's player reads a file by its bytes. FastStream took it for an
// MP4 by its type, its MP4 player's mp4box stopped at the first bytes ("Invalid data found
// while parsing box of type '£B'"), and the player failed where the page's had played. The
// MP4 player now hands a file that is no MP4 to Firefox's own player (playDirectly).
//
// That server answered a request without the page's Referer with a redirect to a decoy.
// Firefox's own player in FastStream got the page's headers from a rule the background set
// for 5 s, and asks for ranges whenever it needs them: the first request after those 5 s
// (a Matroska file's index at its end, a seek) went to the decoy, and the source was
// reloaded. Its rule now lives 30 s and is renewed while it has the source.
//
// Driven on the installed extension, the site on the auto-enable list: the page plays the
// film, the player takes it over, plays it, and plays on after a seek far ahead, 12 s in.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';
import {byteRange} from '../serveFile.mjs';

const SITE_PORT = 41966;
const DECOY_PORT = 41967;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
// About 400 KB/s, four times the film's rate: a seek far ahead needs a request of its own.
const BYTES_PER_TICK = 40 * 1024;

let siteServer;
let decoyServer;
let workDir;
let film;
/** @type {Array<{at: number, range: string, referer: string}>} */
const filmRequests = [];
let decoyRequests = 0;

describe('A Matroska file its server calls an MP4', function() {
  before(async function() {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faststream-mislabelled-'));
    const file = path.join(workDir, 'film.mkv');
    // long-av.mp4's 160 s, as Matroska.
    const {status, stderr} = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(FIXTURES, 'long-av.mp4'),
      '-c', 'copy', '-f', 'matroska', file], {encoding: 'utf8'});
    if (status !== 0) {
      throw new Error(`could not remux the film fixture with ffmpeg: ${stderr}`);
    }
    film = fs.readFileSync(file);

    siteServer = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      if (url.pathname === '/watch') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<!doctype html><body style="margin:0"><video muted autoplay controls width="640" height="360" src="/media/film.mp4"></video></body>');
        return;
      }
      if (url.pathname !== '/media/film.mp4') {
        res.writeHead(404);
        res.end();
        return;
      }
      const referer = req.headers.referer || '';
      filmRequests.push({at: Date.now(), range: req.headers.range || '-', referer});
      if (!referer.startsWith(SITE + '/')) {
        res.writeHead(302, {Location: `http://127.0.0.1:${DECOY_PORT}/decoy.mp4`});
        res.end();
        return;
      }
      const range = byteRange(req.headers.range, film.length);
      if (range === 'unsatisfiable') {
        res.writeHead(416, {'Content-Range': `bytes */${film.length}`});
        res.end();
        return;
      }
      const head = {'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes'};
      let start = 0;
      let end = film.length - 1;
      if (range) {
        ({start, end} = range);
        res.writeHead(206, {...head, 'Content-Range': `bytes ${start}-${end}/${film.length}`, 'Content-Length': end - start + 1});
      } else {
        res.writeHead(200, {...head, 'Content-Length': film.length});
      }
      let at = start;
      const timer = setInterval(() => {
        if (at > end) {
          clearInterval(timer);
          res.end();
          return;
        }
        const next = Math.min(end + 1, at + BYTES_PER_TICK);
        res.write(film.subarray(at, next));
        at = next;
      }, 100);
      res.on('close', () => clearInterval(timer));
    });
    decoyServer = http.createServer((req, res) => {
      decoyRequests++;
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => siteServer.listen(SITE_PORT, '127.0.0.1', resolve));
    await new Promise((resolve) => decoyServer.listen(DECOY_PORT, '127.0.0.1', resolve));

    await inExtensionPage((site, done) => {
      chrome.storage.local.set({options: JSON.stringify({autoEnableURLs: [site + '/']})}, () => {
        chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
          void chrome.runtime.lastError;
          setTimeout(() => done(true), 500);
        });
      });
    }, SITE);
  });

  after(async function() {
    await browser.switchFrame(null);
    for (const server of [siteServer, decoyServer]) {
      if (!server) continue;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (workDir) fs.rmSync(workDir, {recursive: true, force: true});
  });

  it('plays it in Firefox\'s own player, with the page\'s Referer after a seek 12 s in', async function() {
    await browser.url(`${SITE}/watch`);
    await browser.waitUntil(async () => browser.execute(() => {
      return Array.from(document.querySelectorAll('iframe')).some((f) => f.src.includes('player/index.html'));
    }), {timeout: 30000, timeoutMsg: 'the in-page player never replaced the page\'s video'});
    const opened = Date.now();
    await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
    const state = () => browser.execute(() => {
      const client = window.fastStream;
      const video = client?.player?.getVideo?.();
      return {
        mode: client?.source?.mode,
        readyState: video ? video.readyState : null,
        time: video ? video.currentTime : null,
        failed: !!client?.interfaceController?.failed,
      };
    });
    try {
      let playing;
      await browser.waitUntil(async () => {
        playing = await state();
        if (playing.failed) return true;
        if (playing.readyState >= 2) return true;
        await browser.execute(() => {
          window.fastStream?.player?.getVideo?.()?.play().catch(() => {});
          return true;
        });
        return false;
      }, {timeout: 30000, interval: 500, timeoutMsg: 'the player never played the film'});
      console.log('      playing:', JSON.stringify(playing));
      expect(playing.failed).toBe(false);
      expect(playing.mode).toBe('direct');

      // Well past a request's 5 s rule, far past what is buffered.
      await browser.pause(Math.max(0, 12000 - (Date.now() - opened)));
      await browser.execute(() => {
        window.fastStream.player.getVideo().currentTime = 130;
        return true;
      });
      let after;
      await browser.waitUntil(async () => {
        after = await state();
        return after.failed || (after.time > 131 && after.readyState >= 3);
      }, {timeout: 30000, interval: 500, timeoutMsg: 'the player did not play on after the seek'}).catch(() => {});
      console.log('      after the seek:', JSON.stringify(after));
      expect(after.failed).toBe(false);
      expect(after.time).toBeGreaterThan(131);
    } finally {
      await browser.switchFrame(null);
      for (const r of filmRequests) {
        // The range JSON-quoted: a request's header cannot forge log lines (CodeQL js/log-injection).
        console.log(`      request +${r.at - opened} ms ${JSON.stringify(r.range)} referer ${r.referer ? 'page' : 'none'}`);
      }
    }
    // Every one of the film's requests had the page's Referer: none went to the decoy.
    expect(filmRequests.filter((r) => !r.referer)).toEqual([]);
    expect(decoyRequests).toBe(0);
  });
});
