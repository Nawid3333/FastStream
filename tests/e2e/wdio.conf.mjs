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

// save-video.e2e.mjs triggers real browser downloads. Without an explicit
// download directory, Firefox uses its normal one - the developer's actual
// Downloads folder - and every run leaves files behind there. Wiped both
// before and after the run, so a crashed previous run can't leave stale
// files either.
const downloadDir = path.join(root, '.e2e-downloads');
function resetDownloadDir() {
  fs.rmSync(downloadDir, {recursive: true, force: true});
  fs.mkdirSync(downloadDir, {recursive: true});
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

/**
 * Runs ffmpeg, and fails with what it said.
 * @param {string[]} args - Its arguments.
 * @param {string} what - The fixture, for the message.
 * @param {string} [cwd] - Where to run it; a DASH manifest names its files relative to it.
 * @return {boolean} Whether it ran without error.
 */
function runFfmpeg(args, what, cwd) {
  const {status, error, stderr} = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], {cwd, encoding: 'utf8'});
  if (status !== 0) {
    throw new Error(
        `could not build the ${what} fixture with ffmpeg` +
        `${error ? ` (${error.message})` : ''}. CI installs ffmpeg; ` +
        `locally it must be on PATH.
${stderr || ''}`,
    );
  }
  return true;
}

// 160 s of the MP4 fixture's picture over a steady tone: long enough for 16x to still have
// something to play (firefox.e2e.mjs) and for 60 s seeks either way (keybinds.e2e.mjs).
const LONG_AV_FIXTURE = path.join(fixturesDir, 'long-av.mp4');

function ensureLongAvFixture() {
  if (fs.existsSync(LONG_AV_FIXTURE) && fs.statSync(LONG_AV_FIXTURE).size > 0) return;
  runFfmpeg([
    '-stream_loop', '15', '-i', MP4_FIXTURE,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=160',
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k', '-shortest',
    '-movflags', '+faststart', LONG_AV_FIXTURE,
  ], 'long audio');
}

/**
 * Picks the H.264 encoder this ffmpeg has: libx264 on Linux CI, libopenh264 in the Windows
 * builds.
 * @param {string} what - The fixture that needs it, for the message.
 * @return {string} The encoder's name.
 */
function h264Encoder(what) {
  const {stdout} = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], {encoding: 'utf8'});
  const encoder = ['libx264', 'libopenh264'].find((name) => (stdout || '').split(/\r?\n/).some((line) => line.trim().split(/\s+/)[1] === name));
  if (!encoder) {
    throw new Error(`ffmpeg has neither libx264 nor libopenh264 for the ${what} fixture`);
  }
  return encoder;
}

// 96 frames at exactly 24 fps, every picture different, for the frame step
// (keybinds.e2e.mjs): at 24 fps one frame is 1/24 s, which the old fixed 1/30 s step
// could not reach.
const FRAMES_24_FIXTURE = path.join(fixturesDir, 'frames-24fps.mp4');

function ensureFrames24Fixture() {
  if (fs.existsSync(FRAMES_24_FIXTURE) && fs.statSync(FRAMES_24_FIXTURE).size > 0) return;
  runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=4',
    '-c:v', h264Encoder('24 fps'), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', FRAMES_24_FIXTURE,
  ], '24 fps');
}

// One local DASH stream per way a manifest can list its segments. dash.js reads each with
// its own segment getter, and FastStream's dash.js patch adds getAllSegments() to every one
// of them: DashPlayer.mjs builds its fragment list from it.
//
// A SegmentTemplate or SegmentList with a fixed @duration defines the segments' times by
// arithmetic, so the segments have to really be 2 s long: the video is re-encoded with a
// keyframe every 2 s, and all of it is 9 s long, which makes 5 segments of each track in
// every packaging - ceil(9 / 2), as dash.js counts them.
//
// Each directory also gets expected.json - what the segments are, read from the files
// ffmpeg wrote, not from dash.js - for playback.e2e.mjs to check the fragment list against.
const DASH_FIXTURES = {
  'dash-template': ['-use_template', '1', '-use_timeline', '0'],
  'dash-list': ['-use_template', '0', '-use_timeline', '0'],
  'dash-timeline': ['-use_template', '1', '-use_timeline', '1'],
  // ffmpeg writes this one as a SegmentList of byte ranges; ensureDashFixtures rewrites it
  // to the SegmentBase + sidx form, since ffmpeg cannot.
  'dash-base': ['-single_file', '1', '-global_sidx', '1', '-use_template', '0', '-use_timeline', '0'],
};

/**
 * Lists the top-level boxes of an MP4 file.
 * @param {Buffer} buf - The file.
 * @return {Array<{type: string, start: number, size: number}>}
 */
function topLevelBoxes(buf) {
  const boxes = [];
  for (let pos = 0; pos + 8 <= buf.length;) {
    let size = buf.readUInt32BE(pos);
    if (size === 1) size = Number(buf.readBigUInt64BE(pos + 8));
    if (size < 8) throw new Error(`bad box size ${size} at ${pos}`);
    boxes.push({type: buf.toString('latin1', pos + 4, pos + 8), start: pos, size});
    pos += size;
  }
  return boxes;
}

