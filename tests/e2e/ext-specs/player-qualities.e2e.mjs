// The web player libraries that offer a video in several qualities as files of their own: FastStream
// lists the qualities the page's player offers, plays the best (the "Default video quality" setting, Auto),
// and switches between them.
//
// Each library's npm release at the version tests/e2e/live-specs/player-libraries.json pins, which
// toolchain-updates.yml moves: a library update that changes where it keeps its qualities fails here
// on its update pull request. Every page plays three files of this run's own, 240p, 360p and 480p,
// from 127.0.0.1, its default the lowest where the library takes one, as many sites have it; only the
// libraries come from npm.
//
// Two passes: each page on its own, its quality menu offering the three (the page is right), then
// FastStream in its place.
//
// QUALITY_PLAYERS narrows a run to some libraries ("plyr,xgplayer"), for looking into one failure.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {h264Encoder} from '../buildFixtures.mjs';
import {setOptions} from '../live-specs/liveSite.mjs';
import {ensureMp4Shape, fixturesDir} from '../mp4Shapes.mjs';
import {NPM_FILE_TYPES, PLAYER_LIBRARIES, npmPackage, playerLibraryFile} from '../npmPackages.mjs';
import {byteRange, sendFile} from '../serveFile.mjs';

const PORT = 41906;
const SITE = `http://127.0.0.1:${PORT}`;
const HEIGHTS = [240, 360, 480];
const media = (height) => `/media/${height}.mp4`;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
};

/**
 * A page around one player.
 * @param {string} head - Stylesheets and scripts that must come first.
 * @param {string} body - The player.
 * @return {string}
 */
const doc = (head, body) => `<!doctype html><html><head><meta charset="utf-8"><title>A video site</title>
${head}</head><body style="margin: 0"><h1>A video</h1>
${body}</body></html>`;

const BOX = '<div id="v" style="width: 800px; height: 450px"></div>';
const VIDEO = 'id="v" muted autoplay playsinline controls preload="auto" width="800" height="450"';

/**
 * Each library: the packages its page loads from /npm/, its page as its docs tell a site to offer
 * several files, and the labels its own quality menu shows (run in the page; it may open the menu
 * first), or null while it has none.
 * @type {Object<string, {packages: string[], page: function(): string, menu: function(): ?Array<string>}>}
 */
