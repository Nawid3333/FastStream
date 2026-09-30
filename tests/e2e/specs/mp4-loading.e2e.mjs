// How MP4Player loads a file, range by range, when things go wrong or the file is unusual.
//
// - A range that fails. XHRLoader retries a request itself, but not a 4xx (an expired
//   token's 403), and once a range had failed, MP4Player stopped loading at it for good:
//   the video played up to it, then spun with no error, unless several downloaders ran.
//   Now it asks for the range again after 2, 4 and 8 s, and shows the error once
//   playback reaches a range that still fails.
// - An audio-only file. The ranges' times came from the video track only, so an audio-only
//   file's were never set: nothing behind playback was freed, and the whole file went
//   into the SourceBuffer.
// - Startup. Until the first media was buffered, the main loop sought the video to the
//   time it was at, on every tick; nothing being buffered there, each seek reset the
//   player. Opening a long fragmented file at 30 s reset it 482 times (measured).

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browser, expect} from '@wdio/globals';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
// 160 s, 17 MB: 18 of MP4Player's 1 MB ranges. wdio.conf.mjs writes it.
const LONG_FIXTURE = path.join(fixturesDir, 'long-av.mp4');
const RANGE = 1000000;

const PORT = 41888;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let server;
// How often each file's failing range has been asked for.
const asked = {dead: 0, flaky: 0};

/**
 * Writes one file with ffmpeg under fixtures/mp4-shapes/, unless it is already there.
 * @param {string} name - The file's name.
 * @param {string[]} args - ffmpeg's arguments before the output file.
 */
function ensureFile(name, args) {
  const dir = path.join(fixturesDir, 'mp4-shapes');
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(dir, {recursive: true});
  const partial = file + '.part.mp4';
  const {status, error, stderr} = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args, partial], {encoding: 'utf8'});
  if (status !== 0) {
    throw new Error(`could not write ${name} with ffmpeg${error ? ` (${error.message})` : ''}.\n${stderr || ''}`);
  }
  fs.renameSync(partial, file);
}

/**
 * The player's state: its video's time and buffer, and whether it shows its error.
 * @return {Promise<Object>}
 */
function playerState() {
  return browser.execute(() => {
    const video = window.fastStream?.currentVideo;
    if (video?.paused) video.play().catch(() => {});
    const buffered = video?.buffered;
    return {
      time: video?.currentTime ?? null,
      bufferedEnd: buffered?.length ? buffered.end(buffered.length - 1) : 0,
      failed: !!window.fastStream?.interfaceController?.failed,
    };
  });
}

