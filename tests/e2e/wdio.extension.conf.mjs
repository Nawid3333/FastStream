// Drives the AMO build as an installed extension: what only happens under an extension origin
// (the manifest's CSP, the background script, moz-extension:// rules for workers, blobs and
// import).
// A throwaway profile, never the developer's own Firefox (-no-remote / -new-instance, as
// tools/launch-ff.mjs).
// pnpm run test:ext (AMO) or test:ext:github; FS_EXT_BUILD picks the package, also for the classic
// and pbm configs.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {recordRetriedSpecs} from './retriedSpecs.mjs';
import {shardSpecs} from './shardSpecs.mjs';
import {listenOrStop} from './listen-or-stop.mjs';
import {mozLogHooks} from './mozLog.mjs';
import {speedAfterTest, speedBeforeTest} from './speedWatch.mjs';
import {testTimeout} from './testTimeout.mjs';
import {ensureBidi} from './bidi.mjs';
import {restoreSwitchFrame} from './switchFrame.mjs';
import {guardSetup, rootHooks} from './setupGuard.mjs';
import {ensureMp4Fixture} from './mp4Fixture.mjs';
import {ensureFixtures} from './buildFixtures.mjs';
import {byteRange, decodePath, sendFile} from './serveFile.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../..');
const fixturesDir = path.join(__dirname, '..', 'e2e', 'fixtures');

// MIME types for the fixture files served to the embedded-player specs.
const FIXTURE_MIME = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// Pins the random moz-extension:// UUID (a JSON string keyed by the add-on id) so specs know their
// pages' URLs.
export const EXTENSION_ID = 'thanatus@Nawid';
export const EXTENSION_UUID = 'f45ea7c1-3b2d-4a19-9c6e-8d5b0f2a7e34';

// 'amo' (default) or 'github': the builds differ in more than the manifest (update checker,
// contextualIdentities).
// BUILD is one of the two names, never the variable's text: it goes into log file names (CodeQL
// js/path-injection).
const requestedBuild = process.env.FS_EXT_BUILD || 'amo';
export const BUILD = ['amo', 'github'].find((build) => build === requestedBuild);
if (!BUILD) {
  throw new Error(`FS_EXT_BUILD must be 'amo' or 'github', not '${requestedBuild}'`);
}

// Found rather than named, so a version bump does not stop the suite testing its package.
const builtDir = path.join(root, 'built');
const packages = fs.existsSync(builtDir) ?
  fs.readdirSync(builtDir).filter(
      (f) => f.startsWith(`firefox-${BUILD}-`) && f.endsWith('.zip')) :
  [];

if (packages.length !== 1) {
  throw new Error(
      `Expected exactly one firefox-${BUILD}-*.zip in ${builtDir}, found ` +
      `${packages.length}${packages.length ? ': ' + packages.join(', ') : ''}.` +
      ' Run: pnpm run build:keep');
}

export const XPI = path.join(builtDir, packages[0]);

// geckodriver refuses to navigate to moz-extension://, but player/index.html is web-accessible:
// this server is the page that opens it.
export const PORT = 41991;
export const OPENER_URL = `http://127.0.0.1:${PORT}/`;
let server;

// The save specs download for real: into this folder, not the developer's, wiped before and after
// the run.
const downloadDir = path.join(root, '.e2e-downloads');

// Firefox's own log for the specs listed in mozLog.mjs, when E2E_MOZ_LOG=1 (CI's Windows
// steps); an attempt that passes deletes its own.
const mozLog = mozLogHooks(path.join(root, 'logs-moz'));
function resetDownloadDir() {
  fs.mkdirSync(downloadDir, {recursive: true});
  // Emptied in place: a spec file's setup runs this too (before), with Firefox already
  // pointed at the folder.
  for (const name of fs.readdirSync(downloadDir)) {
    fs.rmSync(path.join(downloadDir, name), {recursive: true, force: true});
  }
}

