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
//     Every wasm module in this extension - libsamplerate, ONNX Runtime -
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
// Run with: pnpm run test:ext

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../..');

// Firefox assigns each installed extension a random moz-extension:// UUID, so
// a test cannot guess its own pages' URLs. This pref pins it. The value has to
// be a JSON *string*, keyed by the add-on id from build.mjs.
export const EXTENSION_ID = 'thanatus@Nawid';
export const EXTENSION_UUID = 'f45ea7c1-3b2d-4a19-9c6e-8d5b0f2a7e34';

// Found rather than named, so a version bump does not silently stop this
// suite from running against the package it is meant to test.
const builtDir = path.join(root, 'built');
const packages = fs.existsSync(builtDir) ?
  fs.readdirSync(builtDir).filter(
      (f) => f.startsWith('firefox-amo-') && f.endsWith('.zip')) :
  [];

if (packages.length !== 1) {
  throw new Error(
      `Expected exactly one firefox-amo-*.zip in ${builtDir}, found ` +
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

export const config = {
  runner: 'local',
  specs: [path.join(__dirname, 'ext-specs/**/*.e2e.mjs')],
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
      args: ['-headless', '-no-remote', '-new-instance'],
      prefs: {
        'browser.shell.checkDefaultBrowser': false,
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.volume_scale': '0.0',
        // Pins the extension origin so the specs can address its pages.
        'extensions.webextensions.uuids':
          JSON.stringify({[EXTENSION_ID]: EXTENSION_UUID}),
      },
    },
  }],

  logLevel: 'error',
  outputDir: path.join(root, 'logs'),
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {ui: 'bdd', timeout: 120000},

  onPrepare: function() {
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<!doctype html><title>opener</title>');
      });
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
  },

  onComplete: function() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.close(resolve);
    });
  },

  before: async function() {
    // Temporary rather than permanent: the package is unsigned, and a
    // temporary install is exactly how a reviewer or a developer loads it.
    await browser.installAddOn(fs.readFileSync(XPI).toString('base64'), true);
  },
};
