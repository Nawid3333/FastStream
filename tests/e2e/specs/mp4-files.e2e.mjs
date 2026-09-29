// MP4 files of shapes the MP4 fixture is not, through MP4Player (an .mp4 URL's player).
//
// - Audio only. MP4Player handed each parsed segment to the video or the audio buffer by
//   comparing its track with the file's video track, which an audio-only file does not
//   have: a TypeError on the first segment, and nothing played.
// - Fragmented (moof boxes, as ffmpeg's frag_keyframe and live recorders write). Since
//   mp4box 2.x a fragmented file's duration comes as a {num, den} fraction, and MP4Player
//   divided it by the timescale: NaN, which the MediaSource refuses, and nothing played.
// - Long and fragmented (the long fixture cut the same way). MP4Player worked out the
//   file's length from the samples mp4box knew after the first 1 MB range, not from the
//   server's Content-Range: for a fragmented file those end with that range, so the file
//   looked 10 s long, and the rest was never loaded.
// - Fragmented and bigger than MP4Player's 30 buffered ranges (the long fixture three
//   times over: 480 s, 51 MB). MP4Player picked the range to load from the samples it
//   knew when the metadata was parsed, and a fragmented file's samples become known one
//   moof at a time, so it played the first 30 ranges, 30 MB, and could not seek past them.
// - From a server that answers ranges without the file's length (`bytes 0-1023/*`, which
//   RFC 9110 allows). This one was already fine - the length is then worked out from the
//   file's sample table - and is held here: a file that fits in MP4Player's first 1 MB
//   range never needs it, so this is the long fixture, sought far into.
//
// The fragmented file is cut from the MP4 fixture by ffmpeg, as save-fmp4.e2e.mjs's are.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browser, expect} from '@wdio/globals';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const MP4_FIXTURE = path.join(fixturesDir, 'sample.mp4');
// 160 s, 17 MB: 18 of MP4Player's 1 MB ranges. wdio.conf.mjs writes it.
const LONG_FIXTURE = path.join(fixturesDir, 'long-av.mp4');

const LENGTHLESS_PORT = 41886;
const LENGTHLESS_ORIGIN = `http://127.0.0.1:${LENGTHLESS_PORT}`;
let server;

/**
 * Writes one file with ffmpeg, unless it is already there.
 * @param {string} name - File name under fixtures/mp4-shapes/.
 * @param {string[]} args - ffmpeg's arguments before the output file.
 * @return {void}
 */
function ensureFile(name, args) {
  const dir = path.join(fixturesDir, 'mp4-shapes');
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(dir, {recursive: true});
  // Written under another name first, so a run killed half way leaves no file to reuse.
  const partial = file + '.part.mp4';
  const {status, error, stderr} = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args, partial], {encoding: 'utf8'});
  if (status !== 0) {
    throw new Error(`could not write ${name} with ffmpeg${error ? ` (${error.message})` : ''}. ` +
      `CI installs ffmpeg; locally it must be on PATH.\n${stderr || ''}`);
  }
  fs.renameSync(partial, file);
}

/**
 * The video's state, and a nudge to play when it is paused.
 * @return {Promise<Object>}
 */
async function videoState() {
  return browser.execute(() => {
    const video = window.fastStream?.currentVideo;
    if (!video) return {};
    if (video.paused) video.play().catch(() => {});
    return {currentTime: video.currentTime, readyState: video.readyState, duration: window.fastStream.duration,
      error: video.error?.message || null, failed: !!window.fastStream.interfaceController?.failed};
  });
}

/**
 * Waits until the video plays past a time.
 * @param {number} time - Seconds.
 * @param {string} label - For the log.
 * @return {Promise<Object>} The video's state.
 */
async function playPast(time, label) {
  let state = {};
  await browser.waitUntil(async () => {
    state = await videoState();
    return state.currentTime > time;
  }, {timeout: 45000, interval: 500}).catch(() => {});
  console.log(`      ${label}:`, JSON.stringify(state));
  return state;
}

/**
 * Opens the player at a source and waits for its time to move.
 * @param {string} source - The file's URL.
 * @return {Promise<Object>} What the video reported.
 */
async function playFor(source) {
  await browser.url(`/player/index.html?t=${Date.now()}#${source}`);
  return playPast(1, 'start');
}

