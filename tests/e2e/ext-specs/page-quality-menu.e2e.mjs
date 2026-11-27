// A page whose player makes a file only of the quality picked in its own menu: FastStream reads the
// menu (page-quality-control.js), plays the best it offers, and switches through it.
//
// A hoster's player as cineby's "Simplify" source has it: one encrypted link per quality, only the
// one picked is turned into a file; controls that leave the page when the mouse rests; a gear,
// then a "Quality" row, then the list, each built only on its click; Escape closes nothing; a new
// <video> for each file; and a "1080p" that is the 480p file. Here the page makes a link on the
// click, as that one decrypts it.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {h264Encoder} from '../buildFixtures.mjs';
import {inExtensionPage} from '../extension-page.mjs';
import {byteRange, sendFile} from '../serveFile.mjs';

const PORT = 41969;
const SITE = `http://127.0.0.1:${PORT}`;
const HOSTER = `http://localhost:${PORT}`;
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');

let server;
let workDir;
const files = {};

/**
 * One quality of the film: the long fixture's first 30 s at a height.
 * @param {string} name
 * @param {Array<string>} args - ffmpeg's arguments for the video.
 * @return {string} Its path.
 */
function makeQuality(name, args) {
  const file = path.join(workDir, name);
  const {status, stderr} = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(FIXTURES, 'long-av.mp4'), '-t', '30',
    ...args, '-c:a', 'copy', '-movflags', '+faststart', file], {encoding: 'utf8'});
  if (status !== 0) throw new Error(`could not write ${name} with ffmpeg: ${stderr}`);
  return file;
}

/**
 * The hoster's embed page and its player.
 * @return {string}
 */
function embedPage() {
  return `<!doctype html><title>hoster</title>
  <body style="margin:0;background:#000">
  <div id="player" style="position:relative;width:640px;height:360px">
    <div class="screen" style="width:100%;height:100%"></div>
  </div>
  <script>
    const QUALITIES = [['Auto', '240'], ['240p', '240'], ['360p', '360'], ['1080p', '480']];
    let current = 1;
    const player = document.getElementById('player');
    const screen = player.querySelector('.screen');
    let controls = null;
    let panel = null;
    let idle = 0;
    function mount() {
      screen.textContent = '';
      const video = document.createElement('video');
      video.muted = true;
      video.autoplay = true;
      video.preload = 'auto';
      video.style.cssText = 'width:100%;height:100%';
      video.src = '/media/' + QUALITIES[current][1] + '.mp4?key=' + Math.random().toString(36).slice(2);
      screen.appendChild(video);
      window.picked = QUALITIES[current][0];
    }
    function closePanel() {
      panel?.remove();
      panel = null;
    }
    function item(label, selected, onClick) {
      const el = document.createElement('div');
      el.tabIndex = 0;
      el.className = 'item';
      el.innerHTML = '<span></span>' + (selected ? '<svg class="check" width="10" height="10"></svg>' : '');
      el.firstChild.textContent = label;
      el.addEventListener('click', onClick);
      return el;
    }
    function showList() {
      panel.textContent = '';
      QUALITIES.forEach(([label], i) => panel.appendChild(item(label, i === current, () => {
        current = i;
        closePanel();
        mount();
      })));
    }
    function openPanel() {
      panel = document.createElement('div');
      panel.setAttribute('role', 'menu');
      panel.style.cssText = 'position:absolute;right:0;bottom:40px;width:200px';
      for (const [name, value, onClick] of [['Speed', 'Normal', () => {}], ['Quality', QUALITIES[current][0], () => setTimeout(showList, 150)]]) {
        const row = document.createElement('div');
        row.tabIndex = 0;
        row.className = 'row';
        row.innerHTML = '<span></span><span></span>';
        row.children[0].textContent = name;
        row.children[1].textContent = value;
        row.addEventListener('click', onClick);
        panel.appendChild(row);
      }
      player.appendChild(panel);
    }
    function showControls() {
      clearTimeout(idle);
      idle = setTimeout(() => {
        if (panel) return;
        controls?.remove();
        controls = null;
      }, 2000);
      if (controls) return;
      controls = document.createElement('div');
      controls.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:40px';
      const gear = document.createElement('button');
      gear.setAttribute('aria-label', 'Settings');
      gear.innerHTML = '<svg width="16" height="16"><circle cx="8" cy="8" r="6"></circle></svg>';
      gear.addEventListener('click', () => (panel ? closePanel() : setTimeout(openPanel, 150)));
      controls.appendChild(gear);
      player.appendChild(controls);
    }
    player.addEventListener('mousemove', showControls);
    mount();
  </script>`;
}