describe('MP4Player loading', function() {
  before(async function() {
    const sine = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=600', '-c:a', 'aac', '-b:a', '128k'];
    ensureFile('long-audio-only.mp4', [...sine, '-movflags', '+faststart']);
    // ffmpeg's default: the moov after the media.
    ensureFile('long-audio-moov-end.mp4', sine);
    ensureFile('long-moov-end.mp4', ['-i', LONG_FIXTURE, '-c', 'copy']);
    // As mp4-files.e2e.mjs writes it (one spec runs at a time).
    ensureFile('long-fragmented.mp4', ['-i', LONG_FIXTURE, '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov']);

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
      const file = new URL(req.url, ORIGIN).pathname.slice(1).replace('.mp4', '');
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const start = match ? Number(match[1]) : 0;
      const end = Math.min(match && match[2] ? Number(match[2]) : bytes.length - 1, bytes.length - 1);
      // The file's second range: always refused for dead.mp4, twice for flaky.mp4.
      if (start >= RANGE && start < 2 * RANGE && Object.hasOwn(asked, file)) {
        asked[file]++;
        if (file === 'dead' || asked[file] <= 2) {
          res.writeHead(403, cors);
          return res.end();
        }
      }
      res.writeHead(206, {...cors, 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${bytes.length}`});
      res.end(bytes.subarray(start, end + 1));
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('shows an error when a range keeps failing, once playback reaches it', async function() {
    asked.dead = 0;
    await browser.url(`/player/index.html?t=${Date.now()}#${ORIGIN}/dead.mp4`);
    let state = {};
    await browser.waitUntil(async () => {
      state = await playerState();
      return state.failed;
    }, {timeout: 60000, interval: 500, timeoutMsg: 'the player never showed an error for a range that kept failing'}).catch((e) => {
      console.log('      state:', JSON.stringify(state), 'asked:', asked.dead);
      throw e;
    });
    console.log('      failed at', JSON.stringify(state), 'after', asked.dead, 'requests of the range');
    // Asked for again after each of the three waits, not once and never again.
    expect(asked.dead).toBeGreaterThanOrEqual(4);
  });

  it('plays on past a range that failed twice, then loaded', async function() {
    asked.flaky = 0;
    await browser.url(`/player/index.html?t=${Date.now()}#${ORIGIN}/flaky.mp4`);
    let state = {};
    await browser.waitUntil(async () => {
      state = await playerState();
      return state.time > 20 || state.failed;
    }, {timeout: 60000, interval: 500}).catch(() => {});
    console.log('      state:', JSON.stringify(state), 'asked:', asked.flaky);
    expect(state.failed).toBe(false);
    expect(state.time).toBeGreaterThan(20);
  });

  for (const name of ['long-moov-end.mp4', 'long-audio-moov-end.mp4']) {
    it(`plays a long file whose moov comes after its media (${name})`, async function() {
      // The ranges read to reach the moov gave no samples, and counted as loaded: the video
      // sat at its start, with its duration known and nothing buffered, for good.
      await browser.url(`/player/index.html?t=${Date.now()}#${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/mp4-shapes/${name}`);
      let state = {};
      await browser.waitUntil(async () => {
        state = await playerState();
        return state.time > 2 || state.failed;
      }, {timeout: 40000, interval: 500}).catch(() => {});
      console.log('      moov at the end:', name, JSON.stringify(state));
      expect(state.failed).toBe(false);
      expect(state.time).toBeGreaterThan(2);
    });
  }

  it('keeps an audio-only file\'s buffer to what playback needs', async function() {
    await browser.url(`/player/index.html?t=${Date.now()}#${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/mp4-shapes/long-audio-only.mp4`);
    await browser.waitUntil(async () => (await playerState()).time > 2,
        {timeout: 30000, interval: 250, timeoutMsg: 'the audio never played'});
    await browser.pause(3000);
    const state = await playerState();
    console.log('      audio-only:', JSON.stringify(state));
    // MP4Player keeps 30 s ahead (maxBufferLength), give or take a 1 MB range (about a minute
    // of this file); the whole file is 600 s.
    expect(state.bufferedEnd).toBeLessThan(200);
  });

  it('resets the player a few times at most while opening a long file at 30 s', async function() {
    await browser.url(`/player/index.html?t=${Date.now()}`);
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.optionsApplied), {timeout: 30000});
    await browser.executeAsync((url, done) => {
      Promise.all([
        import('/player/players/mp4/MP4Player.mjs'),
        import('/player/VideoSource.mjs'),
        import('/player/enums/PlayerModes.mjs'),
      ]).then(([{default: MP4Player}, {VideoSource}, {PlayerModes}]) => {
        window.__resets = 0;
        const reset = MP4Player.prototype.resetHLS;
        MP4Player.prototype.resetHLS = function(...args) {
          if (!this.isPreview) window.__resets++;
          return reset.apply(this, args);
        };
        window.fastStream.addSource(new VideoSource(url, {}, PlayerModes.ACCELERATED_MP4), true).then(() => {
          window.fastStream.currentTime = 30;
        });
        done();
      });
    }, `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/mp4-shapes/long-fragmented.mp4`);
    await browser.waitUntil(async () => browser.execute(() => (window.fastStream?.currentVideo?.readyState || 0) >= 3),
        {timeout: 30000, interval: 200, timeoutMsg: 'the video never became playable'});
    const resets = await browser.execute(() => window.__resets);
    console.log('      resets while opening at 30 s:', resets);
    expect(resets).toBeLessThanOrEqual(5);
  });
});
