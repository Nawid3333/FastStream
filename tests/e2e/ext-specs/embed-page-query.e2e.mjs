// A page whose own URL names a stream in its query string is not the stream.
//
// Embed pages often carry the stream in their query string: embed.php?file=https://cdn/
// .../index.m3u8. FastStream's detection looks through the query string of any request
// whose URL has no stream extension of its own, which is right for a stream fetched through
// a proxy (proxy?url=...m3u8, answered with the manifest itself) - but it did the same for
// the page loads, so the embed page itself, HTML, went into the frame's sources as a
// stream. With the site on the auto-enable list, a player opened before the page's own
// player had asked for the real stream got only that source, and tried to play the page.
//
// Driven on the installed extension: a page with the fixture MP4 in its query string and a
// <video> that plays it, the site on the auto-enable list, and the sources the player ends
// up with.

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;
const SITE_PORT = 41983;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

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

/**
 * Waits for FastStream's player to replace the page's video, switches into it, and reads
 * the source it plays, its list of sources and how far the video got.
 * @return {Promise<Object>} What the player has.
 */
async function playerSources() {
  await browser.waitUntil(async () => browser.execute(() => {
    return Array.from(document.querySelectorAll('iframe')).some((f) => f.src.includes('player/index.html'));
  }), {timeout: 30000, timeoutMsg: 'the in-page player never replaced the page\'s video'});
  await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.source),
      {timeout: 30000, timeoutMsg: 'the player never got a source'});
  // A player on the right source decodes it; give it the time to.
  let state;
  await browser.waitUntil(async () => {
    state = await browser.execute(() => {
      const client = window.fastStream;
      const video = client.player?.getVideo?.();
      return {
        source: client.source.url,
        sources: client.sourcesBrowser.sources.map((source) => source.url).filter(Boolean),
        readyState: video ? video.readyState : null,
      };
    });
    return state.readyState >= 2;
  }, {timeout: 20000, interval: 250}).catch(() => {});
  await browser.switchFrame(null);
  console.log('      player:', JSON.stringify(state));
  return state;
}

describe('A stream named in the page\'s own query string', function() {
  before(async function() {
    siteServer = http.createServer((req, res) => {
      const {pathname, searchParams} = new URL(req.url, SITE);
      const file = searchParams.get('file');
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      if (pathname === '/embed') {
        // The page's own player plays the file at once.
        res.end(`<!doctype html><title>embed</title>
          <video muted preload="auto" style="width: 640px; height: 360px" src="${file}"></video>`);
      } else {
        // The page's own player asks for the file only after a while, as a player that
        // loads its script first does.
        res.end(`<!doctype html><title>embed, late</title>
          <video muted preload="auto" style="width: 640px; height: 360px"></video>
          <script>
            setTimeout(() => {
              document.querySelector('video').src = ${JSON.stringify(file)};
            }, 2000);
          </script>`);
      }
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });

    // The site on the auto-enable list: the player opens by itself once a source is
    // detected, the same path a user's own list takes.
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

  it('keeps the page out of the player\'s sources', async function() {
    const file = `${globalThis.__EXT_FIXTURE_MP4__}?t=${Date.now()}`;
    await browser.url(`${SITE}/embed?file=${encodeURIComponent(file)}`);
    const state = await playerSources();
    expect(state.sources.filter((url) => url.startsWith(SITE))).toEqual([]);
    expect(state.source).toBe(file);
    expect(state.readyState).toBeGreaterThanOrEqual(2);
  });

  it('opens the player on the page\'s stream, not on the page, when the page asks for it late', async function() {
    const file = `${globalThis.__EXT_FIXTURE_MP4__}?t=${Date.now()}`;
    await browser.url(`${SITE}/late?file=${encodeURIComponent(file)}`);
    const state = await playerSources();
    expect(state.source).toBe(file);
    expect(state.readyState).toBeGreaterThanOrEqual(2);
  });
});