export const config = {
  runner: 'local',
  // Firefox runs -headless; xvfb-run on Ubuntu 26.04 closes the worker's IPC fd (workflows.md).
  autoXvfb: false,
  // A failing spec file runs once more in a fresh browser: a real bug fails twice and still fails
  // the run.
  specFileRetries: 1,
  // All of them, or E2E_SHARD's group (shardSpecs.mjs).
  specs: shardSpecs(path.join(__dirname, 'ext-specs')),
  maxInstances: 1,

  capabilities: [{
    'browserName': 'firefox',
    // Extension pages are privileged: BiDi needs --remote-allow-system-access, which geckodriver
    // takes only as its own arg.
    'wdio:geckodriverOptions': {
      allowSystemAccess: true,
    },
    'moz:firefoxOptions': {
      // Another Firefox to test, e.g. Beta in .github/workflows/firefox-beta.yml.
      ...(process.env.FIREFOX_BINARY ? {binary: process.env.FIREFOX_BINARY} : {}),
      args: ['-headless', '-no-remote', '-new-instance'],
      prefs: {
        'browser.shell.checkDefaultBrowser': false,
        // Console calls go to stdout, so into the spec's driver log: the background's debug lines
        // (background-log.e2e.mjs).
        'devtools.console.stdout.content': true,
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.volume_scale': '0.0',
        // An optional permission asked for from a click (the player's Firefox VPN button,
        // firefox-vpn.e2e.mjs) is granted without the doorhanger, which WebDriver cannot
        // answer. The click is still required: Firefox refuses a request without one.
        'extensions.webextOptionalPermissionPrompts': false,
        // Firefox's chooser of audio outputs (selectAudioOutput, audio-output.e2e.mjs) is
        // answered with the first device, which WebDriver could not pick. A click is still needed.
        'media.navigator.permission.disabled': true,
        // Pins the extension origin so the specs can address its pages.
        'extensions.webextensions.uuids':
          JSON.stringify({[EXTENSION_ID]: EXTENSION_UUID}),
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
  outputDir: path.join(root, 'logs'),
  // Each spec's and each retry's driver log kept under its own name: see driverLogs.mjs.
  // The configs built on this one name their own suite.
  onWorkerEnd: recordRetriedSpecs(path.join(root, 'logs'), `ext-${BUILD}`),
  framework: 'mocha',
  reporters: ['spec'],
  // A failed setup, or a session without BiDi, fails every test: setupGuard.mjs.
  mochaOpts: {ui: 'bdd', timeout: testTimeout(120000), rootHooks},

  onPrepare: async function() {
    resetDownloadDir();
    // `pnpm run test:ext` alone on a fresh clone has no web suite run before it to make the
    // fixtures.
    await ensureMp4Fixture();
    await ensureFixtures();
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        const pathname = decodePath((req.url || '/').split('?')[0]);
        if (pathname === null) {
          res.writeHead(400);
          res.end('bad request');
          return;
        }

        // CORS with preflight: the partitioned player frame gets no host-permission bypass, and
        // Range is not safelisted.
        if (pathname.startsWith('/fixtures/')) {
          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, OPTIONS',
              'Access-Control-Allow-Headers': 'Range, Content-Type',
              'Access-Control-Max-Age': '86400',
            });
            res.end();
            return;
          }
          const name = path.basename(pathname);
          const filePath = path.join(fixturesDir, name);
          if (!fs.existsSync(filePath)) {
            res.writeHead(404);
            res.end('not found');
            return;
          }
          const size = fs.statSync(filePath).size;
          const headers = {
            'Content-Type': FIXTURE_MIME[path.extname(name)] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
            'Accept-Ranges': 'bytes',
          };
          // Byte ranges, as wdio.conf.mjs's server and any video host answer them.
          const range = byteRange(req.headers.range, size);
          if (range === 'unsatisfiable') {
            res.writeHead(416, {...headers, 'Content-Range': `bytes */${size}`});
            res.end();
            return;
          }
          if (range) {
            res.writeHead(206, {
              ...headers,
              'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
              'Content-Length': range.end - range.start + 1,
            });
            sendFile(res, filePath, range);
            return;
          }
          res.writeHead(200, {...headers, 'Content-Length': size});
          sendFile(res, filePath);
          return;
        }

        // A page with the player in a cross-origin iframe: the partitioned context of real sites
        // (bugzilla 1917842).
        if (pathname === '/embed') {
          const extOrigin = `moz-extension://${EXTENSION_UUID}`;
          res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
          res.end(`<!doctype html><title>embed</title>` +
              `<iframe id="fs" src="${extOrigin}/player/index.html?t=${Date.now()}">` +
              `</iframe>`);
          return;
        }

        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<!doctype html><title>opener</title>');
      });
      listenOrStop(server, PORT, resolve);
    });
  },

  onComplete: function() {
    fs.rmSync(downloadDir, {recursive: true, force: true});
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.close(resolve);
    });
  },

  // The player's speed preset keys: see speedWatch.mjs.
  beforeTest: async function(test) {
    await speedBeforeTest(test);
  },

  afterTest: async function(test, context, result) {
    mozLog.afterTest(test, context, result);
    await speedAfterTest(test, result.passed);
  },

  // Firefox's own log for the specs listed in mozLog.mjs (the const above).
  beforeSession: mozLog.beforeSession,
  afterHook: mozLog.afterHook,
  afterSession: mozLog.afterSession,

  // A failure here fails every test of the spec file (setupGuard.mjs): without the add-on,
  // a spec that checks the player does not open would pass.
  before: async function() {
    await guardSetup(async () => {
      // Each attempt starts with no downloads: a retry's save would go to "name(1).png" beside the
      // first one.
      resetDownloadDir();
      // Before the add-on: a browser started again has none. (The classic and pbm suites
      // share this hook and ask for classic, which it leaves alone.)
      await ensureBidi();
      // switchFrame for BiDi sessions, which WebdriverIO 10 dropped (switchFrame.mjs).
      restoreSwitchFrame(browser);
      // Temporary: the package is unsigned, and that is how a reviewer or developer loads it.
      await browser.installAddOn(fs.readFileSync(XPI).toString('base64'), true);
      // the trailing slash makes 'embed?...' append correctly
      globalThis.__EXT_OPENER_URL__ = OPENER_URL.endsWith('/') ? OPENER_URL : OPENER_URL + '/';
      // the MP4 fixture the accelerated-MP4 specs drive
      globalThis.__EXT_FIXTURE_MP4__ = globalThis.__EXT_OPENER_URL__ + 'fixtures/sample.mp4';
    });
  },
};
