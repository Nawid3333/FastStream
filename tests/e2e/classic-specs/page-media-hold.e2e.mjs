// The page's own players under FastStream's: while FastStream's player plays, nothing else
// in the tab does. Opening the player pauses what is inside the box it takes over
// (content-cleanup covers that); a site's player outside the box, or in another frame,
// played on under FastStream's, and the user heard both - often a video started on the
// page before FastStream was turned on.
//
// The page here has all three: the video FastStream replaces, playing when it is turned
// on; another video beside it; and a sound in a frame from another site (a video there
// would get a FastStream player of its own: audio is no source). The player says
// when it plays (PLAYER_PLAYING), and the background has every frame hold its media
// (HOLD_PAGE_MEDIA) until it stops.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as url from 'node:url';

import {browser} from '@wdio/globals';

import {clickToolbar as clickToolbarIn} from '../classic-helpers.mjs';
import {hasExtensionApi} from '../extension-api.mjs';
import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../../..');
const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

const SITE_PORT = 41970;
const FRAME_PORT = 41971;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const FRAME = `http://127.0.0.1:${FRAME_PORT}`;

let siteServer;
let frameServer;
let extHandle;
let siteHandle;

const clickToolbar = () => clickToolbarIn(siteHandle);

// One second of silence, as a WAV: the frame's sound.
const SILENCE = (() => {
  const rate = 8000;
  const bytes = rate * 2; // 16-bit mono, all zero
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFFxxxxWAVEfmt ', 0, 'ascii');
  wav.writeUInt32LE(36 + bytes, 4);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28); // bytes per second
  wav.writeUInt16LE(2, 32); // bytes per sample
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(bytes, 40);
  return wav;
})();

// The video FastStream takes over, a smaller one beside it, and a frame from another site
// with a sound of its own. Muted and looping, so each plays on until something pauses it.
const holdPage = (t) => `<!doctype html><title>hold</title>
<style>body { margin: 0; } #main { width: 640px; height: 360px; display: block; }</style>
<div id="box"><video id="main" muted loop preload="auto" src="/clip.mp4?main=${t}"></video></div>
<video id="other" muted loop preload="auto" style="width: 160px; height: 90px" src="/clip.mp4?other=${t}"></video>
<iframe id="frame" src="${FRAME}/framed?t=${t}" width="320" height="180"></iframe>`;

const framedPage = (t) => `<!doctype html><title>framed</title>
<audio id="framed" muted loop preload="auto" src="/sound.wav?framed=${t}"></audio>`;

/**
 * Runs a function in the site page, or in its frame from the other site.
 * @param {Function} fn - The function.
 * @param {boolean} [framed] - In the frame.
 * @return {Promise<*>} What it returned.
 */
async function inPage(fn, framed = false) {
  await browser.switchToWindow(siteHandle);
  if (!framed) {
    return await browser.execute(fn);
  }
  await browser.switchFrame(await browser.$('#frame'));
  try {
    return await browser.execute(fn);
  } finally {
    await browser.switchFrame(null);
  }
}

/**
 * Runs a function in FastStream's player in the page.
 * @param {Function} fn - The function.
 * @return {Promise<*>} What it returned.
 */
async function inPlayer(fn) {
  await browser.switchToWindow(siteHandle);
  await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
  try {
    return await browser.execute(fn);
  } finally {
    await browser.switchFrame(null);
  }
}

/** @return {Promise<{other: boolean, framed: boolean}>} Which of the page's media play. */
async function pagePlaying() {
  return {
    other: await inPage(() => !document.getElementById('other').paused),
    framed: await inPage(() => !document.getElementById('framed').paused, true),
  };
}

/**
 * Checks which of the page's media play.
 * @param {{other: boolean, framed: boolean}} expected - Which should.
 * @param {string} when - What just happened, for the failure message.
 */
