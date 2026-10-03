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

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {recordRetriedSpecs} from './retriedSpecs.mjs';
import {mozLogHooks} from './mozLog.mjs';
import {testTimeout} from './testTimeout.mjs';
import {listenOrStop} from './listen-or-stop.mjs';
import {speedAfterTest, speedBeforeTest} from './speedWatch.mjs';
import {ensureBidi} from './bidi.mjs';
import {guardSetup, rootHooks} from './setupGuard.mjs';
import {ensureMp4Fixture} from './mp4Fixture.mjs';
import {ensureFixtures, readFileOrNothing} from './buildFixtures.mjs';
import {byteRange, decodePath, resolveInside, sendFile} from './serveFile.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../..');
const webBuildDir = path.join(root, 'built', 'web');
const fixturesDir = path.join(__dirname, 'fixtures');

export const PORT = 41879;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
let server;

// Firefox's network log for the specs listed in mozLog.mjs, when E2E_MOZ_LOG=1; an
// attempt that passes deletes its own. Not under logs/, whose upload is for failed jobs:
// a spec that fails once and passes on its retry leaves the job green.
const mozLog = mozLogHooks(path.join(root, 'logs-moz'));

// save-video.e2e.mjs triggers real browser downloads. Without an explicit
// download directory, Firefox uses its normal one - the developer's actual
// Downloads folder - and every run leaves files behind there. Wiped both
// before and after the run, so a crashed previous run can't leave stale
// files either.
const downloadDir = path.join(root, '.e2e-downloads');
function resetDownloadDir() {
  fs.mkdirSync(downloadDir, {recursive: true});
  // Emptied in place: a spec file's setup runs this too (before), with Firefox already
  // pointed at the folder.
  for (const name of fs.readdirSync(downloadDir)) {
    fs.rmSync(path.join(downloadDir, name), {recursive: true, force: true});
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.onnx': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  // The local HLS fixtures, with the types HLS servers send.
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
};

// The read (not existsSync) answers the same question without the gap in between
// (CodeQL js/file-system-race).
if (readFileOrNothing(path.join(webBuildDir, 'player', 'index.html')) === null) {
  throw new Error(
      `Web build not found at ${webBuildDir}\nRun: pnpm run build:keep`,
  );
}

export const config = {
  runner: 'local',
  // Firefox runs -headless, so no X display is needed; without this the Linux runner starts
  // every worker through xvfb-run, whose Ubuntu 26.04 version (xorg 21.1.22) closes fd 3 -
  // the worker's IPC channel - and every worker dies with "write EINVAL"
  // (webdriverio/webdriverio#15685, unfixed as of 9.32.0). ubuntu-latest moves to 26.04 between
  // October 19 and November 19, 2026.
  autoXvfb: false,
  // A spec file that fails is run once more, in a fresh browser (WebdriverIO's documented
  // specFileRetries). The Windows CI runner occasionally runs out of a timing budget on a
  // busy moment - a 6 s streamSaver write, a 30 s player start - with nothing stuck (the
  // specs log their page and OPFS state on the first failure). A real bug fails twice
  // and still fails the run, and so still holds back the release.
  specFileRetries: 1,
  specs: [path.join(__dirname, 'specs/**/*.e2e.mjs')],
  maxInstances: 1,
  baseUrl: BASE_URL,

  capabilities: [{
    'browserName': 'firefox',
    'moz:firefoxOptions': {
      // Another Firefox to test, e.g. Beta in .github/workflows/firefox-beta.yml;
      // otherwise geckodriver finds the installed one.
      ...(process.env.FIREFOX_BINARY ? {binary: process.env.FIREFOX_BINARY} : {}),
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
        // Send downloads straight to downloadDir with no picker and no
        // "where do you want to save this" prompt - see resetDownloadDir.
        'browser.download.folderList': 2,
        'browser.download.dir': downloadDir,
        'browser.download.useDownloadDir': true,
        'browser.helperApps.neverAsk.saveToDisk':
          'video/mp4,video/webm,application/octet-stream',
      },
    },
  }],

  logLevel: 'error',
  // Without an outputDir wdio keeps its driver logs in memory and CI's
  // "upload e2e failure logs" step collects nothing, which is worse than no
  // step at all: it looks like diagnostics exist when they do not.
  outputDir: path.join(root, 'logs'),
  // Each spec's and each retry's driver log kept under its own name: see driverLogs.mjs.
  onWorkerEnd: recordRetriedSpecs(path.join(root, 'logs'), 'web'),
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    // Loading real streams over the network is slow, deliberately: the point
    // is that a real player really decodes real bytes.
    timeout: testTimeout(120000),
    // A failed setup, or a session without BiDi, fails every test: setupGuard.mjs.
    rootHooks,
  },

  // Firefox's network log for the specs listed in mozLog.mjs (the const above).
  beforeSession: mozLog.beforeSession,
  afterHook: mozLog.afterHook,
  afterSession: mozLog.afterSession,

  // The specs need to reference the local server's origin for same-origin
  // fixture URLs (see the MP4 stream in playback.e2e.mjs). The two configs
  // listen on different ports, so it is exposed here rather than hardcoded
  // in the spec.
  before: async function() {
    await guardSetup(async () => {
      // Each spec file's attempt starts with no downloads, as in wdio.extension.conf.mjs.
      resetDownloadDir();
      await ensureBidi();
      globalThis.__E2E_FIXTURES_ORIGIN__ = BASE_URL;
    });
  },

  onPrepare: async function() {
    resetDownloadDir();
    // The MP4 fixture, and the ones made from it: buildFixtures.mjs.
    await ensureMp4Fixture();
    await ensureFixtures();
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        const rel = decodePath(req.url.split('?')[0].split('#')[0]);
        if (rel === null) {
          res.writeHead(400);
          return res.end('bad request');
        }
        // Fixtures are served from the same origin as the player page on
        // purpose - see ensureMp4Fixture.
        const base = rel.startsWith('/fixtures/') ? fixturesDir : webBuildDir;
        const sub = rel.startsWith('/fixtures/') ?
          rel.slice('/fixtures'.length) : rel;
        // Contain path traversal: resolve, then require the result to stay
        // inside the directory we meant to serve.
        const abs = resolveInside(base, sub);
        if (abs === null || !fs.existsSync(abs) ||
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
        const range = byteRange(req.headers.range, size);
        if (range === 'unsatisfiable') {
          res.writeHead(416, {'Content-Range': `bytes */${size}`});
          return res.end();
        }
        if (range) {
          const {start, end} = range;
          res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': end - start + 1,
          });
          return sendFile(res, abs, {start, end});
        }

        res.writeHead(200, {...headers, 'Content-Length': size});
        sendFile(res, abs);
      });
      listenOrStop(server, PORT, resolve);
    });
  },

  // A headless CI failure gives you a timeout message and nothing else. A
  // screenshot distinguishes the cases that matter and look identical from the
  // message alone: the page never loaded, the player rendered but no video
  // element appeared, or the video is there and simply not decoding.
  // The player's speed preset keys: see speedWatch.mjs.
  beforeTest: async function(test) {
    await speedBeforeTest(test);
  },

  afterTest: async function(test, context, result) {
    const {passed} = result;
    mozLog.afterTest(test, context, result);
    await speedAfterTest(test, passed);
    if (passed) return;
    const dir = path.join(root, 'logs');
    fs.mkdirSync(dir, {recursive: true});
    const safe = test.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
    // A failed test's retry fails it again or passes; either way the first attempt's
    // screenshot is kept, and the retry's is numbered.
    let file = path.join(dir, `fail-${safe}.png`);
    for (let n = 2; fs.existsSync(file); n++) {
      file = path.join(dir, `fail-${safe}-${n}.png`);
    }
    try {
      await browser.saveScreenshot(file);
    } catch {
      // A screenshot is a diagnostic aid; failing to take one must not
      // replace the real test failure with a confusing error from here.
    }
  },

  onComplete: function() {
    fs.rmSync(downloadDir, {recursive: true, force: true});
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.close(resolve);
    });
  },
};
