// WebdriverIO config for the Chromium side of the playback suite.
//
// Mirrors wdio.conf.mjs - same web build, same local server, same specs - but
// drives a Chromium browser instead of Firefox. This fork ships the
// extension for Firefox only, but the plain web build (faststream.online)
// still runs in any browser, and the engine is not a shared implementation:
// codec pipelines, worker and SharedArrayBuffer behaviour, and hls.js's
// fallback paths all differ enough that "plays in Firefox" does not imply
// "plays in Chromium". The web build shares the players and vendored
// libraries with the extension build, so this covers the engine risk for
// the same code the Firefox suite covers.
//
// Browser selection, in order:
//   1. --browsers=chrome  or  CHROME_BIN + CHROMEDRIVER_*    (real Chrome)
//   2. Edge, if present   (Chromium; what a dev machine often has)
// The suite needs a Chromium 152-compatible binary; chromedriver 152 is the
// pinned driver. On CI the runner provides real Chrome; locally Edge serves.
//
// Run with: pnpm run test:e2e:chromium

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import * as url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../..');
const webBuildDir = path.join(root, 'built', 'web');
const fixturesDir = path.join(__dirname, 'fixtures');

export const PORT = 41881;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
let server;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ort': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// Same fixtures and same reasons as wdio.conf.mjs: the MP4 must be
// same-origin (public test files send no CORS headers) and offline once
// fetched; the WebM one is transcoded from it with ffmpeg, covering the
// jswebm patch path. Both are gitignored.
const MP4_FIXTURE_URL =
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';
const MP4_FIXTURE = path.join(fixturesDir, 'sample.mp4');
const WEBM_FIXTURE = path.join(fixturesDir, 'sample.webm');

/**
 * Transcodes the WebM fixture from the MP4 one if it is not already present.
 *
 * webm.mjs is generated from jswebm's published sources plus
 * patches/jswebm@0.1.2.patch, and every one of those patched changes is on
 * the demux path this fixture exercises. ffmpeg is required - CI installs
 * it; locally it must be on PATH.
 *
 * @return {void}
 */
function ensureWebmFixture() {
  if (fs.existsSync(WEBM_FIXTURE) && fs.statSync(WEBM_FIXTURE).size > 0) return;
  const args = [
    '-y', '-v', 'error', '-i', MP4_FIXTURE, '-t', '2',
    '-vf', 'scale=160:120', '-c:v', 'libvpx-vp9', '-b:v', '120k',
    '-cpu-used', '8', WEBM_FIXTURE,
  ];
  const {status, error, stderr} = spawnSync('ffmpeg', args, {encoding: 'utf8'});
  if (status !== 0) {
    throw new Error(
        `could not build the WebM fixture with ffmpeg` +
        `${error ? ` (${error.message})` : ''}. CI installs ffmpeg; ` +
        `locally it must be on PATH.\n${stderr || ''}`);
  }
}

/**
 * Downloads the MP4 fixture if it is not already present.
 *
 * @return {Promise<void>}
 */
async function ensureMp4Fixture() {
  if (fs.existsSync(MP4_FIXTURE) && fs.statSync(MP4_FIXTURE).size > 0) return;
  fs.mkdirSync(fixturesDir, {recursive: true});
  const res = await fetch(MP4_FIXTURE_URL);
  if (!res.ok) {
    throw new Error(
        `could not fetch the MP4 fixture (${res.status}). It is needed once; ` +
        `after that, the suite runs offline.`);
  }
  fs.writeFileSync(MP4_FIXTURE, Buffer.from(await res.arrayBuffer()));
}

/**
 * Finds a Chromium binary to drive, or exits with the reason it cannot.
 *
 * Chrome first (that is what actually ships to the Chrome Web Store), then
 * Edge (Chromium; a dev machine commonly has it and the web-build suite does
 * not touch Chrome-specific extension APIs). CHROME_BIN overrides both.
 *
 * @return {string} absolute path to the browser executable
 */
function findBrowser() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
      'No Chromium browser found for the Chromium e2e suite. ' +
      'Install Chrome (or Edge), or set CHROME_BIN to the executable.');
}

const BROWSER_BIN = findBrowser();
const IS_EDGE = /msedge/i.test(BROWSER_BIN);
const BROWSER_NAME = IS_EDGE ? 'Edge' : 'Chrome';
console.log(`Chromium e2e: driving ${BROWSER_NAME} at ${BROWSER_BIN}`);

if (!fs.existsSync(path.join(webBuildDir, 'player', 'index.html'))) {
  throw new Error(
      `Web build not found at ${webBuildDir}\nRun: pnpm run build:keep`);
}