const LIBRARIES = {
  // A <source> per file, its height in size; quality.default picks one.
  plyr: {
    packages: ['plyr'],
    page: () => doc('<link rel="stylesheet" href="/npm/plyr/dist/plyr.css">', `<div style="width: 800px">
      <video ${VIDEO}>${HEIGHTS.map((h) => `<source src="${media(h)}" type="video/mp4" size="${h}">`).join('')}</video></div>
      <script src="/npm/plyr/dist/plyr.min.js"></script>
      <script>new Plyr('#v', {muted: true, autoplay: true, quality: {default: 240}});</script>`),
    menu: () => Array.from(document.querySelectorAll('button[data-plyr="quality"]')).map((item) => item.textContent.trim()),
  },
  // Video.js 8 with @silvermine/videojs-quality-selector: sources given with a label, one selected.
  videojs: {
    packages: ['video.js', '@silvermine/videojs-quality-selector'],
    page: () => doc(`<link rel="stylesheet" href="/npm/video.js/dist/video-js.min.css">
      <link rel="stylesheet" href="/npm/@silvermine/videojs-quality-selector/dist/css/quality-selector.css">`,
    `<video ${VIDEO} class="video-js"></video>
      <script src="/npm/video.js/dist/video.min.js"></script>
      <script src="/npm/@silvermine/videojs-quality-selector/dist/js/silvermine-videojs-quality-selector.min.js"></script>
      <script>
        const player = videojs('v', {muted: true, autoplay: 'muted', controlBar: {children: [
          'playToggle', 'progressControl', 'volumePanel', 'qualitySelector', 'fullscreenToggle']}});
        player.src(${JSON.stringify(HEIGHTS.slice().reverse().map((h) => ({src: media(h), type: 'video/mp4', label: `${h}P`,
          ...(h === HEIGHTS[0] ? {selected: true} : {})})))});
      </script>`),
    menu: () => Array.from(document.querySelectorAll('.vjs-quality-selector .vjs-menu-item-text')).map((item) => item.textContent.trim()),
  },
  // option.quality [{html, url, default}], the default one also the url.
  artplayer: {
    packages: ['artplayer'],
    page: () => doc('', `${BOX}
      <script src="/npm/artplayer/dist/artplayer.js"></script>
      <script>
        new Artplayer({container: '#v', url: '${media(240)}', muted: true, autoplay: true,
          quality: ${JSON.stringify(HEIGHTS.map((h) => ({...(h === HEIGHTS[0] ? {default: true} : {}), html: `${h}P`, url: media(h)})))}});
      </script>`),
    menu: () => Array.from(document.querySelectorAll('.art-control-quality .art-selector-item')).map((item) => item.textContent.trim()),
  },
  // video.quality [{name, url}] and video.defaultQuality, the instance in a const as in its docs.
  dplayer: {
    packages: ['dplayer'],
    page: () => doc('', `${BOX}
      <script src="/npm/dplayer/dist/DPlayer.min.js"></script>
      <script>
        const dp = new DPlayer({container: document.getElementById('v'), autoplay: true,
          video: {quality: ${JSON.stringify(HEIGHTS.slice().reverse().map((h) => ({name: `${h}P`, url: media(h), type: 'normal'})))},
            defaultQuality: ${HEIGHTS.length - 1}}});
        dp.video.muted = true;
        dp.play();
      </script>`),
    menu: () => Array.from(document.querySelectorAll('.dplayer-quality-item')).map((item) => item.textContent.trim()),
  },
  // definition.list [{definition, url, text}] and definition.defaultDefinition.
  xgplayer: {
    packages: ['xgplayer'],
    page: () => doc('<link rel="stylesheet" href="/npm/xgplayer/dist/index.min.css">', `${BOX}
      <script src="/npm/xgplayer/dist/index.min.js"></script>
      <script>
        const player = new Player({id: 'v', url: '${media(240)}', width: 800, height: 450, autoplay: true, autoplayMuted: true,
          definition: {defaultDefinition: '240p',
            list: ${JSON.stringify(HEIGHTS.slice().reverse().map((h) => ({definition: `${h}p`, url: media(h), text: `${h}P`})))}}});
      </script>`),
    menu: () => Array.from(document.querySelectorAll('.xgplayer-definition .option-item')).map((item) => item.textContent.trim()),
  },
  // MediaElement.js with mediaelement-plugins' quality feature: a <source> per file, its name in data-quality.
  mediaelement: {
    packages: ['mediaelement', 'mediaelement-plugins'],
    page: () => doc(`<link rel="stylesheet" href="/npm/mediaelement/build/mediaelementplayer.min.css">
      <link rel="stylesheet" href="/npm/mediaelement-plugins/dist/quality/quality.min.css">`,
    `<video ${VIDEO}>${HEIGHTS.map((h) => `<source src="${media(h)}" type="video/mp4" data-quality="${h}p">`).join('')}</video>
      <script src="/npm/mediaelement/build/mediaelement-and-player.min.js"></script>
      <script src="/npm/mediaelement-plugins/dist/quality/quality.min.js"></script>
      <script>
        new MediaElementPlayer('v', {features: ['playpause', 'current', 'progress', 'duration', 'volume', 'quality', 'fullscreen'],
          defaultQuality: '240p', success: (media) => media.play()});
      </script>`),
    menu: () => Array.from(document.querySelectorAll('.mejs__qualities-selector-label')).map((item) => item.textContent.trim()),
  },
  // sources [{type, file, label}]: its settings menu's Source list.
  ovenplayer: {
    packages: ['ovenplayer'],
    page: () => doc('', `${BOX}
      <script src="/npm/ovenplayer/dist/ovenplayer.js"></script>
      <script>
        OvenPlayer.create('v', {autoStart: true, mute: true,
          sources: ${JSON.stringify(HEIGHTS.map((h) => ({type: 'mp4', file: media(h), label: `${h}p`})))}});
      </script>`),
    menu: () => {
      // The source panel's items: the settings panel's own item for it says "Source".
      const titles = () => Array.from(document.querySelectorAll('.op-setting-item[op-panel-type="source"]'))
          .filter((item) => /^\d+$/.test(item.getAttribute('op-data-value')))
          .map((item) => item.querySelector('.op-setting-item-title').textContent.trim());
      if (!titles().length) {
        document.querySelector('.op-setting-button')?.click();
        document.querySelector('.op-setting-item[op-panel-type="source"]')?.click();
      }
      return titles();
    },
  },
  // A <source> per file, its name in title, and the levels control (its own menu with detachMenus).
  openplayerjs: {
    packages: ['openplayerjs'],
    page: () => doc('<link rel="stylesheet" href="/npm/openplayerjs/dist/openplayer.min.css">',
        `<video ${VIDEO} class="op-player__media">${HEIGHTS.map((h) => `<source src="${media(h)}" type="video/mp4" title="${h}p">`).join('')}</video>
      <script src="/npm/openplayerjs/dist/openplayer.min.js"></script>
      <script>
        const player = new OpenPlayerJS('v', {detachMenus: true,
          controls: {layers: {left: ['play', 'time', 'volume'], middle: ['progress'], right: ['levels', 'fullscreen']}}});
        player.init();
      </script>`),
    menu: () => Array.from(document.querySelectorAll('.op-levels__option')).map((item) => item.textContent.trim()),
  },
  // Sources given with their size ({src, type, width, height}). No skin: its quality list stands in for the menu.
  vidstack: {
    packages: ['vidstack'],
    page: () => doc('', `<media-player autoplay muted style="width: 800px; height: 450px">
        <media-provider></media-provider>
      </media-player>
      <script type="module">
        import '/npm/vidstack/cdn/vidstack.js';
        document.querySelector('media-player').src = ${JSON.stringify(HEIGHTS.map((h) => ({src: media(h), type: 'video/mp4',
          width: Math.round(h * 16 / 9), height: h})))};
      </script>`),
    menu: () => Array.from(document.querySelector('media-player')?.qualities ?? []).map((quality) => `${quality.height}p`),
  },
};