/**
 * Into FastStream's player in the hoster's iframe, once it plays.
 * @return {Promise<void>}
 */
async function enterPlayer() {
  const selector = 'iframe[src*="player/index.html"]';
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
    return {
      source: client.source.url,
      height: video.videoHeight,
      menu: Array.from(client.getMenuVideoLevels().values()).map((level) => level.label),
      current: client.getMenuVideoLevelID(),
    };
  });
}

/**
 * Waits until the player plays a file of the height.
 * @param {number} height
 * @return {Promise<Object>} Its state then.
 */
async function playingHeight(height) {
  let state;
  await browser.waitUntil(async () => {
    state = await playerState();
    return state.height === height;
  }, {timeout: 40000, interval: 250, timeoutMsg: `never played the ${height}p file`}).catch(() => {});
  console.log('      player:', JSON.stringify(state));
  return state;
}

describe('A page player that makes a file only of the quality picked in its menu', function() {
  before(async function() {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faststream-quality-menu-'));
    files['240'] = makeQuality('240.mp4', ['-vf', 'scale=426:240', '-c:v', h264Encoder('240p quality')]);
    files['360'] = makeQuality('360.mp4', ['-c:v', 'copy']);
    files['480'] = makeQuality('480.mp4', ['-vf', 'scale=854:480', '-c:v', h264Encoder('480p quality')]);

    server = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      if (url.pathname === '/') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        return res.end(`<!doctype html><title>site</title>
          <iframe id="hoster" src="${HOSTER}/embed/1" width="640" height="360" allowfullscreen frameborder="0"></iframe>`);
      }
      if (url.pathname === '/embed/1') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        return res.end(embedPage());
      }
      const media = /^\/media\/(\d+)\.mp4$/.exec(url.pathname);
      const file = media && url.searchParams.get('key') ? files[media[1]] : null;
      if (file) {
        const size = fs.statSync(file).size;
        const range = byteRange(req.headers.range, size);
        if (range && range !== 'unsatisfiable') {
          res.writeHead(206, {'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': range.end - range.start + 1});
          return sendFile(res, file, range);
        }
        res.writeHead(200, {'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size});
        return sendFile(res, file);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });

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

  it('lists the menu\'s qualities and plays the biggest file through it, whatever its label says', async function() {
    await browser.url(`${SITE}/?t=${Date.now()}`);
    await enterPlayer();
    const state = await playingHeight(480);
    expect(state.source).toContain('/media/480.mp4?key=');
    expect(state.menu).toEqual(['240p', '360p', '1080p']);
    expect(state.current).toBe('page-quality:2');
  });

  it('switches the page\'s player for a quality picked in FastStream\'s menu, and plays its file', async function() {
    await enterPlayer();
    await browser.execute(() => window.fastStream.setCurrentVideoLevelID('page-quality:1'));
    const state = await playingHeight(360);
    expect(state.source).toContain('/media/360.mp4?key=');
    expect(state.current).toBe('page-quality:1');
    // The page's own player picked it too, its video held paused under FastStream's.
    await browser.switchFrame(null);
    await browser.switchFrame(await browser.$('#hoster'));
    const page = await browser.execute(() => {
      const videos = Array.from(document.querySelectorAll('#player video'));
      return {picked: window.picked, videos: videos.length, paused: videos.every((v) => v.paused)};
    });
    expect(page).toEqual({picked: '360p', videos: 1, paused: true});
  });
});
