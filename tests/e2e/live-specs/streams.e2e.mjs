// The playback checklist in docs/notes/playback-testing.md, automated against real streams on the internet.
//
// Every other suite plays files from this repository, served from 127.0.0.1. That cannot
// show what only a real server does: a CDN's HTTP/2, its CORS and range answers, its
// timing, a live manifest that moves. This suite puts public test streams in pages the
// way websites embed them - the site's own hls.js or dash.js, a plain <video src>, a
// player inside a cross-origin iframe, one that may go fullscreen (the player is laid over
// it) and one that may not (the player takes the whole frame over) - and checks, in the
// installed extension, that FastStream detects the stream, replaces the page's player, and
// plays it: time advances, a seek far ahead lands and plays on, and the stream's
// qualities and audio languages reach the player. It also opens a manifest URL directly,
// the declarativeNetRequest redirect path.
//
// The streams are Google's Shaka Player demo assets on storage.googleapis.com and a
// progressive MP4 on raw.githubusercontent.com: long-lived and CORS-enabled. The sites
// use the official hls.js and dash.js releases of the versions package.json pins, fetched
// from the npm registry once and cached, not FastStream's patched copies.
//
// Not part of verify or CI: a third-party outage must not hold back a release. Run it
// after a change to the player, the loaders or the vendored libraries:
//   pnpm run build:keep && pnpm run test:live

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {OPENER_URL} from '../wdio.extension.conf.mjs';
import {
  ORIGIN, STREAMS, enterPlayer, npmFile, playFor, seekAndPlay, setOptions, waitPlayable,
} from './liveSite.mjs';

const SITE_PORT = 41987;
// Two origins on one server: the player-in-an-iframe case needs the frame to be
// cross-origin to the page around it, as a video host's embed is.
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const OTHER_SITE = `http://localhost:${SITE_PORT}`;

let siteServer;
const libs = {};

/**
 * The pages of the test sites. A page names its stream by a key into STREAMS, not by URL:
 * a stream URL in a page's own query string is a case of its own for FastStream's
 * detection, which ext-specs covers.
 * @param {string} pathname - The page.
 * @param {URLSearchParams} query - Its query.
 * @return {string|null} The page's HTML, or null for no such page.
 */
function sitePage(pathname, query) {
  // Only values of this file's own reach the pages: the site server echoes nothing it is
  // sent.
  const key = Object.keys(STREAMS).find((name) => name === query.get('stream')) || '';
  const player = ['hls', 'dash'].find((name) => name === query.get('player')) || 'hls';
  const stream = STREAMS[key] || '';
  const src = JSON.stringify(stream);
  const video = '<video id="v" muted controls playsinline preload="auto" style="width: 800px; height: 450px"></video>';
  const fullVideo = '<style>body { margin: 0 }</style>' +
    '<video id="v" muted controls playsinline preload="auto" style="display: block; width: 100vw; height: 100vh"></video>';
  switch (pathname) {
    case '/hls':
      return `<!doctype html><title>HLS site</title>${query.get('full') ? fullVideo : video}
        <script src="/lib/hls.js"></script>
        <script>
          const hls = new Hls();
          hls.loadSource(${src});
          hls.attachMedia(document.getElementById('v'));
        </script>`;
    case '/dash':
      return `<!doctype html><title>DASH site</title>${query.get('full') ? fullVideo : video}
        <script src="/lib/dash.js"></script>
        <script>
          dashjs.MediaPlayer().create().initialize(document.getElementById('v'), ${src}, false);
        </script>`;
    case '/mp4':
      return `<!doctype html><title>MP4 site</title>
        <video id="v" muted controls playsinline preload="auto" style="width: 800px; height: 450px"
               src="${stream}"></video>`;
    case '/embed':
      // The player is on another origin, in an iframe, like a video host's embed. An
      // iframe that may go fullscreen gets the player laid over its video; one that may
      // not is sent to the player page as a whole.
      return `<!doctype html><title>Embedding site</title>
        <h1>An article with a video</h1>
        <iframe src="${OTHER_SITE}/${player}?stream=${key}&full=1" width="820" height="470"
                ${query.get('fullscreen') === 'no' ? '' : 'allow="autoplay; fullscreen" allowfullscreen'}></iframe>`;
  }
  return null;
}

