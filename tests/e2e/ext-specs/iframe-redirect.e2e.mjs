// A video that fills an iframe which cannot go fullscreen: the player takes the frame over.
//
// When the video fills its frame and the frame may not go fullscreen (an <iframe> without
// allowfullscreen), content.js does not overlay the player: it sends the whole frame to the
// player page. The player then asks the background for the sources detected in that frame
// (REQUEST_SOURCES). But navigating away fired the page's beforeunload, and content.js
// reported the frame as removed (FRAME_REMOVED), which made the background forget the
// frame and its sources first. The player opened with nothing to play and stayed on
// "Welcome to FastStream" - on every such embed.
//
// Driven on the installed extension: an article page with a cross-origin iframe, no
// allowfullscreen, whose <video> fills it; the site on the auto-enable list.

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;
const SITE_PORT = 41981;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
// Another origin for the frame, as a video host's embed is.
const EMBED = `http://localhost:${SITE_PORT}`;

let siteServer;

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
  let handle;
  await browser.waitUntil(async () => {
    for (const h of await browser.getWindowHandles()) {
      await browser.switchToWindow(h);
      if ((await browser.getUrl()).startsWith(ORIGIN + '/player/index.html')) {
        handle = h;
        return true;
      }
    }
    return false;
  }, {timeout: 20000, timeoutMsg: 'the extension page never opened'});
  try {
    return await browser.executeAsync(fn, arg);
  } finally {
    await browser.switchToWindow(handle);
    await browser.closeWindow();
    await browser.switchToWindow(opener);
  }
}

describe('A video that fills an iframe without allowfullscreen', function() {
  before(async function() {
    siteServer = http.createServer((req, res) => {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      if (req.url.startsWith('/embed')) {
        res.end(`<!doctype html><title>embed</title>
          <body style="margin: 0">
            <video muted preload="auto" style="display: block; width: 100vw; height: 100vh"
                   src="${globalThis.__EXT_FIXTURE_MP4__}?t=${Date.now()}"></video>
          </body>`);
        return;
      }
      res.end(`<!doctype html><title>article</title>
        <h1>An article with a video</h1>
        <iframe src="${EMBED}/embed" style="width: 800px; height: 450px; border: 0"></iframe>`);
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });

    // The site on the auto-enable list: the player opens by itself once the frame's video
    // is detected.
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
    if (siteServer) await new Promise((resolve) => siteServer.close(resolve));
  });

  it('plays the frame\'s video in the player that takes the frame over', async function() {
    await browser.url(`${SITE}/article`);
    const frame = await browser.$('iframe');

    // The frame is sent to the player page.
    let href;
    await browser.waitUntil(async () => {
      await browser.switchFrame(null);
      await browser.switchFrame(frame);
      href = await browser.execute(() => location.href);
      return href.startsWith(ORIGIN + '/player/index.html');
    }, {timeout: 30000, interval: 250, timeoutMsg: 'the frame was never sent to the player'});

    let state;
    try {
      await browser.waitUntil(async () => {
        state = await browser.execute(() => {
          const client = window.fastStream;
          const video = client?.player?.getVideo?.();
          return {
            source: client?.source?.url || null,
            readyState: video ? video.readyState : null,
            status: Array.from(document.querySelectorAll('.mainplayer .status_message'))
                .map((element) => element.textContent.trim()).filter(Boolean),
          };
        });
        return state.readyState >= 2;
      }, {timeout: 20000, interval: 250});
    } catch (e) {
      throw new Error('the player never played the frame\'s video: ' + JSON.stringify(state));
    } finally {
      await browser.switchFrame(null);
      console.log('      player:', JSON.stringify(state));
    }
    expect(state.source.startsWith(globalThis.__EXT_FIXTURE_MP4__)).toBe(true);
  });
});
