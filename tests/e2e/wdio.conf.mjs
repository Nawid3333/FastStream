// WebdriverIO config for the end-to-end playback suite.
//
// This exists to replace a manual checklist. Every change to a player, a
// loader or a vendored media library previously needed someone to open three
// URLs by hand and watch whether video appeared; that does not scale, it was
// never run on CI, and it silently stops happening.
//
// What is tested, and what is not
// -------------------------------
// The suite drives the **web** build (built/web), not the extension build.
// That is a deliberate trade.
//
// Driving the extension build turned out to be a dead end for this purpose:
// geckodriver refuses to navigate to moz-extension:// origins, Firefox refuses
// top-level navigation to an extension page from web content, and framing it
// depends on pinning the internal add-on uuid, which Firefox allocates for
// itself. Each workaround tested Firefox's extension plumbing rather than
// FastStream.
//
// The web build ships the *same* players and the *same* vendored libraries -
// hls.js and its worker, dash.js, mp4box - reached through the same
// `player/index.html#<url>` entry point in main.mjs. So it catches exactly the
// class of regression these library migrations risk, which is the reason the
// suite exists.
//
// It does not cover the background script, stream interception or the
// manifest. Those need the extension harness and are checked by
// `pnpm run lint:amo:dist` and by loading the build in Firefox.

import {spawnSync} from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../..');
const webBuildDir = path.join(root, 'built', 'web');
const fixturesDir = path.join(__dirname, 'fixtures');

export const PORT = 41879;
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

// The MP4 fixture is served locally rather than fetched from a public host.
// The obvious public test files send no CORS headers, and FastStream's
// accelerated MP4 mode fetches the file itself to do its own range-based
// buffering - which an extension may do via host permissions but a web page
// may not. Serving it same-origin removes both the CORS problem and a network
// dependency in CI. It is downloaded once and gitignored rather than
// committed, to keep a binary out of the repository.
const MP4_FIXTURE_URL =
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';
const MP4_FIXTURE = path.join(fixturesDir, 'sample.mp4');

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
        `after that the suite runs offline.`,
    );
  }
  fs.writeFileSync(MP4_FIXTURE, Buffer.from(await res.arrayBuffer()));
}

// The WebM fixture is transcoded from the MP4 one rather than downloaded or
// committed. webm.mjs is generated from jswebm's published sources plus
// patches/jswebm@0.1.2.patch, and every one of those patched changes is on
// this path - the VP9 codec string, the colour metadata, the keyFrame
// spelling, and demux()'s progress return, without which WebMDemuxer.process
// stops before demuxing anything. None of it is reachable from the MP4
// specs.
const WEBM_FIXTURE = path.join(fixturesDir, 'sample.webm');

/**
 * Transcodes the WebM fixture from the MP4 one if it is not already present.
 *
 * @return {Promise<void>}
 */
async function ensureWebmFixture() {
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
        `locally it must be on PATH.\n${stderr || ''}`,
    );
  }
}

if (!fs.existsSync(path.join(webBuildDir, 'player', 'index.html'))) {
  throw new Error(
      `Web build not found at ${webBuildDir}\nRun: pnpm run build:keep`,
  );
}

export const config = {
  runner: 'local',
  specs: [path.join(__dirname, 'specs/**/*.e2e.mjs')],
  maxInstances: 1,
  baseUrl: BASE_URL,

  capabilities: [{
    'browserName': 'firefox',
    'moz:firefoxOptions': {
      args: [
        '-headless',
        // Never hand off to, or disturb, a Firefox the developer is already
        // running. Same reasoning as tools/launch-ff.mjs.
        '-no-remote',
        '-new-instance',
      ],
      prefs: {
        'browser.shell.checkDefaultBrowser': false,
        // The suite calls play() itself, but autoplay blocking would still
        // reject that promise without a user gesture.
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        // Headless CI has no audio device.
        'media.volume_scale': '0.0',
      },
    },
  }],

  logLevel: 'error',
  // Without an outputDir wdio keeps its driver logs in memory and CI's
  // "upload e2e failure logs" step collects nothing, which is worse than no
  // step at all: it looks like diagnostics exist when they do not.
  outputDir: path.join(root, 'logs'),
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    // Loading real streams over the network is slow, deliberately: the point
    // is that a real player really decodes real bytes.
    timeout: 120000,
  },

  onPrepare: async function() {
    await ensureMp4Fixture();
    await ensureWebmFixture();
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
        // Fixtures are served from the same origin as the player page on
        // purpose - see ensureMp4Fixture.
        const base = rel.startsWith('/fixtures/') ? fixturesDir : webBuildDir;
        const sub = rel.startsWith('/fixtures/') ?
          rel.slice('/fixtures'.length) : rel;
        // Contain path traversal: resolve, then require the result to stay
        // inside the directory we meant to serve.
        const abs = path.resolve(base, '.' + sub);
        if (!abs.startsWith(base) || !fs.existsSync(abs) ||
            fs.statSync(abs).isDirectory()) {
          res.writeHead(404);
          return res.end('not found');
        }
        const size = fs.statSync(abs).size;
        const headers = {
          'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
          // The player uses SharedArrayBuffer-backed workers in some paths.
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Access-Control-Allow-Origin': '*',
          'Accept-Ranges': 'bytes',
        };

        // Range support is required, not optional: FastStream's accelerated
        // MP4 mode does its own range-based buffering, and a server that
        // ignores Range and returns 200 with the whole body makes that mode
        // fail in ways that look like a decoder bug.
        const range = req.headers.range;
        const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (match) {
          const start = match[1] ? parseInt(match[1], 10) : 0;
          // RFC 7233: an end past the last byte is clamped, not rejected.
          // FastStream asks for ranges that overshoot the file end, so
          // answering those with 416 breaks the MP4 path with "First fragment
          // failed to load" - which reads like a decoder fault and is not.
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

  // A headless CI failure gives you a timeout message and nothing else. A
  // screenshot distinguishes the cases that matter and look identical from the
  // message alone: the page never loaded, the player rendered but no video
  // element appeared, or the video is there and simply not decoding.
  afterTest: async function(test, context, {passed}) {
    if (passed) return;
    const dir = path.join(root, 'logs');
    fs.mkdirSync(dir, {recursive: true});
    const safe = test.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
    try {
      await browser.saveScreenshot(path.join(dir, `fail-${safe}.png`));
    } catch {
      // A screenshot is a diagnostic aid; failing to take one must not
      // replace the real test failure with a confusing error from here.
    }
  },

  onComplete: function() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.close(resolve);
    });
  },
};
