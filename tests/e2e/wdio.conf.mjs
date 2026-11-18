// WebdriverIO config for the end-to-end playback suite.
// It drives the web build (built/web): the same players and vendored libraries through the same
// entry point, without the background, interception or manifest (the installed-extension suites
// cover those; docs/notes/playback-testing.md says why).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {recordRetriedSpecs} from './retriedSpecs.mjs';
import {shardSpecs} from './shardSpecs.mjs';
import {mozLogHooks} from './mozLog.mjs';
import {testTimeout} from './testTimeout.mjs';
import {listenOrStop} from './listen-or-stop.mjs';
import {speedAfterTest, speedBeforeTest} from './speedWatch.mjs';
import {ensureBidi} from './bidi.mjs';
import {restoreSwitchFrame} from './switchFrame.mjs';
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

// Downloads go here, not the developer's own Downloads folder; wiped before and after the run.
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
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
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
  // Firefox runs -headless; xvfb-run on Ubuntu 26.04 closes the worker's IPC fd (workflows.md).
  autoXvfb: false,
  // A failing spec file runs once more in a fresh browser: a real bug fails twice and still fails
  // the run.
  specFileRetries: 1,
  // All of them, or E2E_SHARD's group (shardSpecs.mjs).
  specs: shardSpecs(path.join(__dirname, 'specs')),
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
        // Never hand off to, or disturb, a Firefox the developer is already running.
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
  // Without an outputDir wdio keeps its driver logs in memory and CI's failure-log upload finds
  // nothing.
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

  // The specs need the local server's origin; the configs listen on different ports.
  before: async function() {
    await guardSetup(async () => {
      // Each spec file's attempt starts with no downloads, as in wdio.extension.conf.mjs.
      resetDownloadDir();
      await ensureBidi();
      // switchFrame for BiDi sessions, which WebdriverIO 10 dropped (switchFrame.mjs).
      restoreSwitchFrame(browser);
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

        // Range is required: accelerated MP4 buffers by range, and a whole-body 200 fails like a
        // decoder bug.
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

  // A failed test's screenshot tells apart: page never loaded, no video element, or a video not
  // decoding.
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
      // A screenshot that fails must not replace the real test failure.
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
