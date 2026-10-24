// A page whose player offers its video in several qualities, as files of their own: the
// player plays the one the quality setting asks for, lists them all, and switches between
// them where the video is.
//
// a film site's hoster (2026-10-12): a Playerjs set up with
// `file: "[360p]<its get_file link>,[720p]<link>,[1080p]<link>"` and
// `default_quality: "360p"`, in an iframe of another site. The page's video asks for the 360p
// file; the hoster answers each get_file link with a redirect to its CDN. FastStream saw that
// one request, played the 360p file from the CDN's address, and offered no other quality.
// page-qualities.js reads the list in the page; the background ties the stream to it by the
// address the redirect came from.
//
// The hoster here is built the same way, without Playerjs itself: the page's script holds the
// same file string, and its video asks for the first file.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {h264Encoder} from '../buildFixtures.mjs';
import {inExtensionPage} from '../extension-page.mjs';
import {byteRange, sendFile} from '../serveFile.mjs';

const PORT = 41962;
// The site, and the hoster in its iframe: another origin, as that film site's is.
const SITE = `http://127.0.0.1:${PORT}`;
const HOSTER = `http://localhost:${PORT}`;
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
};
const fileLink = (quality) => `${HOSTER}/get_file/9/abc/1/1_${quality}.mp4/`;
const en = JSON.parse(fs.readFileSync(new URL('../../../chrome/_locales/en/messages.json', import.meta.url), 'utf8'));

let server;
let workDir;
const files = {};

/**
 * Writes one quality of the film with ffmpeg: the long fixture's first 40 s at a size.
 * @param {string} name - The file's name.
 * @param {Array<string>} args - ffmpeg's arguments for the video.
 * @return {string} Its path.
 */
function makeQuality(name, args) {
  const file = path.join(workDir, name);
  const {status, stderr} = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(FIXTURES, 'long-av.mp4'), '-t', '40',
    ...args, '-c:a', 'copy', '-movflags', '+faststart', file], {encoding: 'utf8'});
  if (status !== 0) throw new Error(`could not write ${name} with ffmpeg: ${stderr}`);
  return file;
}

/**
 * The hoster's embed page: its player's file string, and its video on the first file.
 * @return {string}
 */
function embedPage() {
  const file = `[360p]${fileLink('360p')},[720p]${fileLink('720p')}`;
  return `<!doctype html><title>hoster</title>
    <body style="margin:0;background:#000">
    <div id="Video1"><video muted autoplay preload="auto" style="width:640px;height:360px" src="${fileLink('360p')}"></video></div>
    <script>
      function Playerjs(options) { this.options = options; }
      var player = new Playerjs({id: 'Video1', file:"${file}", default_quality: "360p"});
    </script>`;
}

/**
 * Switches into FastStream's player, which replaced the video in the hoster's iframe.
 * @return {Promise<void>}
 */
async function enterPlayer() {
  const selector = 'iframe[src*="player/index.html"]';
  await browser.switchFrame(null);
  await browser.waitUntil(async () => {
    await browser.switchFrame(null);
    await browser.switchFrame(await browser.$('#hoster'));
    return browser.$(selector).isExisting();
  }, {timeout: 30000, interval: 500, timeoutMsg: 'FastStream never replaced the hoster\'s video'});
  await browser.switchFrame(await browser.$(selector));
  await browser.waitUntil(async () => browser.execute(() => {
    const video = window.fastStream?.player?.getVideo?.();
    return !!video && video.readyState >= 2;
  }), {timeout: 30000, interval: 250, timeoutMsg: 'the player never had a picture'});
}

/**
 * What the player plays, and what its quality menu offers.
 * @return {Promise<Object>}
 */
function playerState() {
  return browser.execute(() => {
    const client = window.fastStream;
    const video = client.player.getVideo();
    if (video.paused) client.play().catch(() => {});
    return {
      source: client.source.url,
      width: video.videoWidth,
      time: client.currentTime,
      menu: Array.from(client.getMenuVideoLevels().values()).map((level) => level.label),
      current: client.getMenuVideoLevelID(),
      items: Array.from(document.querySelectorAll('.fluid_video_source_list_item')).map((item) => item.textContent.trim()),
    };
  });
}

