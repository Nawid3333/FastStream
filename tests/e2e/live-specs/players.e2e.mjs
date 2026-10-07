// FastStream against the web video players websites are built with.
//
// streams.e2e.mjs checks real streams in pages that play them with hls.js or dash.js. Most
// sites use a player library on top, or instead: video.js, Shaka, Plyr, JW-like skins over
// hls.js, players of their own with their own HLS code (xgplayer), web components whose
// <video> sits in a shadow root (Media Chrome's hls-video, Mux's players). Each wraps,
// moves or hides the video element in its own way, and FastStream has to find the stream,
// replace that player and play. Here each library's official release (exact versions
// below, from the npm registry, checked against its integrity and cached) plays the public
// test streams in a page of its own, the way its docs show, started muted the way a
// visitor's click starts it.
//
// Two passes, so a failure says whose it is: first each page plays on its own with
// FastStream not enabled there (the page and the library are right), then with the site
// on the auto-enable list FastStream must replace each player, play, seek and play on.
//
// Not part of verify or CI, like streams.e2e.mjs: run it after a change to how FastStream
// finds videos or streams:
//   pnpm run build:keep && pnpm run test:live

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {
  STREAMS, enterPlayer, npmFile, npmPackage, pageVideos, pinnedVersion, playFor, seekAndPlay,
  setOptions, waitPlayable,
} from './liveSite.mjs';

const SITE_PORT = 41960;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

/** The releases the pages load, served at /npm/<package>/<file>. */
const PACKAGES = {
  'video.js': '8.24.1',
  'shaka-player': '5.2.12',
  'plyr': '3.8.5',
  '@clappr/player': '0.14.7',
  '@clappr/hlsjs-playback': '3.1.2',
  'mediaelement': '7.1.0',
  'vidstack': '1.15.7',
  'media-chrome': '4.19.3',
  'hls-video-element': '1.5.11',
  'custom-media-element': '1.4.6',
  'media-tracks': '0.3.5',
  'dplayer': '1.27.1',
  'artplayer': '5.4.0',
  'xgplayer': '3.0.26',
  'xgplayer-hls': '3.0.26',
  'openplayerjs': '2.14.12',
};

const MIME = {hls: 'application/x-mpegURL', dash: 'application/dash+xml', mp4: 'video/mp4'};

// The DASH-IF reference vector (H.264 in fMP4, SegmentTemplate): VHS, video.js's engine,
// plays DASH only from fMP4, and Shaka's angel-one also offers WebM renditions.
const DASH_FMP4 = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';

/**
 * A page around one player.
 * @param {string} head - Stylesheets and scripts that must come first.
 * @param {string} body - The player.
 * @return {string}
 */
const doc = (head, body) => `<!doctype html><html><head><meta charset="utf-8"><title>A video site</title>
${head}</head><body style="margin: 0"><h1>A video</h1>
${body}</body></html>`;

const VIDEO = 'id="v" muted autoplay playsinline controls preload="auto" width="800" height="450"';
const BOX = '<div id="v" style="width: 800px; height: 450px"></div>';

/**
 * Each library, the formats it plays, the streams it gets when not STREAMS', and its page
 * for a stream (`src` the stream, `type` its format).
 * @type {Object<string, {formats: string[], streams?: Object<string, string>,
 *   page: function(string, string): string}>}
 */