const ONLY = (process.env.QUALITY_PLAYERS || '').split(',').map((only) => only.trim()).filter(Boolean);
const NAMES = Object.keys(LIBRARIES).filter((name) => !ONLY.length || ONLY.includes(name));

let server;
/** @type {Object<string, string>} */
const files = {};

/**
 * The file of each height: the long fixture's first 30 s at that size, a keyframe a second.
 * @return {void}
 */
function ensureQualityFiles() {
  const encoder = h264Encoder('player qualities');
  for (const height of HEIGHTS) {
    files[media(height)] = ensureMp4Shape(`quality-${height}p-30s-${encoder}.mp4`, ['-i', path.join(fixturesDir, 'long-av.mp4'),
      '-t', '30', '-vf', `scale=-2:${height}`, '-c:v', encoder, '-b:v', `${height * 2}k`, '-g', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', '-movflags', '+faststart']);
  }
}

/**
 * Answers the site's pages, the packages they load and the files they play.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function answer(req, res) {
  const {pathname} = new URL(req.url, SITE);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  const file = Object.hasOwn(files, pathname) ? files[pathname] : null;
  if (file) {
    const {size} = fs.statSync(file);
    const range = byteRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, {...CORS, 'Content-Range': `bytes */${size}`});
      return res.end();
    }
    if (range) {
      res.writeHead(206, {...CORS, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': range.end - range.start + 1});
      return sendFile(res, file, range);
    }
    res.writeHead(200, {...CORS, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size});
    return sendFile(res, file);
  }
  let body = null;
  let type = 'text/html; charset=utf-8';
  if (pathname.startsWith('/npm/')) {
    body = await playerLibraryFile(decodeURIComponent(pathname.slice('/npm/'.length)));
    type = NPM_FILE_TYPES[pathname.split('.').pop()] || 'application/octet-stream';
  } else if (pathname.startsWith('/p/')) {
    // Only this file's own pages: the server echoes nothing it is sent.
    const name = NAMES.find((known) => known === pathname.slice('/p/'.length));
    if (name) body = LIBRARIES[name].page();
  }
  if (body === null) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, {'Content-Type': type});
  res.end(body);
}

/**
 * One tab, the page's: a fresh temporary add-on opens its welcome tab at no fixed moment, and a tab behind
 * it gets no animation frames, so no menu of its opens.
 * @return {Promise<void>}
 */
async function oneTab() {
  await browser.switchFrame(null);
  const handles = await browser.getWindowHandles();
  for (const handle of handles.slice(1)) {
    await browser.switchToWindow(handle);
    await browser.closeWindow();
  }
  await browser.switchToWindow(handles[0]);
}

/**
 * Opens a library's page.
 * @param {string} name
 * @return {Promise<void>}
 */
async function openPage(name) {
  await oneTab();
  await browser.url(`${SITE}/p/${name}?t=${Date.now()}`);
}

/**
 * The heights labels name, in order. A label without one ("Auto") is left out.
 * @param {Array<string>} labels
 * @return {Array<number>}
 */
const heightsOf = (labels) => labels.map((label) => Number(/\d{3,4}/.exec(label)?.[0] || 0)).filter(Boolean).sort((a, b) => a - b);

/**
 * Switches into FastStream's player, which replaced the page's video.
 * @return {Promise<void>}
 */
async function enterPlayer() {
  const selector = 'iframe[src*="player/index.html"]';
  await browser.waitUntil(async () => {
    await browser.switchFrame(null);
    return browser.$(selector).isExisting();
  }, {timeout: 30000, interval: 250, timeoutMsg: 'FastStream never replaced the page\'s player'});
  await browser.switchFrame(await browser.$(selector));
}

/**
 * What FastStream's player plays, and the page qualities it was given.
 * @return {Promise<Object>}
 */
function playerState() {
  return browser.execute(() => {
    const client = window.fastStream;
    const video = client?.player?.getVideo?.();
    if (video?.paused && video.readyState >= 2) client.play().catch(() => {});
    return {
      url: client?.source?.url ?? null,
      qualities: (client?.source?.qualities || []).map((quality) => ({height: quality.height, label: quality.label})),
      height: video?.videoHeight ?? 0,
      readyState: video?.readyState ?? 0,
      time: video?.currentTime ?? 0,
      level: client?.getMenuVideoLevelID?.() ?? null,
      menu: client ? Array.from(client.getMenuVideoLevels().values()).map((level) => level.label) : [],
    };
  });
}

/**
 * Waits until FastStream plays the file of a height, on from where it shows a picture.
 * @param {number} height
 * @param {string} what - For the error message.
 * @return {Promise<Object>} The state then.
 */
async function waitPlaying(height, what) {
  let state;
  let since = null;
  try {
    await browser.waitUntil(async () => {
      state = await playerState();
      if (state.height !== height || state.readyState < 2) {
        since = null;
        return false;
      }
      since ??= state.time;
      return state.time > since + 0.3;
    }, {timeout: 30000, interval: 250});
  } catch (e) {
    throw new Error(`${what}: FastStream never played the ${height}p file: ${JSON.stringify(state)}`);
  }
  return state;
}

describe('Player libraries\' qualities as files of their own', function() {
  before(async function() {
    ensureQualityFiles();
    const needed = new Set(NAMES.flatMap((name) => LIBRARIES[name].packages));
    await Promise.all([...needed].map((pkg) => npmPackage(pkg, PLAYER_LIBRARIES[pkg])));
    server = http.createServer((req, res) => {
      answer(req, res).catch((e) => {
        // The page gets the status only (CodeQL js/stack-trace-exposure).
        console.error('site server:', JSON.stringify(String(e && e.stack || e)));
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    await browser.switchFrame(null);
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('each page\'s own menu offers the three, FastStream not enabled there', function() {
    before(async function() {
      await setOptions({autoEnableURLs: []});
    });

    for (const name of NAMES) {
      it(name, async function() {
        await openPage(name);
        let labels = [];
        await browser.waitUntil(async () => {
          labels = await browser.execute(LIBRARIES[name].menu).catch(() => []) || [];
          return heightsOf(labels).join() === HEIGHTS.join();
        }, {timeout: 20000, interval: 250}).catch(() => {});
        expect(heightsOf(labels)).toEqual(HEIGHTS);
      });
    }
  });

  describe('FastStream lists them, plays the best and switches', function() {
    before(async function() {
      await setOptions({autoEnableURLs: [SITE + '/']});
    });

    for (const name of NAMES) {
      it(name, async function() {
        await openPage(name);
        await enterPlayer();
        const best = await waitPlaying(HEIGHTS[HEIGHTS.length - 1], name);
        console.log(`      ${name}:`, JSON.stringify(best));
        expect(best.qualities.map((quality) => quality.height).sort((a, b) => a - b)).toEqual(HEIGHTS);
        const index = (height) => best.qualities.findIndex((quality) => quality.height === height);
        expect(best.level).toBe(`page-quality:${index(HEIGHTS[HEIGHTS.length - 1])}`);
        for (const height of HEIGHTS.slice(0, -1)) {
          await browser.execute((id) => window.fastStream.setCurrentVideoLevelID(id), `page-quality:${index(height)}`);
          const state = await waitPlaying(height, `${name}, switched to ${height}p`);
          expect(state.level).toBe(`page-quality:${index(height)}`);
        }
      });
    }
  });
});