describe('A page that offers its video in several qualities', function() {
  before(async function() {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faststream-qualities-'));
    files['1_360p.mp4'] = makeQuality('360.mp4', ['-c:v', 'copy']);
    files['1_720p.mp4'] = makeQuality('720.mp4', ['-vf', 'scale=1280:720', '-c:v', h264Encoder('720p quality')]);

    server = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
      }
      if (url.pathname === '/') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        return res.end(`<!doctype html><title>site</title>
          <iframe id="hoster" src="${HOSTER}/embed/1" width="640" height="360" allowfullscreen frameborder="0"></iframe>`);
      }
      if (url.pathname === '/embed/1') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        return res.end(embedPage());
      }
      // The hoster's link: a redirect to its CDN, with a token in the query.
      const link = /^\/get_file\/9\/abc\/1\/(1_\w+\.mp4)\/$/.exec(url.pathname);
      if (link && files[link[1]]) {
        res.writeHead(302, {...CORS, 'Location': `${HOSTER}/cdn/remote_control.php?time=${Date.now()}&file=${link[1]}`});
        return res.end();
      }
      const file = url.pathname === '/cdn/remote_control.php' && files[url.searchParams.get('file')];
      if (file) {
        const size = fs.statSync(file).size;
        const range = byteRange(req.headers.range, size);
        if (range && range !== 'unsatisfiable') {
          res.writeHead(206, {...CORS, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': range.end - range.start + 1});
          return sendFile(res, file, range);
        }
        res.writeHead(200, {...CORS, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size});
        return sendFile(res, file);
      }
      res.writeHead(404, CORS);
      res.end();
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });

    // The site on the auto-enable list: the player opens by itself once a stream is found.
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
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (workDir) fs.rmSync(workDir, {recursive: true, force: true});
  });

  it('plays the highest quality, not the page\'s default, and lists them all', async function() {
    await browser.url(`${SITE}/?t=${Date.now()}`);
    await enterPlayer();
    const state = await playerState();
    console.log('      player:', JSON.stringify(state));
    expect(state.source).toBe(fileLink('720p'));
    expect(state.width).toBe(1280);
    expect(state.menu).toEqual(['360p', '720p']);
    expect(state.current).toBe('page-quality:1');
  });

  it('switches to another where the video is', async function() {
    // Each test starts in the top page (setupGuard.mjs): into the same player again.
    await enterPlayer();
    let before;
    await browser.waitUntil(async () => {
      before = await playerState();
      return before.time > 4;
    }, {timeout: 30000, interval: 250, timeoutMsg: 'the 720p file never played on'});
    await browser.execute(() => {
      window.__playedAt = [];
      window.__oldPlayer = window.fastStream.player;
      window.__watch = setInterval(() => {
        const player = window.fastStream.player;
        if (!player || player === window.__oldPlayer || player.__watched) return;
        player.__watched = true;
        const video = player.getVideo();
        const note = () => {
          if (!video.paused && !video.seeking) window.__playedAt.push(video.currentTime);
        };
        video.addEventListener('timeupdate', note);
        video.addEventListener('playing', note);
      }, 20);
      window.fastStream.setCurrentVideoLevelID('page-quality:0');
    });
    let after;
    await browser.waitUntil(async () => {
      after = await playerState();
      return after.width === 640 && after.time > before.time;
    }, {timeout: 30000, interval: 250}).catch(() => {});
    const firstPlayed = await browser.execute(() => {
      clearInterval(window.__watch);
      return window.__playedAt.length ? Math.min(...window.__playedAt) : -1;
    });
    console.log('      after the switch:', JSON.stringify({...after, firstPlayed, before: before.time}));
    expect(after.source).toBe(fileLink('360p'));
    expect(after.width).toBe(640);
    expect(after.current).toBe('page-quality:0');
    // From where it was (whole seconds), nothing of the start first.
    expect(firstPlayed).toBeGreaterThanOrEqual(Math.floor(before.time));
  });

  it('lowers the quality when this computer drops the frames, says so, and keeps one picked again', async function() {
    // His wish (2026-10-24): a version the computer cannot show in time is stepped down, and
    // never without a word. Firefox's own count stands in for a slow computer: from each
    // video element's first count, a third of its frames dropped. The watch judges 3 s
    // stretches after 1 s here, not 10 s after 4 s, to keep within the 40 s file.
    await browser.url(`${SITE}/?t=${Date.now()}`);
    await enterPlayer();
    await browser.execute(() => {
      const started = new WeakMap();
      HTMLVideoElement.prototype.getVideoPlaybackQuality = function() {
        if (!started.has(this)) started.set(this, performance.now());
        const total = Math.floor((performance.now() - started.get(this)) * 30 / 1000);
        return {totalVideoFrames: total, droppedVideoFrames: Math.floor(total / 3), corruptedVideoFrames: 0, creationTime: performance.now()};
      };
      Object.assign(window.fastStream.droppedFrameWatch, {windowMs: 3000, warmupMs: 1000});
    });
    expect((await playerState()).current).toBe('page-quality:1');

    await browser.waitUntil(() => browser.execute(() => window.fastStream.getMenuVideoLevelID() === 'page-quality:0'),
        {timeout: 30000, interval: 250, timeoutMsg: 'the player never lowered the quality'});
    const said = en.player_quality_lowered.message.replace('$1', '360p').replace('$2', '33').replaceAll('$3', '720p');
    await browser.waitUntil(() => browser.execute((said) => Array.from(document.querySelectorAll('.mainplayer .status_message'))
        .some((el) => el.style.display !== 'none' && el.textContent === said), said),
    {timeout: 5000, timeoutMsg: `the player did not say "${said}"`});

    // The user picks 720p again in the quality menu: it stays, whatever it drops.
    await browser.waitUntil(async () => (await playerState()).width === 640,
        {timeout: 30000, interval: 250, timeoutMsg: 'the 360p file never played'});
    const picked = await browser.execute(() => {
      const item = Array.from(document.querySelectorAll('.fluid_video_source_list_item'))
          .find((el) => el.textContent.trim().startsWith('720p'));
      item?.click();
      return !!item;
    });
    expect(picked).toBe(true);
    await browser.waitUntil(async () => (await playerState()).width === 1280,
        {timeout: 30000, interval: 250, timeoutMsg: 'the 720p file never played again'});
    // Four times the warm-up and a stretch, playing on.
    await browser.pause(16000);
    const state = await playerState();
    console.log('      after the pick:', JSON.stringify(state));
    expect(state.current).toBe('page-quality:1');
    expect(state.width).toBe(1280);
  });
});
