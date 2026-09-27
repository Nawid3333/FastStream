// The playback checklist in CLAUDE.md, automated against real streams on the internet.
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

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as url from 'node:url';
import zlib from 'node:zlib';

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../../..');

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;
const SITE_PORT = 41987;
// Two origins on one server: the player-in-an-iframe case needs the frame to be
// cross-origin to the page around it, as a video host's embed is.
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const OTHER_SITE = `http://localhost:${SITE_PORT}`;

const SHAKA = 'https://storage.googleapis.com/shaka-demo-assets';
const STREAMS = {
  // 60 s, 5 H.264 levels, 6 audio renditions in 5 languages, 4 WebVTT subtitle renditions.
  hls: `${SHAKA}/angel-one-hls/hls.m3u8`,
  // The same title as DASH (SegmentBase, on-demand profile).
  dash: `${SHAKA}/angel-one/dash.mpd`,
  // 888 s, for a seek far into a long title.
  dashLong: `${SHAKA}/sintel/dash.mpd`,
  // A live stream: type="dynamic", a SegmentTimeline that grows every 4 s.
  dashLive: 'https://storage.googleapis.com/shaka-live-assets/player-source.mpd',
  // Progressive MP4 served as application/octet-stream, as file hosts often do.
  mp4: 'https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/big_buck_bunny.mp4',
};

let siteServer;
const libs = {};

/**
 * Returns one file of an npm package, downloading the package from the registry the first
 * time and caching it under the OS temp directory.
 * @param {string} pkg - The package name.
 * @param {string} file - The file's path inside the package.
 * @return {Promise<Buffer>} The file.
 */
async function npmFile(pkg, file) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = String(pkgJson.devDependencies[pkg]).replace(/^[\^~]/, '');
  const cached = path.join(os.tmpdir(), 'faststream-live-libs', `${pkg}@${version}`, file);
  if (fs.existsSync(cached)) {
    return fs.readFileSync(cached);
  }

  const res = await fetch(`https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`);
  if (!res.ok) {
    throw new Error(`could not download ${pkg}@${version}: HTTP ${res.status}`);
  }
  const tar = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
  const field = (start, length) => tar.toString('utf8', start, start + length).replace(/\0[\s\S]*$/, '');
  // A tar archive is a run of 512-byte headers, each followed by its file padded to 512.
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = field(offset, 100);
    if (!name) {
      break;
    }
    const size = parseInt(field(offset + 124, 12).trim() || '0', 8);
    const prefix = field(offset + 345, 155);
    if ((prefix ? prefix + '/' : '') + name === 'package/' + file) {
      const data = tar.subarray(offset + 512, offset + 512 + size);
      fs.mkdirSync(path.dirname(cached), {recursive: true});
      fs.writeFileSync(cached, data);
      return data;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${pkg}@${version} has no ${file}`);
}

/**
 * The pages of the test sites. A page names its stream by a key into STREAMS, not by URL:
 * a stream URL in a page's own query string is a case of its own for FastStream's
 * detection, which ext-specs covers.
 * @param {string} pathname - The page.
 * @param {URLSearchParams} query - Its query.
 * @return {string|null} The page's HTML, or null for no such page.
 */
function sitePage(pathname, query) {
  const stream = STREAMS[query.get('stream')];
  const src = JSON.stringify(stream || '');
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
        <iframe src="${OTHER_SITE}/${query.get('player')}?stream=${query.get('stream')}&full=1" width="820" height="470"
                ${query.get('fullscreen') === 'no' ? '' : 'allow="autoplay; fullscreen" allowfullscreen'}></iframe>`;
  }
  return null;
}

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
 * Saves options the way the options page does, and has the background reload them.
 * @param {Object} options - The options to save; everything else takes its default.
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

/**
 * Waits for FastStream's player to replace the page's video, then switches into it,
 * through the site's own iframe when the video is in one.
 * @param {number} timeout - How long to wait, in ms.
 */
