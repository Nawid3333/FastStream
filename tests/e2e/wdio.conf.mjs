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

import {recordRetriedSpecs} from './retriedSpecs.mjs';
import {mozLogHooks} from './mozLog.mjs';
import {testTimeout} from './testTimeout.mjs';
import {listenOrStop} from './listen-or-stop.mjs';
import {speedAfterTest, speedBeforeTest} from './speedWatch.mjs';
import {ensureBidi} from './bidi.mjs';
import {guardSetup, rootHooks} from './setupGuard.mjs';
import {ensureMp4Fixture, MP4_FIXTURE, writeFixture} from './mp4Fixture.mjs';
import {byteRange, decodePath, sendFile} from './serveFile.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../..');
const webBuildDir = path.join(root, 'built', 'web');
const fixturesDir = path.join(__dirname, 'fixtures');

/**
 * Reads a file, or returns null when it is not there: the existsSync-then-read pattern
 * has a gap between the two calls (CodeQL js/file-system-race), a direct read has none
 * and answers the same question.
 * @param {string} file - The file.
 * @return {?string} Its contents, or null when absent.
 */
function readFileOrNothing(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

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

// The MP4 fixture (sample.mp4), which the ones below are made from: mp4Fixture.mjs. The
// fixtures that are one file are written through writeFixture, so a run killed half way
// leaves none half written; the ones that are a directory write their marker file last.

// The WebM fixture is transcoded from the MP4 one rather than downloaded or
// committed: a VP9 file for the save of a DIRECT WebM source (save-video.e2e.mjs).
const WEBM_FIXTURE = path.join(fixturesDir, 'sample.webm');

/**
 * Transcodes the WebM fixture from the MP4 one if it is not already present.
 *
 * @return {Promise<void>}
 */
async function ensureWebmFixture() {
  if (fs.existsSync(WEBM_FIXTURE) && fs.statSync(WEBM_FIXTURE).size > 0) return;
  await writeFixture(WEBM_FIXTURE, (partial) => runFfmpeg([
    '-i', MP4_FIXTURE, '-t', '2',
    '-vf', 'scale=160:120', '-c:v', 'libvpx-vp9', '-b:v', '120k',
    '-cpu-used', '8', partial,
  ], 'WebM'));
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

async function ensureLongAvFixture() {
  if (fs.existsSync(LONG_AV_FIXTURE) && fs.statSync(LONG_AV_FIXTURE).size > 0) return;
  await writeFixture(LONG_AV_FIXTURE, (partial) => runFfmpeg([
    '-stream_loop', '15', '-i', MP4_FIXTURE,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=160',
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k', '-shortest',
    '-movflags', '+faststart', partial,
  ], 'long audio'));
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

async function ensureFrames24Fixture() {
  if (fs.existsSync(FRAMES_24_FIXTURE) && fs.statSync(FRAMES_24_FIXTURE).size > 0) return;
  await writeFixture(FRAMES_24_FIXTURE, (partial) => runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=4',
    '-c:v', h264Encoder('24 fps'), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', partial,
  ], '24 fps'));
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

// Local HLS streams, one per way sites package them: MPEG-TS segments, fMP4 segments with
// an init segment, and a master playlist whose audio is a separate rendition (which
// HLSPlayer loads as its own track). Without them every HLS test streamed from
// test-streams.mux.dev, so HLS went untested whenever that host was out of reach. Encoded
// like the DASH fixtures above - no B-frames, a keyframe every 2 s - so the segments are
// 2 s long on every machine.
//
// Each directory gets expected.json: the playlist to open, and the segments each media
// playlist lists, read from the playlists ffmpeg wrote. HLSPlayer names its levels
// "<track>:<index>" - track 0 is the video (with its audio, if muxed), track 1 an audio
// rendition.
const HLS_FIXTURES = {
  'hls-ts': {segmentType: 'mpegts', ext: 'ts'},
  'hls-fmp4': {segmentType: 'fmp4', ext: 'm4s'},
  'hls-audio': {segmentType: 'fmp4', ext: 'm4s', separateAudio: true},
};

function ensureHlsFixtures() {
  for (const [name, {segmentType, ext, separateAudio}] of Object.entries(HLS_FIXTURES)) {
    const dir = path.join(fixturesDir, name);
    const expectedFile = path.join(dir, 'expected.json');
    // Written last, so a run killed half way builds the fixture again. Read (not
    // existsSync first): another process finishing between the two calls would be a
    // rebuild of the same fixture, and the catch re-runs it either way
    // (CodeQL js/file-system-race).
    if (readFileOrNothing(expectedFile) !== null) continue;

    fs.rmSync(dir, {recursive: true, force: true});
    fs.mkdirSync(dir, {recursive: true});
    const packaging = ['-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', segmentType];
    if (segmentType === 'fmp4') {
      packaging.push('-hls_fmp4_init_filename', 'init.mp4');
    }
    const output = separateAudio ?
      ['-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud,default:yes', '-master_pl_name', 'master.m3u8',
        '-hls_segment_filename', `stream_%v/seg-%03d.${ext}`, 'stream_%v/index.m3u8'] :
      ['-hls_segment_filename', `seg-%03d.${ext}`, 'index.m3u8'];
    runFfmpeg([
      '-i', MP4_FIXTURE, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-map', '0:v', '-map', '1:a', '-t', '9',
      '-c:v', h264Encoder(name), '-pix_fmt', 'yuv420p', '-bf', '0', '-sc_threshold', '0',
      '-force_key_frames', 'expr:gte(t,n_forced*2)',
      '-c:a', 'aac', '-b:a', '64k',
      ...packaging, ...output,
    ], name, dir);

    const segments = (playlist) => fs.readFileSync(path.join(dir, playlist), 'utf8')
        .split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
    const levels = separateAudio ?
      {'0:0': {media: segments('stream_0/index.m3u8')}, '1:0': {media: segments('stream_1/index.m3u8')}} :
      {'0:0': {media: segments('index.m3u8')}};
    fs.writeFileSync(expectedFile, JSON.stringify({
      playlist: separateAudio ? 'master.m3u8' : 'index.m3u8',
      levels,
    }, null, 2));
  }
}

// sample.mp4's own H.264 - High profile, 300 frames, 250 of them B-frames - cut into
// fragments without re-encoding, so it is the same bytes on every platform. The DASH
// fixtures above are re-encoded without B-frames, because libopenh264 (a local Windows
// ffmpeg) cannot make them and libx264 (CI) would: a test that needs B-frames uses this
// one. For modules.e2e.mjs's MP4Demuxer test.
const FMP4_BFRAMES_DIR = path.join(fixturesDir, 'fmp4-bframes');

function ensureBframesFixture() {
  const done = path.join(FMP4_BFRAMES_DIR, '.complete');
  if (readFileOrNothing(done) !== null) return;
  fs.rmSync(FMP4_BFRAMES_DIR, {recursive: true, force: true});
  fs.mkdirSync(FMP4_BFRAMES_DIR, {recursive: true});
  runFfmpeg([
    '-i', MP4_FIXTURE, '-map', '0:v', '-c:v', 'copy',
    '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1', 'manifest.mpd',
  ], 'B-frame fMP4', FMP4_BFRAMES_DIR);
  fs.writeFileSync(done, '');
}

// VP9 and Opus in WebM segments, as YouTube-style DASH serves them: MP4Merger cannot join
// WebM, so a save of it goes through the remuxer (remuxer.mjs), which copies both into an
// MP4. The tone is 440 Hz, a keyframe every 2 s starts each segment. For save-fmp4.e2e.mjs
// and modules.e2e.mjs.
const DASH_WEBM_DIR = path.join(fixturesDir, 'dash-webm');

function ensureDashWebmFixture() {
  const done = path.join(DASH_WEBM_DIR, '.complete');
  if (readFileOrNothing(done) !== null) return;
  fs.rmSync(DASH_WEBM_DIR, {recursive: true, force: true});
  fs.mkdirSync(DASH_WEBM_DIR, {recursive: true});
  runFfmpeg([
    '-i', MP4_FIXTURE, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-map', '0:v', '-map', '1:a', '-t', '9',
    '-vf', 'scale=320:180', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-cpu-used', '8', '-row-mt', '1',
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-c:a', 'libopus', '-b:a', '64k',
    '-f', 'dash', '-dash_segment_type', 'webm', '-seg_duration', '2',
    '-use_template', '1', '-use_timeline', '1',
    '-adaptation_sets', 'id=0,streams=v id=1,streams=a', 'manifest.mpd',
  ], 'VP9 + Opus DASH', DASH_WEBM_DIR);
  fs.writeFileSync(done, '');
}

function ensureDashFixtures() {
  for (const [name, packaging] of Object.entries(DASH_FIXTURES)) {
    const dir = path.join(fixturesDir, name);
    const expectedFile = path.join(dir, 'expected.json');
    // Written last, so a run killed half way builds the fixture again (no existsSync
    // first: CodeQL js/file-system-race).
    if (readFileOrNothing(expectedFile) !== null) continue;

    fs.rmSync(dir, {recursive: true, force: true});
    fs.mkdirSync(dir, {recursive: true});
    const mpd = path.join(dir, 'manifest.mpd');
    runFfmpeg([
      '-i', MP4_FIXTURE, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-map', '0:v', '-map', '1:a', '-t', '9',
      // No B-frames and no scene-cut keyframes, which libx264 would add and libopenh264
      // cannot: every machine then builds the same frame structure, so a run here
      // checks what CI checks.
      '-c:v', h264Encoder(name), '-pix_fmt', 'yuv420p', '-bf', '0', '-sc_threshold', '0',
      '-force_key_frames', 'expr:gte(t,n_forced*2)',
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
    await ensureMp4Fixture();
    await ensureWebmFixture();
    await ensureLongAvFixture();
    await ensureFrames24Fixture();
    ensureDashFixtures();
    ensureHlsFixtures();
    ensureBframesFixture();
    ensureDashWebmFixture();
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