async function expectPlaying(expected, when) {
  const playing = await pagePlaying();
  if (JSON.stringify(playing) !== JSON.stringify(expected)) {
    throw new Error(`${when}: expected ${JSON.stringify(expected)}, the page has ${JSON.stringify(playing)}`);
  }
}

/** Has the page start its other video and its frame's sound, as a site's player does. */
async function pagePlays() {
  await inPage(() => document.getElementById('other').play().catch(() => {}));
  await inPage(() => document.getElementById('framed').play().catch(() => {}), true);
  await browser.pause(1500);
}

describe('the page\'s media under FastStream\'s player', function() {
  before(async function() {
    const clip = fs.readFileSync(path.join(root, 'tests/e2e/fixtures/sample.mp4'));
    const serve = (req, res) => {
      const pathname = req.url.split('?')[0];
      const t = Date.now();
      if (pathname === '/clip.mp4') {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(clip.length),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(clip);
        return;
      }
      if (pathname === '/sound.wav') {
        res.writeHead(200, {'Content-Type': 'audio/wav', 'Content-Length': String(SILENCE.length)});
        res.end(SILENCE);
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(pathname === '/framed' ? framedPage(t) : holdPage(t));
    };
    siteServer = http.createServer(serve);
    frameServer = http.createServer(serve);
    for (const [server, port] of [[siteServer, SITE_PORT], [frameServer, FRAME_PORT]]) {
      await new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    }

    await browser.url(OPENER_URL);
    await browser.execute((u) => window.open(u, '_blank'), ORIGIN + '/player/index.html');
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        if ((await browser.getUrl()).startsWith(ORIGIN) && await hasExtensionApi()) {
          extHandle = handle;
          return true;
        }
      }
      return false;
    }, {timeout: 20000, timeoutMsg: 'the extension page never opened'});
    siteHandle = (await browser.getWindowHandles()).find((h) => h !== extHandle);
  });

  after(async function() {
    if (siteServer) await new Promise((r) => siteServer.close(r));
    if (frameServer) await new Promise((r) => frameServer.close(r));
  });

  it('holds the page\'s other players while FastStream\'s plays, and lets them go when it pauses', async function() {
    await browser.switchToWindow(siteHandle);
    await browser.url(`${SITE}/hold?t=${Date.now()}`);
    await browser.waitUntil(async () => (await inPage(() => document.getElementById('main').readyState >= 2)) &&
        (await inPage(() => document.getElementById('framed').readyState >= 2, true)),
    {timeout: 20000, timeoutMsg: 'the page\'s videos never loaded'});
    // The detection is an async webRequest event on top of the load.
    await browser.pause(500);

    // Everything plays before FastStream is turned on, the replaced video too.
    await inPage(() => document.getElementById('main').play().catch(() => {}));
    await pagePlays();
    await expectPlaying({other: true, framed: true}, 'before FastStream');

    await clickToolbar();
    await browser.waitUntil(async () => inPage(() => !!document.querySelector('iframe[src*="player/index.html"]')),
        {timeout: 15000, timeoutMsg: 'the player never opened'});
    await browser.waitUntil(async () => {
      try {
        return await inPlayer(() => !!(window.fastStream && window.fastStream.source));
      } catch (e) {
        return false;
      }
    }, {timeout: 15000, interval: 250, timeoutMsg: 'the player never got a source'});

    await inPlayer(() => {
      window.fastStream.play();
    });
    await browser.waitUntil(async () => inPlayer(() => !window.fastStream.paused),
        {timeout: 10000, timeoutMsg: 'FastStream\'s player never played'});
    await browser.pause(1500);
    // Paused when FastStream's player played, and again when the page starts them.
    await expectPlaying({other: false, framed: false}, 'when FastStream\'s player played');
    await pagePlays();
    await expectPlaying({other: false, framed: false}, 'started again under it');

    await inPlayer(() => {
      window.fastStream.pause();
    });
    await browser.pause(1000);
    await pagePlays();
    await expectPlaying({other: true, framed: true}, 'once FastStream\'s player paused');
  });
});