const PLAYERS = {
  videojs: {
    formats: ['hls', 'dash', 'mp4'],
    streams: {dash: DASH_FMP4},
    // VHS, built into video.js 8, plays HLS and DASH through MSE.
    page: (src, type) => doc('<link rel="stylesheet" href="/npm/video.js/dist/video-js.min.css">',
        `<video ${VIDEO} class="video-js"></video>
        <script src="/npm/video.js/dist/video.min.js"></script>
        <script>
          const player = videojs('v', {muted: true, autoplay: 'muted'});
          player.src({src: ${JSON.stringify(src)}, type: ${JSON.stringify(MIME[type])}});
        </script>`),
  },
  shaka: {
    formats: ['hls', 'dash'],
    page: (src) => doc('', `<video ${VIDEO}></video>
        <script src="/npm/shaka-player/dist/shaka-player.compiled.js"></script>
        <script>
          shaka.polyfill.installAll();
          const player = new shaka.Player();
          player.attach(document.getElementById('v'))
              .then(() => player.load(${JSON.stringify(src)}))
              .then(() => document.getElementById('v').play());
        </script>`),
  },
  plyr: {
    formats: ['hls', 'mp4'],
    // Plyr is a skin: for HLS the site attaches hls.js itself, as Plyr's docs show.
    page: (src, type) => doc('<link rel="stylesheet" href="/npm/plyr/dist/plyr.css">',
        `<div style="width: 800px"><video ${VIDEO}></video></div>
        <script src="/lib/hls.js"></script>
        <script src="/npm/plyr/dist/plyr.min.js"></script>
        <script>
          const video = document.getElementById('v');
          if (${JSON.stringify(type)} === 'hls') {
            const hls = new Hls();
            hls.loadSource(${JSON.stringify(src)});
            hls.attachMedia(video);
          } else {
            video.src = ${JSON.stringify(src)};
          }
          new Plyr(video, {muted: true, autoplay: true});
        </script>`),
  },
  clappr: {
    formats: ['hls', 'mp4'],
    // HlsjsPlayback uses the page's global Hls.
    page: (src, type) => doc('', `${BOX}
        <script src="/npm/@clappr/player/dist/clappr.min.js"></script>
        <script src="/lib/hls.js"></script>
        <script src="/npm/@clappr/hlsjs-playback/dist/hlsjs-playback.min.js"></script>
        <script>
          new Clappr.Player({
            parentId: '#v', source: ${JSON.stringify(src)}, width: 800, height: 450,
            mute: true, autoPlay: true,
            plugins: ${JSON.stringify(type)} === 'hls' ? [HlsjsPlayback] : [],
          });
        </script>`),
  },
  mediaelement: {
    formats: ['hls', 'mp4'],
    page: (src, type) => doc('<link rel="stylesheet" href="/npm/mediaelement/build/mediaelementplayer.min.css">',
        `<video ${VIDEO}><source src="${src}" type="${MIME[type]}"></video>
        <script src="/lib/hls.js"></script>
        <script src="/npm/mediaelement/build/mediaelement-and-player.min.js"></script>
        <script>
          new MediaElementPlayer('v', {
            hls: {path: '/lib/hls.js'},
            success: (media) => media.play(),
          });
        </script>`),
  },
  vidstack: {
    formats: ['hls', 'mp4'],
    // A web component; its HLS provider loads hls.js from a CDN unless the site hands it one.
    page: (src) => doc('<script src="/lib/hls.js"></script>',
        `<media-player autoplay muted src="${src}" style="width: 800px; height: 450px">
          <media-provider></media-provider>
        </media-player>
        <script type="module">
          import '/npm/vidstack/cdn/vidstack.js';
          document.querySelector('media-player').addEventListener('provider-change', (event) => {
            if (event.detail?.type === 'hls') event.detail.library = window.Hls;
          });
        </script>`),
  },
  mediachrome: {
    formats: ['hls'],
    // <hls-video> keeps its <video> in its shadow root, as Mux's players do.
    page: (src) => doc(`<script type="importmap">${JSON.stringify({imports: {
      'custom-media-element': '/npm/custom-media-element/dist/custom-media-element.js',
      'media-tracks': '/npm/media-tracks/dist/index.js',
      'hls.js/dist/hls.mjs': '/npm/hls.js/dist/hls.mjs',
    }})}</script>
        <script src="/npm/media-chrome/dist/iife/all.js"></script>
        <script type="module" src="/npm/hls-video-element/dist/hls-video-element.js"></script>`,
    `<media-controller style="width: 800px; height: 450px">
          <hls-video slot="media" src="${src}" muted autoplay playsinline crossorigin></hls-video>
          <media-control-bar><media-play-button></media-play-button><media-time-range></media-time-range></media-control-bar>
        </media-controller>`),
  },
  dplayer: {
    formats: ['hls', 'mp4'],
    page: (src, type) => doc('<script src="/lib/hls.js"></script>', `${BOX}
        <script src="/npm/dplayer/dist/DPlayer.min.js"></script>
        <script>
          const dp = new DPlayer({
            container: document.getElementById('v'), autoplay: true,
            video: {url: ${JSON.stringify(src)}, type: ${JSON.stringify(type === 'hls' ? 'hls' : 'auto')}},
          });
          dp.video.muted = true;
          dp.play();
        </script>`),
  },
  artplayer: {
    formats: ['hls', 'mp4'],
    page: (src, type) => doc('<script src="/lib/hls.js"></script>', `${BOX}
        <script src="/npm/artplayer/dist/artplayer.js"></script>
        <script>
          new Artplayer({
            container: '#v', url: ${JSON.stringify(src)}, muted: true, autoplay: true,
            type: ${JSON.stringify(type === 'hls' ? 'm3u8' : '')},
            customType: {
              m3u8(video, url) {
                const hls = new Hls();
                hls.loadSource(url);
                hls.attachMedia(video);
              },
            },
          });
        </script>`),
  },
  xgplayer: {
    formats: ['hls', 'mp4'],
    // Its HLS plugin is its own MSE code, not hls.js.
    page: (src, type) => doc('<link rel="stylesheet" href="/npm/xgplayer/dist/index.min.css">', `${BOX}
        <script src="/npm/xgplayer/dist/index.min.js"></script>
        <script src="/npm/xgplayer-hls/dist/index.min.js"></script>
        <script>
          new Player({
            id: 'v', url: ${JSON.stringify(src)}, width: 800, height: 450,
            autoplay: true, autoplayMuted: true,
            plugins: ${JSON.stringify(type)} === 'hls' ? [HlsPlayer] : [],
          });
        </script>`),
  },
  openplayerjs: {
    formats: ['hls', 'mp4'],
    page: (src, type) => doc('<link rel="stylesheet" href="/npm/openplayerjs/dist/openplayer.min.css">',
        `<video ${VIDEO} class="op-player__media"><source src="${src}" type="${MIME[type]}"></video>
        <script src="/lib/hls.js"></script>
        <script src="/npm/openplayerjs/dist/openplayer.min.js"></script>
        <script>
          const player = new OpenPlayerJS('v');
          player.init();
        </script>`),
  },
};

