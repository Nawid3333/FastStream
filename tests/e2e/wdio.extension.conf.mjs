// Drives the AMO build as an INSTALLED EXTENSION, not as a web page.
//
// Why this exists separately from wdio.conf.mjs
// ---------------------------------------------
// The playback and module suites load built/web over http. That is the right
// harness for "does this library still work", but it cannot see anything that
// only happens under an extension origin:
//
//   - the manifest's content_security_policy applies to extension pages only,
//     so `script-src 'self' 'wasm-unsafe-eval'` is never enforced over http.
//     Every wasm module in this extension - ONNX Runtime's -
//     compiles unchecked in the other suite.
//   - the background script is not loaded at all over http, so nothing has
//     ever confirmed it starts without throwing.
//   - moz-extension:// is an opaque origin with different rules for workers,
//     blob URLs and dynamic import than http://127.0.0.1.
//
// This config installs the built AMO zip into a throwaway profile and runs
// against moz-extension://. It never touches the developer's own Firefox: the
// same -no-remote / -new-instance guard as tools/launch-ff.mjs, and a profile
// geckodriver creates and discards.
//
// Run with: pnpm run test:ext (the AMO build), or pnpm run test:ext:github
// for the GitHub self-host build. FS_EXT_BUILD picks the package for this
// config and for the classic and private-browsing configs built on it.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {recordRetriedSpecs} from './retriedSpecs.mjs';
import {shardSpecs} from './shardSpecs.mjs';
import {listenOrStop} from './listen-or-stop.mjs';
import {speedAfterTest, speedBeforeTest} from './speedWatch.mjs';
import {testTimeout} from './testTimeout.mjs';
import {ensureBidi} from './bidi.mjs';
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

// Firefox assigns each installed extension a random moz-extension:// UUID, so
// a test cannot guess its own pages' URLs. This pref pins it. The value has to
// be a JSON *string*, keyed by the add-on id from build.mjs.
export const EXTENSION_ID = 'thanatus@Nawid';
export const EXTENSION_UUID = 'f45ea7c1-3b2d-4a19-9c6e-8d5b0f2a7e34';

// Which build to install: 'amo' (default) or 'github'. Both are shipped, and
// they differ in more than the manifest - the GitHub build keeps the update
// checker (NO_UPDATE_CHECKER only splices the AMO one) and asks for
// contextualIdentities - so passing on one says nothing about the other.
// BUILD is one of the two names, never the variable's own text: it goes into log file
// names (CodeQL js/path-injection, local sources).
const requestedBuild = process.env.FS_EXT_BUILD || 'amo';
export const BUILD = ['amo', 'github'].find((build) => build === requestedBuild);
if (!BUILD) {
  throw new Error(`FS_EXT_BUILD must be 'amo' or 'github', not '${requestedBuild}'`);
}

// Found rather than named, so a version bump does not silently stop this
// suite from running against the package it is meant to test.
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

// geckodriver refuses WebDriver:Navigate to moz-extension:// - it treats the
// extension origin as privileged. But `player/index.html` is declared in
// web_accessible_resources for <all_urls>, so an ordinary web page is allowed
// to open it. This server exists only to be that page.
export const PORT = 41991;
export const OPENER_URL = `http://127.0.0.1:${PORT}/`;
let server;

// save-flow, save-dialog-regression and save-transport trigger real
// downloads through the extension's DOWNLOAD handler. Without an explicit
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
  // All of them, or E2E_SHARD's group (shardSpecs.mjs).
  specs: shardSpecs(path.join(__dirname, 'ext-specs')),
  maxInstances: 1,

  capabilities: [{
    'browserName': 'firefox',
    // An extension page is a privileged browsing context, and both driver
    // protocols guard it: classic WebDriver refuses executeScript there
    // outright, and BiDi wants Firefox started with
    // --remote-allow-system-access, which geckodriver will not accept through
    // capabilities. Passing it to geckodriver itself is the way in.
    'wdio:geckodriverOptions': {
      allowSystemAccess: true,
    },
    'moz:firefoxOptions': {
      // Another Firefox to test, e.g. Beta in .github/workflows/firefox-beta.yml.
      ...(process.env.FIREFOX_BINARY ? {binary: process.env.FIREFOX_BINARY} : {}),
      args: ['-headless', '-no-remote', '-new-instance'],
      prefs: {
        'browser.shell.checkDefaultBrowser': false,
        // Web pages' and the extension's console calls go to Firefox's stdout, which
        // geckodriver writes into this spec's driver log (kept per spec and attempt,
        // driverLogs.mjs): the background's debug lines, on for this temporary install,
        // show what it did in a failed run. background-log.e2e.mjs checks both.
        'devtools.console.stdout.content': true,
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.volume_scale': '0.0',
        // An optional permission asked for from a click (the player's Firefox VPN button,
        // firefox-vpn.e2e.mjs) is granted without the doorhanger, which WebDriver cannot
        // answer. The click is still required: Firefox refuses a request without one.
        'extensions.webextOptionalPermissionPrompts': false,
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
    // The specs' fixtures (sample.mp4, and long-av.mp4 and hls-ts for source-length):
    // `pnpm run test:ext` alone, on a fresh clone, has no web suite run before it to make
    // them. Made already, they cost a check of their recipes.
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

        // /fixtures/<name> serves the shared binary fixtures so the
        // embedded-player specs can load real media. CORS is required: the
        // player runs in a moz-extension:// iframe (partitioned), and a
        // partitioned frame's fetches do not get the extension's host-
        // permission CORS bypass. The accelerated players fetch with a
        // Range header, which is not CORS-safelisted, so preflight must be
        // answered too or every fragment download fails before it starts.
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
          // Byte ranges, as wdio.conf.mjs's server and any video host answer them. This
          // sent the whole file with 200 for every Range: on the 1 MB sample.mp4, which
          // fits MP4Player's first range, nothing showed that a second range would have
          // got the file's start instead (#257).
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

        // /embed serves an ordinary web page that embeds the extension's
        // player page in a cross-origin iframe - the partitioned context
        // real sites put the player in, and the one Firefox's blob-isolation
        // bug (bugzilla 1917842) breaks downloads from.
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

  afterTest: async function(test, context, {passed}) {
    await speedAfterTest(test, passed);
  },

  // A failure here fails every test of the spec file (setupGuard.mjs): without the add-on,
  // a spec that checks the player does not open would pass.
  before: async function() {
    await guardSetup(async () => {
      // Each spec file's attempt starts with no downloads: a retry's save otherwise went
      // to "name(1).png" beside the first attempt's file, and the spec read that one.
      resetDownloadDir();
      // Before the add-on: a browser started again has none. (The classic and pbm suites
      // share this hook and ask for classic, which it leaves alone.)
      await ensureBidi();
      // Temporary rather than permanent: the package is unsigned, and a
      // temporary install is exactly how a reviewer or a developer loads it.
      await browser.installAddOn(fs.readFileSync(XPI).toString('base64'), true);
      // Specs navigate to the harness server for the embed page; the trailing
      // slash matters (it makes 'embed?...' append correctly).
      globalThis.__EXT_OPENER_URL__ = OPENER_URL.endsWith('/') ? OPENER_URL : OPENER_URL + '/';
      // Specs load real media through the harness server; the MP4 fixture is
      // what the accelerated-MP4 specs drive.
      globalThis.__EXT_FIXTURE_MP4__ = globalThis.__EXT_OPENER_URL__ + 'fixtures/sample.mp4';
    });
  },
};