async function enterPlayer(timeout = 60000) {
  const selector = 'iframe[src*="player/index.html"]';
  await browser.switchFrame(null);
  let nested = false;
  await browser.waitUntil(async () => {
    await browser.switchFrame(null);
    if (await browser.$(selector).isExisting()) {
      nested = false;
      return true;
    }
    for (const frame of await browser.$$('iframe')) {
      await browser.switchFrame(null);
      await browser.switchFrame(frame);
      if (await browser.$(selector).isExisting()) {
        nested = true;
        return true;
      }
    }
    return false;
  }, {timeout, interval: 500, timeoutMsg: 'FastStream never replaced the page\'s player'});
  if (!nested) {
    await browser.switchFrame(null);
  }
  await browser.switchFrame(await browser.$(selector));
}

/**
 * Reads the player's state.
 * @return {Promise<Object>} The state.
 */
const playerState = () => browser.execute(() => {
  const client = window.fastStream;
  const video = client?.player?.getVideo?.();
  // What the player was given and what it shows, for a failure message.
  const context = {
    sources: (client?.sourcesBrowser?.sources || []).filter((source) => source.url)
        .map((source) => `${source.mode} ${source.url}`),
    status: Array.from(document.querySelectorAll('.mainplayer .status_message'))
        .map((element) => element.textContent.trim()).filter(Boolean),
  };
  if (!video) {
    return {loaded: false, source: client?.source ? `${client.source.mode} ${client.source.url}` : null, ...context};
  }
  const ranges = [];
  for (let i = 0; i < video.buffered.length; i++) {
    ranges.push([+video.buffered.start(i).toFixed(2), +video.buffered.end(i).toFixed(2)]);
  }
  return {
    loaded: true,
    mode: client.source?.mode,
    url: client.source?.url,
    time: client.currentTime,
    duration: client.duration,
    paused: video.paused,
    seeking: video.seeking,
    readyState: video.readyState,
    width: video.videoWidth,
    ranges,
    videoLevels: Array.from(client.getVideoLevels().values()).map((level) => `${level.width}x${level.height}`),
    audioLanguages: Array.from(client.getAudioLevels().values()).map((level) => level.language),
    error: video.error ? video.error.message || String(video.error.code) : null,
    ...context,
  };
});

/**
 * Waits until the player has data to play at its position, and returns its state.
 * @param {string} what - For the error message.
 * @return {Promise<Object>} The state.
 */
async function waitPlayable(what) {
  let last;
  try {
    await browser.waitUntil(async () => {
      last = await playerState();
      return last.loaded && !last.seeking && last.readyState >= 3 && last.width > 0;
    }, {timeout: 60000, interval: 500});
  } catch (e) {
    throw new Error(`${what} never became playable: ${JSON.stringify(last)}`);
  }
  return last;
}

/**
 * Plays until the position has advanced by `seconds`, and pauses.
 * @param {number} seconds - How far.
 * @param {string} what - For the error message.
 * @return {Promise<Object>} The state at the end.
 */
async function playFor(seconds, what) {
  const start = (await playerState()).time;
  await browser.execute(() => {
    window.fastStream.play().catch((e) => {
      window.__playError = String(e);
    });
  });
  let last;
  try {
    await browser.waitUntil(async () => {
      last = await playerState();
      return last.time >= start + seconds;
    }, {timeout: 30000 + seconds * 3000, interval: 500});
  } catch (e) {
    const playError = await browser.execute(() => window.__playError || null);
    throw new Error(`${what}: playback did not advance ${seconds} s from ${start}: ` +
      JSON.stringify({...last, playError}));
  } finally {
    await browser.execute(() => {
      window.fastStream.pause();
    });
  }
  return last;
}

/**
 * Seeks, waits for the new position to play, and plays on from it.
 * @param {number} target - Where to, in seconds.
 * @param {string} what - For the error message.
 */
async function seekAndPlay(target, what) {
  await browser.execute((target) => {
    window.fastStream.currentTime = target;
  }, target);
  const state = await waitPlayable(`${what} after a seek to ${target} s`);
  expect(Math.abs(state.time - target)).toBeLessThan(2);
  await playFor(2, `${what} after a seek to ${target} s`);
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