describe('Real streams on the internet', function() {
  before(async function() {
    libs['/lib/hls.js'] = await npmFile('hls.js', 'dist/hls.min.js');
    libs['/lib/dash.js'] = await npmFile('dashjs', 'dist/modern/umd/dash.all.min.js');

    siteServer = http.createServer((req, res) => {
      const {pathname, searchParams} = new URL(req.url, SITE);
      if (libs[pathname]) {
        res.writeHead(200, {'Content-Type': 'text/javascript'});
        res.end(libs[pathname]);
        return;
      }
      const page = sitePage(pathname, searchParams);
      if (page === null) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(page);
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });

    // Both site origins on the auto-enable list: the player opens by itself once the
    // page's stream is detected, the same path a user's own list takes.
    await setOptions({autoEnableURLs: [SITE + '/', OTHER_SITE + '/']});
  });

  // browser.url() navigates the frame WebDriver is in, and a test ends inside the player.
  beforeEach(async function() {
    await browser.switchFrame(null);
  });

  after(async function() {
    await browser.switchFrame(null);
    if (siteServer) await new Promise((resolve) => siteServer.close(resolve));
  });

  it('HLS on a page with hls.js: plays, seeks, and has the stream\'s qualities and languages', async function() {
    await browser.url(`${SITE}/hls?stream=hls`);
    await enterPlayer();
    const state = await waitPlayable('HLS');
    console.log('      HLS:', JSON.stringify(state));
    expect(state.mode).toBe('accelerated_hls');
    expect(state.url).toBe(STREAMS.hls);
    expect(state.duration).toBeGreaterThan(55);
    expect(state.videoLevels.length).toBe(5);
    expect(new Set(state.audioLanguages)).toEqual(new Set(['en', 'de', 'it', 'fr', 'es']));
    await playFor(3, 'HLS');
    await seekAndPlay(40, 'HLS');
  });

  it('DASH on a page with dash.js: plays, seeks, and has the stream\'s qualities and languages', async function() {
    await browser.url(`${SITE}/dash?stream=dash`);
    await enterPlayer();
    const state = await waitPlayable('DASH');
    console.log('      DASH:', JSON.stringify(state));
    expect(state.mode).toBe('accelerated_dash');
    expect(state.url).toBe(STREAMS.dash);
    expect(state.duration).toBeGreaterThan(55);
    expect(state.videoLevels.length).toBeGreaterThan(1);
    expect(state.audioLanguages.length).toBeGreaterThan(1);
    await playFor(3, 'DASH');
    await seekAndPlay(40, 'DASH');
  });

  it('a long DASH title: a seek 10 minutes in plays', async function() {
    await browser.url(`${SITE}/dash?stream=dashLong`);
    await enterPlayer();
    const state = await waitPlayable('long DASH');
    console.log('      long DASH:', JSON.stringify(state));
    expect(state.duration).toBeGreaterThan(800);
    await seekAndPlay(600, 'long DASH');
    await seekAndPlay(30, 'long DASH, back');
  });

  it('a live DASH stream plays', async function() {
    await browser.url(`${SITE}/dash?stream=dashLive`);
    await enterPlayer();
    const state = await waitPlayable('live DASH');
    console.log('      live DASH:', JSON.stringify(state));
    expect(state.mode).toBe('accelerated_dash');
    await playFor(4, 'live DASH');
  });

  it('a progressive MP4 in a <video>: plays and seeks', async function() {
    await browser.url(`${SITE}/mp4?stream=mp4`);
    await enterPlayer();
    const state = await waitPlayable('MP4');
    console.log('      MP4:', JSON.stringify(state));
    expect(state.url).toBe(STREAMS.mp4);
    await playFor(3, 'MP4');
    await seekAndPlay(Math.floor(state.duration / 2), 'MP4');
  });

  it('HLS in a cross-origin iframe that may go fullscreen: the player is laid over the frame\'s video', async function() {
    await browser.url(`${SITE}/embed?player=hls&stream=hls`);
    await enterPlayer();
    const state = await waitPlayable('HLS in an iframe');
    console.log('      HLS in an iframe:', JSON.stringify(state));
    expect(state.mode).toBe('accelerated_hls');
    expect(state.url).toBe(STREAMS.hls);
    await playFor(3, 'HLS in an iframe');
  });

  it('DASH in a cross-origin iframe that may not go fullscreen: the player takes the frame over', async function() {
    await browser.url(`${SITE}/embed?player=dash&stream=dash&fullscreen=no`);
    // The frame itself becomes the player page.
    const frame = await browser.$('iframe');
    await browser.waitUntil(async () => {
      await browser.switchFrame(null);
      await browser.switchFrame(frame);
      return (await browser.execute(() => location.href)).startsWith(ORIGIN + '/player/index.html');
    }, {timeout: 60000, interval: 500, timeoutMsg: 'the frame was never sent to the player'});
    const state = await waitPlayable('DASH in a frame without fullscreen');
    console.log('      DASH in a frame without fullscreen:', JSON.stringify(state));
    expect(state.mode).toBe('accelerated_dash');
    expect(state.url).toBe(STREAMS.dash);
    await playFor(3, 'DASH in a frame without fullscreen');
  });

  it('a manifest URL opened directly goes to the player (playStreamURLs)', async function() {
    await browser.switchFrame(null);
    await setOptions({playStreamURLs: true});
    try {
      await browser.url(OPENER_URL);
      await browser.execute((u) => {
        window.location.href = u;
      }, STREAMS.dash);
      await browser.waitUntil(async () => (await browser.getUrl()).startsWith(ORIGIN + '/player/index.html'),
          {timeout: 20000, timeoutMsg: 'the manifest URL was not redirected to the player'});
      const state = await waitPlayable('a directly opened manifest');
      console.log('      direct:', JSON.stringify(state));
      expect(state.mode).toBe('accelerated_dash');
      expect(state.url).toBe(STREAMS.dash);
      await playFor(3, 'a directly opened manifest');
    } finally {
      await setOptions({autoEnableURLs: [SITE + '/', OTHER_SITE + '/']});
    }
  });
});
