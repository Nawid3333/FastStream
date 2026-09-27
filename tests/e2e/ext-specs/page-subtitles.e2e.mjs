// The page's own <track> subtitles reach the in-page player.
//
// When the background detects a stream it asks content.js for the page's <track>
// elements (SCRAPE_CAPTIONS), and the player gets them with the sources. None of that
// worked:
//
// - content.js keeps its own copy of the message names, and SCRAPE_CAPTIONS was missing
//   from it, so the request matched nothing and was never answered;
// - the background stored the answer in frame.subtitles, which does not exist (a frame
//   keeps them in trackedSubtitles, behind getSubtitles()), so the first page that did
//   answer would have thrown there, before the player was even opened;
// - only kind="captions" tracks were read, while a <track> with no kind - how most pages
//   write one - is kind "subtitles".
//
// This drives the whole chain on the installed extension: a page with a <video> and
// three <track> elements, the site on the auto-enable list so the player opens by itself,
// and the tracks the player ends up with.

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;
const SITE_PORT = 41986;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

const VTT = {
  '/en.vtt': 'WEBVTT\n\n00:00:00.500 --> 00:00:04.000\nHello from the page\n',
  '/de.vtt': 'WEBVTT\n\n00:00:00.500 --> 00:00:04.000\nHallo von der Seite\n',
  '/chapters.vtt': 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nChapter one\n',
};

// A track on a slow connection: its bytes keep coming, but the whole file takes longer
// than content.js's 2 s stall limit (8 pieces, 450 ms apart: about 3.6 s). A 2 s limit on
// the whole request cut it off; the file still reached the player, because the
// background detects the .vtt request by itself, but as "slow" - its file name - without
// the page's label and language.
const SLOW_VTT = 'WEBVTT\n\n00:00:00.500 --> 00:00:04.000\nSlow but steady\n';
const SLOW_PIECES = 8;
const SLOW_PIECE_MS = 450;

let siteServer;
// Requests for the track that never answers, kept open until the server closes.
const hanging = new Set();
const trickles = new Set();

/**
 * Runs a function in a page of the extension, where chrome.* is available.
 * @param {Function} fn - Called as fn(arg, done).
 * @param {*} arg - A serialisable argument.
 * @return {Promise<*>} Whatever fn passed to done.
 */
async function inExtensionPage(fn, arg) {
  const opener = await browser.getWindowHandle();
  await browser.url(OPENER_URL);
  await browser.execute((u) => window.open(u, '_blank'), ORIGIN + '/player/index.html?t=' + Date.now());
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      if ((await browser.getUrl()).startsWith(ORIGIN + '/player/index.html')) {
        return true;
      }
    }
    return false;
  }, {timeout: 20000, timeoutMsg: 'the extension page never opened'});
  try {
    return await browser.executeAsync(fn, arg);
  } finally {
    await browser.closeWindow();
    await browser.switchToWindow(opener);
  }
}

describe('subtitles from the page\'s <track> elements', function() {
  before(async function() {
    siteServer = http.createServer((req, res) => {
      const pathname = req.url.split('?')[0];
      if (pathname === '/never.vtt') {
        // A track whose server never answers: the player must open without it.
        hanging.add(res);
        return;
      }
      if (pathname === '/slow.vtt') {
        res.writeHead(200, {'Content-Type': 'text/vtt; charset=utf-8'});
        res.flushHeaders();
        const size = Math.ceil(SLOW_VTT.length / SLOW_PIECES);
        let sent = 0;
        const timer = setInterval(() => {
          res.write(SLOW_VTT.slice(sent * size, (sent + 1) * size));
          sent++;
          if (sent === SLOW_PIECES) {
            clearInterval(timer);
            trickles.delete(timer);
            res.end();
          }
        }, SLOW_PIECE_MS);
        trickles.add(timer);
        return;
      }
      if (VTT[pathname]) {
        res.writeHead(200, {'Content-Type': 'text/vtt; charset=utf-8'});
        res.end(VTT[pathname]);
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(`<!doctype html><title>page subtitles</title>
        <video id="v" muted controls preload="auto" crossorigin="anonymous"
               style="width: 640px; height: 360px"
               src="${globalThis.__EXT_FIXTURE_MP4__}?t=${Date.now()}">
          <track src="/en.vtt" srclang="en" label="English page track">
          <track kind="captions" src="/de.vtt" srclang="de" label="Deutsch page track">
          <track kind="chapters" src="/chapters.vtt" srclang="en" label="Chapters">
          <track kind="subtitles" src="/never.vtt" srclang="fr" label="Never answers">
          <track kind="subtitles" src="/slow.vtt" srclang="es" label="Slow page track">
        </video>`);
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });

    // The site on the auto-enable list: the player opens by itself once the page's video
    // is detected, the same path a user's own list takes.
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
    hanging.forEach((res) => res.destroy());
    trickles.forEach((timer) => clearInterval(timer));
    if (siteServer) await new Promise((resolve) => siteServer.close(resolve));
  });

  it('hands the player the page\'s subtitles and captions, and not its chapters, without waiting on a track that never loads, and with one that loads slowly', async function() {
    await browser.url(`${SITE}/watch`);

    await browser.waitUntil(async () => browser.execute(() => {
      return Array.from(document.querySelectorAll('iframe')).some((f) => f.src.includes('player/index.html'));
    }), {timeout: 30000, timeoutMsg: 'the in-page player never replaced the page\'s video'});

    await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.source),
        {timeout: 30000, timeoutMsg: 'the player never got its source'});

    let tracks = [];
    try {
      await browser.waitUntil(async () => {
        tracks = await browser.execute(() => {
          return window.fastStream.interfaceController.subtitlesManager.tracks.map((track) => ({
            label: track.label,
            language: track.language,
            text: track.cues.map((cue) => cue.text),
          }));
        });
        return tracks.length >= 3;
      }, {timeout: 20000, interval: 500});
    } catch (e) {
      throw new Error('the player has these subtitle tracks: ' + JSON.stringify(tracks));
    } finally {
      console.log('      tracks:', JSON.stringify(tracks));
    }

    const byLabel = Object.fromEntries(tracks.map((track) => [track.label, track]));
    expect(Object.keys(byLabel).sort()).toEqual(['Deutsch page track', 'English page track', 'Slow page track']);
    expect(byLabel['Slow page track'].language).toBe('es');
    expect(byLabel['Slow page track'].text).toEqual(['Slow but steady']);
    expect(byLabel['English page track'].language).toBe('en');
    expect(byLabel['English page track'].text).toEqual(['Hello from the page']);
    expect(byLabel['Deutsch page track'].language).toBe('de');
    expect(byLabel['Deutsch page track'].text).toEqual(['Hallo von der Seite']);
  });
});
