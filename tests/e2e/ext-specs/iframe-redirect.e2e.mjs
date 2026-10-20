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

import {EXTENSION_UUID} from '../wdio.extension.conf.mjs';
import {inExtensionPage} from '../extension-page.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;
const SITE_PORT = 41981;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
// Another origin for the frame, as a video host's embed is.
const EMBED = `http://localhost:${SITE_PORT}`;

let siteServer;

/**
 * What the frame shows, for a failure: its address, whether it may go fullscreen, and its
 * videos with their boxes and what an IntersectionObserver reports of the first (what
 * content.js's getVideo waits for), or that it reported nothing in 2 s.
 * @param {WebdriverIO.Element} frame
 * @param {string} href - The frame's address as last read.
 * @return {Promise<Object>}
 */
async function frameState(frame, href) {
  try {
    await browser.switchFrame(null);
    await browser.switchFrame(frame);
    return await browser.execute(() => new Promise((done) => {
      const videos = Array.from(document.querySelectorAll('video'));
      const state = {
        href: location.href,
        visibility: document.visibilityState,
        fullscreenEnabled: document.fullscreenEnabled,
        videos: videos.map((video) => {
          const box = video.getBoundingClientRect();
          return {box: [box.x, box.y, box.width, box.height].map(Math.round), readyState: video.readyState};
        }),
      };
      if (!videos.length) {
        done(state);
        return;
      }
      const timer = setTimeout(() => done({...state, intersection: 'no report in 2 s'}), 2000);
      const observer = new IntersectionObserver(([entry]) => {
        clearTimeout(timer);
        observer.disconnect();
        done({...state, intersection: entry.intersectionRatio});
      });
      observer.observe(videos[0]);
    }));
  } catch (e) {
    return {href, unreadable: e.message};
  } finally {
    await browser.switchFrame(null).catch(() => {});
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
    try {
      await browser.waitUntil(async () => {
        await browser.switchFrame(null);
        await browser.switchFrame(frame);
        href = await browser.execute(() => location.href);
        return href.startsWith(ORIGIN + '/player/index.html');
      }, {timeout: 30000, interval: 250});
    } catch (e) {
      // Once on the Windows runner (CI run 39081539517) the background found the frame's
      // video and sent OPEN_PLAYER ("Opening player" in the driver log), and nothing came of
      // it, with no word of why. content.js answers with no player when it sees no video
      // (getVideo: by an IntersectionObserver's first report), and redirects only a video
      // that fills its frame: what the frame showed then.
      throw new Error(`the frame was never sent to the player: ${JSON.stringify(await frameState(frame, href))}`);
    }

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