/**
 * Seeks the player and waits for it to play on from there.
 * @param {number} time - Where to, in seconds.
 * @return {Promise<Object>} What the video reported.
 */
async function seekAndPlay(time) {
  await browser.execute((time) => {
    window.fastStream.currentTime = time;
  }, time);
  return playPast(time + 1, `after a seek to ${time} s`);
}

/**
 * Waits until the player's duration passes a time. A fragmented file without a mehd box
 * has the duration that has been parsed, which grows as its ranges come in.
 * @param {number} time - Seconds.
 * @return {Promise<number>} The duration when the wait ended.
 */
async function durationPast(time) {
  let duration = 0;
  await browser.waitUntil(async () => {
    duration = await browser.execute(() => window.fastStream.duration);
    return duration > time;
  }, {timeout: 30000, interval: 500}).catch(() => {});
  console.log(`      duration: ${duration}`);
  return duration;
}

describe('MP4 files of other shapes', function() {
  before(async function() {
    ensureFile('audio-only.mp4', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-c:a', 'aac', '-b:a', '64k']);
    ensureFile('fragmented.mp4', ['-i', MP4_FIXTURE, '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov']);
    ensureFile('long-fragmented.mp4', ['-i', LONG_FIXTURE, '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov']);
    ensureFile('longer-fragmented.mp4',
        ['-stream_loop', '2', '-i', LONG_FIXTURE, '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov']);

    const bytes = fs.readFileSync(LONG_FIXTURE);
    server = http.createServer((req, res) => {
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers': 'Content-Range',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (!match) {
        res.writeHead(200, {...cors, 'Content-Type': 'video/mp4'});
        return res.end(bytes);
      }
      const start = Number(match[1]);
      const end = Math.min(match[2] ? Number(match[2]) : bytes.length - 1, bytes.length - 1);
      if (start > end) {
        res.writeHead(416, cors);
        return res.end();
      }
      res.writeHead(206, {...cors, 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/*`});
      res.end(bytes.subarray(start, end + 1));
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(LENGTHLESS_PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('plays an MP4 that has no video track', async function() {
    const state = await playFor(`${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/mp4-shapes/audio-only.mp4`);
    expect(state.currentTime).toBeGreaterThan(1);
    expect(state.failed).toBe(false);
  });

  it('plays a fragmented MP4', async function() {
    const state = await playFor(`${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/mp4-shapes/fragmented.mp4`);
    expect(state.currentTime).toBeGreaterThan(1);
    expect(state.duration).toBeCloseTo(10, 0);
    expect(state.failed).toBe(false);
  });

  it('plays a long fragmented MP4, far into it', async function() {
    const start = await playFor(`${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/mp4-shapes/long-fragmented.mp4`);
    expect(start.currentTime).toBeGreaterThan(1);
    expect(await durationPast(150)).toBeGreaterThan(150);
    const later = await seekAndPlay(120);
    expect(later.currentTime).toBeGreaterThan(121);
    expect(later.failed).toBe(false);
  });

  it('plays a fragmented MP4 bigger than its buffered ranges, past them and back', async function() {
    const start = await playFor(`${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/mp4-shapes/longer-fragmented.mp4`);
    expect(start.currentTime).toBeGreaterThan(1);
    // The first 30 ranges reach about 280 s of the 480.
    expect(await durationPast(250)).toBeGreaterThan(250);
    const middle = await seekAndPlay(250);
    expect(middle.currentTime).toBeGreaterThan(251);
    expect(await durationPast(450)).toBeGreaterThan(450);
    const later = await seekAndPlay(450);
    expect(later.currentTime).toBeGreaterThan(451);
    // Back to where the ranges played through have been let go.
    const back = await seekAndPlay(60);
    expect(back.currentTime).toBeGreaterThan(61);
    expect(back.failed).toBe(false);
  });

  it('plays an MP4 from a server that does not give its length, far into it', async function() {
    const start = await playFor(`${LENGTHLESS_ORIGIN}/long-av.mp4`);
    expect(start.currentTime).toBeGreaterThan(1);
    const later = await seekAndPlay(120);
    expect(later.currentTime).toBeGreaterThan(121);
    expect(later.failed).toBe(false);
  });
});
