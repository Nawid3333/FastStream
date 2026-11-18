// A page whose own URL names a stream in its query string is not the stream.
//
// An embed page with the stream in its query (embed.php?file=...m3u8) is a page, not a stream; a
// proxy fetch of one is.
//
// A page load is told by its Content-Type: a proxy link opened in a tab is a load answered with the
// stream itself.
//
// Driven on the installed extension, the site on the auto-enable list.
//
// The sources browser's Clear also sends CLEAR_SOURCES, so the background's store is emptied too.

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';

const SITE_PORT = 41983;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

let siteServer;
// The page names the file in its query, but is built from this, never from the request.
let pageFile = null;

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
      const {pathname} = new URL(req.url, SITE);
      if (pathname === '/stream') {
        // A proxy link answers with the fixture MP4 whatever its query names; CORS with preflight
        // for the partitioned frame.
        const cors = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Range, Content-Type',
          'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
        };
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors);
          res.end();
          return;
        }
        // The player's Range goes on to the harness, and its answer comes back as it is
        // (206 and Content-Range included), as a proxy passes them.
        const forward = req.headers.range ? {headers: {range: req.headers.range}} : {};
        http.get(globalThis.__EXT_FIXTURE_MP4__, forward, (upstream) => {
          res.writeHead(upstream.statusCode, {
            ...cors,
            'Content-Type': 'video/mp4',
            'Content-Length': upstream.headers['content-length'],
            ...(upstream.headers['content-range'] ? {'Content-Range': upstream.headers['content-range']} : {}),
            'Accept-Ranges': 'bytes',
          });
          upstream.pipe(res);
        }).on('error', () => res.destroy());
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      if (pathname === '/embed') {
        // The page's own player plays the file at once.
        res.end(`<!doctype html><title>embed</title>
          <video muted preload="auto" style="width: 640px; height: 360px" src="${pageFile}"></video>`);
      } else {
        // The page's own player asks for the file only after a while, as a player that
        // loads its script first does.
        res.end(`<!doctype html><title>embed, late</title>
          <video muted preload="auto" style="width: 640px; height: 360px"></video>
          <script>
            setTimeout(() => {
              document.querySelector('video').src = ${JSON.stringify(pageFile)};
            }, 2000);
          </script>`);
      }
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });

    // the site on the auto-enable list: the player opens by itself
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
    pageFile = file;
    await browser.url(`${SITE}/embed?file=${encodeURIComponent(file)}`);
    const state = await playerSources();
    expect(state.sources.filter((url) => url.startsWith(SITE))).toEqual([]);
    expect(state.source).toBe(file);
    expect(state.readyState).toBeGreaterThanOrEqual(2);
  });

  it('still takes a page load answered with the stream itself for the stream', async function() {
    // A proxy link opened in a tab: Firefox plays the response in the page load, so the
    // page load is the only request there is to detect.
    const file = `${globalThis.__EXT_FIXTURE_MP4__}?t=${Date.now()}`;
    const link = `${SITE}/stream?file=${encodeURIComponent(file)}`;
    await browser.url(link);
    const state = await playerSources();
    expect(state.source).toBe(link);
    expect(state.readyState).toBeGreaterThanOrEqual(2);
  });

  it('forgets the page\'s sources in the background too when the player\'s list is cleared', async function() {
    const file = `${globalThis.__EXT_FIXTURE_MP4__}?t=${Date.now()}`;
    pageFile = file;
    await browser.url(`${SITE}/embed?file=${encodeURIComponent(file)}`);
    const state = await playerSources();
    expect(state.sources).toContain(file);

    await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
    try {
      const cleared = await browser.execute(() => {
        // Every list of sources the background sends this player from now on, by length.
        window.__sourcesSent = [];
        chrome.runtime.onMessage.addListener((message) => {
          if (message && message.type === 'SOURCES') window.__sourcesSent.push(message.sources.length);
        });
        document.querySelector('.linkui-clear-button').click();
        return window.fastStream.sourcesBrowser.sources.length;
      });
      expect(cleared).toBe(0);

      // Asked again until empty: the clear is a message of its own, which a request may overtake
      // once.
      let sent = [];
      await browser.waitUntil(async () => {
        sent = await browser.execute(() => new Promise((done) => {
          const before = window.__sourcesSent.length;
          chrome.runtime.sendMessage({type: 'REQUEST_SOURCES'}).catch(() => {});
          const started = Date.now();
          const poll = setInterval(() => {
            if (window.__sourcesSent.length > before || Date.now() - started > 3000) {
              clearInterval(poll);
              done(window.__sourcesSent.slice());
            }
          }, 50);
        }));
        return sent.length > 0 && sent[sent.length - 1] === 0;
      }, {timeout: 15000, interval: 500}).catch(() => {});
      console.log('      sources the background sent after the clear:', JSON.stringify(sent));
      expect(sent.length).toBeGreaterThan(0);
      expect(sent[sent.length - 1]).toBe(0);
    } finally {
      await browser.switchFrame(null);
    }
  });

  it('opens the player on the page\'s stream, not on the page, when the page asks for it late', async function() {
    const file = `${globalThis.__EXT_FIXTURE_MP4__}?t=${Date.now()}`;
    pageFile = file;
    await browser.url(`${SITE}/late?file=${encodeURIComponent(file)}`);
    const state = await playerSources();
    expect(state.source).toBe(file);
    expect(state.readyState).toBeGreaterThanOrEqual(2);
  });
});