// LIVE_PLAYERS narrows a run to some cases ("plyr", "mp4", "plyr mp4"; comma-separated), and
// LIVE_PHASE to one pass ("own" or "faststream"): for looking into one failure.
const ONLY = (process.env.LIVE_PLAYERS || '').split(',').map((only) => only.trim()).filter(Boolean);
const CASES = Object.entries(PLAYERS).flatMap(([name, player]) =>
  player.formats.map((type) => ({name, type, stream: player.streams?.[type] || STREAMS[type]})))
    .filter(({name, type}) => !ONLY.length || ONLY.some((only) => `${name} ${type}`.includes(only)));
const PHASE = process.env.LIVE_PHASE || '';

/**
 * A file of one of PACKAGES (or the pinned hls.js), by its path under /npm/.
 * @param {string} rest - "<package>/<file>", the package possibly scoped.
 * @return {Promise<?Buffer>} The file, or null for none.
 */
async function packageFile(rest) {
  const parts = rest.split('/');
  const pkg = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const file = parts.slice(pkg.split('/').length).join('/');
  const version = PACKAGES[pkg] || (pkg === 'hls.js' ? pinnedVersion('hls.js') : null);
  if (!version) {
    return null;
  }
  return (await npmPackage(pkg, version)).get(file) || null;
}

const TYPES = {js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json'};

let siteServer;
let hlsJs;

/**
 * Opens a case's page.
 * @param {{name: string, type: string}} testCase - The player and format.
 */
async function openPage({name, type}) {
  await browser.switchFrame(null);
  await browser.url(`${SITE}/p/${name}?type=${type}`);
}

describe('Websites\' own players', function() {
  before(async function() {
    hlsJs = await npmFile('hls.js', 'dist/hls.min.js');
    // Every package once, before any page asks for one.
    for (const [pkg, version] of Object.entries(PACKAGES)) {
      await npmPackage(pkg, version);
    }

    siteServer = http.createServer(async (req, res) => {
      try {
        const {pathname, searchParams} = new URL(req.url, SITE);
        let body = null;
        let type = 'text/html; charset=utf-8';
        if (pathname === '/lib/hls.js') {
          body = hlsJs;
          type = TYPES.js;
        } else if (pathname.startsWith('/npm/')) {
          body = await packageFile(decodeURIComponent(pathname.slice('/npm/'.length)));
          type = TYPES[pathname.split('.').pop()] || 'application/octet-stream';
        } else if (pathname.startsWith('/p/')) {
          // Only values of this file's own reach a page: the server echoes nothing it is sent.
          const player = PLAYERS[Object.keys(PLAYERS).find((name) => name === pathname.slice('/p/'.length))];
          const format = ['hls', 'dash', 'mp4'].find((name) => name === searchParams.get('type'));
          if (player && player.formats.includes(format)) {
            body = player.page(player.streams?.[format] || STREAMS[format], format);
          }
        }
        if (body === null) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {'Content-Type': type});
        res.end(body);
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });
  });

  // browser.url() navigates the frame WebDriver is in, and a test ends inside the player.
  beforeEach(async function() {
    await browser.switchFrame(null);
  });

  after(async function() {
    await browser.switchFrame(null);
    if (siteServer) {
      siteServer.closeAllConnections();
      await new Promise((resolve) => siteServer.close(resolve));
    }
  });

  (PHASE && PHASE !== 'own' ? describe.skip : describe)('each page plays on its own, FastStream not enabled there', function() {
    before(async function() {
      await setOptions({autoEnableURLs: []});
    });

    for (const testCase of CASES) {
      it(`${testCase.name} ${testCase.type}`, async function() {
        await openPage(testCase);
        let videos = [];
        try {
          await browser.waitUntil(async () => {
            videos = await pageVideos();
            return videos.some((video) => video.readyState >= 3 && video.width > 0);
          }, {timeout: 45000, interval: 500});
        } catch (e) {
          throw new Error(`the page's own player never played: ${JSON.stringify(videos)}`);
        }
      });
    }
  });

  (PHASE && PHASE !== 'faststream' ? describe.skip : describe)('FastStream replaces each player and plays', function() {
    before(async function() {
      await setOptions({autoEnableURLs: [SITE + '/']});
    });

    for (const testCase of CASES) {
      const what = `${testCase.name} ${testCase.type}`;
      it(what, async function() {
        await openPage(testCase);
        await enterPlayer();
        const state = await waitPlayable(what);
        console.log(`      ${what}:`, JSON.stringify(state));
        expect(state.url).toBe(testCase.stream);
        if (testCase.type !== 'mp4') {
          expect(state.mode).toBe(`accelerated_${testCase.type}`);
        }
        await playFor(3, what);
        await seekAndPlay(testCase.type === 'mp4' ? Math.floor(state.duration / 2) : 40, what);
      });
    }
  });
});