/**
 * Reads the media byte ranges a single-file representation's sidx lists.
 * @param {string} file - The representation's file.
 * @return {{init: string, index: string, ranges: string[]}} Its SegmentBase ranges.
 */
function sidxRanges(file) {
  const buf = fs.readFileSync(file);
  const boxes = topLevelBoxes(buf);
  const sidx = boxes.find((box) => box.type === 'sidx');
  if (!sidx || boxes[boxes.indexOf(sidx) - 1]?.type !== 'moov') {
    throw new Error(`${file}: expected a sidx right after the moov`);
  }
  let p = sidx.start + 8;
  const version = buf[p];
  p += 4 + 4 + 4; // version/flags, reference_ID, timescale
  let firstOffset;
  if (version === 0) {
    p += 4; // earliest_presentation_time
    firstOffset = buf.readUInt32BE(p);
    p += 4;
  } else {
    p += 8;
    firstOffset = Number(buf.readBigUInt64BE(p));
    p += 8;
  }
  p += 2; // reserved
  const count = buf.readUInt16BE(p);
  p += 2;
  const ranges = [];
  let offset = sidx.start + sidx.size + firstOffset;
  for (let i = 0; i < count; i++, p += 12) {
    const size = buf.readUInt32BE(p) & 0x7fffffff;
    ranges.push(`${offset}-${offset + size - 1}`);
    offset += size;
  }
  return {init: `0-${sidx.start - 1}`, index: `${sidx.start}-${sidx.start + sidx.size - 1}`, ranges};
}

function ensureDashFixtures() {
  for (const [name, packaging] of Object.entries(DASH_FIXTURES)) {
    const dir = path.join(fixturesDir, name);
    const expectedFile = path.join(dir, 'expected.json');
    // Written last, so a run killed half way builds the fixture again.
    if (fs.existsSync(expectedFile)) continue;

    fs.rmSync(dir, {recursive: true, force: true});
    fs.mkdirSync(dir, {recursive: true});
    const mpd = path.join(dir, 'manifest.mpd');
    runFfmpeg([
      '-i', MP4_FIXTURE, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-map', '0:v', '-map', '1:a', '-t', '9',
      '-c:v', h264Encoder(name), '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*2)',
      '-c:a', 'aac', '-b:a', '64k',
      '-f', 'dash', '-seg_duration', '2', ...packaging,
      '-adaptation_sets', 'id=0,streams=v id=1,streams=a', 'manifest.mpd',
    ], name, dir);

    // ffmpeg names the representations 0 (video) and 1 (audio); DashTrackUtils makes the
    // level IDs "<type>-<representation id>" out of them.
    const expected = {};
    for (const [level, id] of [['video-0', 0], ['audio-1', 1]]) {
      if (name === 'dash-base') {
        const {init, index, ranges} = sidxRanges(path.join(dir, `manifest-stream${id}.mp4`));
        expected[level] = {ranges};
        const text = fs.readFileSync(mpd, 'utf8');
        const list = new RegExp(`(<BaseURL>manifest-stream${id}\\.mp4</BaseURL>\\s*)<SegmentList[\\s\\S]*?</SegmentList>`);
        if (!list.test(text)) throw new Error(`${name}: no SegmentList for representation ${id}`);
        fs.writeFileSync(mpd, text.replace(list,
            `$1<SegmentBase indexRange="${index}"><Initialization range="${init}" /></SegmentBase>`));
      } else {
        expected[level] = {
          media: fs.readdirSync(dir).filter((f) => f.startsWith(`chunk-stream${id}-`)).sort(),
        };
      }
    }
    fs.writeFileSync(expectedFile, JSON.stringify(expected, null, 2));
  }
}

if (!fs.existsSync(path.join(webBuildDir, 'player', 'index.html'))) {
  throw new Error(
      `Web build not found at ${webBuildDir}\nRun: pnpm run build:keep`,
  );
}

export const config = {
  runner: 'local',
  // Firefox runs -headless, so no X display is needed; without this the Linux runner starts
  // every worker through xvfb-run, whose Ubuntu 26.04 version (xorg 21.1.22) closes fd 3 -
  // the worker's IPC channel - and every worker dies with "write EINVAL"
  // (webdriverio/webdriverio#15685, unfixed as of 9.32.0). ubuntu-latest moves to 26.04 in
  // November 2026.
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
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    // Loading real streams over the network is slow, deliberately: the point
    // is that a real player really decodes real bytes.
    timeout: 120000,
  },

  // The specs need to reference the local server's origin for same-origin
  // fixture URLs (see the MP4 stream in playback.e2e.mjs). The two configs
  // listen on different ports, so it is exposed here rather than hardcoded
  // in the spec.
  before: function() {
    globalThis.__E2E_FIXTURES_ORIGIN__ = BASE_URL;
  },

  onPrepare: async function() {
    resetDownloadDir();
    await ensureMp4Fixture();
    await ensureWebmFixture();
    ensureLongAvFixture();
    ensureFrames24Fixture();
    ensureDashFixtures();
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
    fs.rmSync(downloadDir, {recursive: true, force: true});
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.close(resolve);
    });
  },
};