// wdio 9 handles both engines natively (verified in @wdio/utils'
// startWebDriver): browserName "edge" starts msedgedriver via the edgedriver
// package and rewrites the name to "MicrosoftEdge" itself; "chrome" starts
// chromedriver. Setting the binary in the *browser* options (ms:edgeOptions /
// goog:chromeOptions) is what keeps wdio from "helpfully" downloading its
// own browser - setupPuppeteerBrowser returns early when it sees one.
const BROWSER_CAPS = IS_EDGE ? 'ms:edgeOptions' : 'goog:chromeOptions';
const DRIVER_OPTIONS = IS_EDGE ? 'wdio:edgedriverOptions' :
  'wdio:chromedriverOptions';
const RUN_ARGS = [
  '--headless=new',
  // The suite calls play() itself; without this Chromium blocks autoplay
  // even then, and the mp4/hls paths time out looking broken.
  '--autoplay-policy=no-user-gesture-required',
  // Headless has no audio device.
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  // CI's sandbox needs this; harmless locally.
  '--disable-dev-shm-usage',
];

export const config = {
  runner: 'local',
  // The same specs as the Firefox run: playback + modules. Both suites
  // assert engine-visible behaviour (currentTime advancing), which is exactly
  // what can differ between engines.
  specs: [path.join(__dirname, 'specs/**/*.e2e.mjs')],
  maxInstances: 1,
  baseUrl: BASE_URL,

  capabilities: [{
    // "edge"/"chrome" decide which driver wdio starts; the binary inside the
    // browser options pins the actual executable and stops wdio from
    // auto-downloading a browser of its own.
    'browserName': IS_EDGE ? 'edge' : 'chrome',
    [BROWSER_CAPS]: {
      binary: BROWSER_BIN,
      args: [
        ...RUN_ARGS,
        // A fresh, throwaway profile - never the developer's own data.
        `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'wdio-chromium-'))}`,
      ],
    },
    [DRIVER_OPTIONS]: {
      // A throwaway profile for the driver too, so a leftover lock from a
      // killed run cannot poison the next one.
      cacheDir: path.join(os.tmpdir(), 'wdio-chromium-cache'),
    },
  }],

  logLevel: 'error',
  outputDir: path.join(root, 'logs'),
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 120000,
  },

  // Same as wdio.conf.mjs: exposes this config's local-server origin to the
  // specs for same-origin fixture URLs.
  before: function() {
    globalThis.__E2E_FIXTURES_ORIGIN__ = BASE_URL;
  },

  onPrepare: async function() {
    await ensureMp4Fixture();
    await ensureWebmFixture();
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
        const base = rel.startsWith('/fixtures/') ? fixturesDir : webBuildDir;
        const sub = rel.startsWith('/fixtures/') ?
          rel.slice('/fixtures'.length) : rel;
        const abs = path.resolve(base, '.' + sub);
        if (!abs.startsWith(base) || !fs.existsSync(abs) ||
            fs.statSync(abs).isDirectory()) {
          res.writeHead(404);
          return res.end('not found');
        }
        const size = fs.statSync(abs).size;
        const headers = {
          'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Access-Control-Allow-Origin': '*',
          'Accept-Ranges': 'bytes',
        };

        // Range support is required: FastStream's accelerated MP4 mode does
        // its own range-based buffering. Overshooting ranges are clamped per
        // RFC 7233, never 416'd - see wdio.conf.mjs for the full story.
        const range = req.headers.range;
        const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (match) {
          const start = match[1] ? parseInt(match[1], 10) : 0;
          const end = Math.min(
              match[2] ? parseInt(match[2], 10) : size - 1, size - 1);
          if (start >= size || start > end) {
            res.writeHead(416, {'Content-Range': `bytes */${size}`});
            return res.end();
          }
          res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': end - start + 1,
          });
          return fs.createReadStream(abs, {start, end}).pipe(res);
        }

        res.writeHead(200, {...headers, 'Content-Length': size});
        fs.createReadStream(abs).pipe(res);
      });
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
  },

  afterTest: async function(test, context, {passed}) {
    if (passed) return;
    const dir = path.join(root, 'logs');
    fs.mkdirSync(dir, {recursive: true});
    const safe = test.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
    try {
      await browser.saveScreenshot(path.join(dir, `fail-${safe}.png`));
    } catch {
      // A screenshot is a diagnostic aid, not the assertion.
    }
  },

  onComplete: function() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.close(resolve);
    });
  },
};
