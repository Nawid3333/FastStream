// MP4 from servers that do not answer ranges as MP4Player needs.
//
// MP4Player loads a file in 1 MB ranges and takes its length from Content-Range. A server that
// ignores Range answers 200 with the whole file; FetchLoader cut the range out of it, and every
// later range downloaded the file from byte 0 again up to its end - 17 requests and ~150 MB for
// this 17 MB file, about 2 TB for a 2 GB one. Such a source now goes to Firefox's own player
// (DIRECT mode), which reads the file once (MP4Player.playDirectly, RangeAnswers.mjs); one whose
// whole file came in the first answer stays in MP4Player. A 206 without Content-Range gives no
// length; a fragmented file's length then came from the fragments parsed so far, and the video
// ended after the first range (~9 s here). MP4Player now reads such a file on, range by range,
// until a range comes back short; a regular MP4's sample table tells its length. (Firefox's
// own player refuses a 206 without Content-Range, so it is no way out for those.) A file whose
// length is a multiple of the range size ends at the range after its last: empty, or a 416.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

const PORT = 41891;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');

/**
 * long-av.mp4 (17 MB, its moov first) as a fragmented file, made with ffmpeg once.
 * @param {string} name - The file's name in fixtures/mp4-shapes.
 * @param {Array<string>} [cut] - ffmpeg options that take a part, e.g. ['-t', '20'].
 * @return {string} Its path.
 */
function fragmentedFixture(name, cut = []) {
  const dir = path.join(FIXTURES, 'mp4-shapes');
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, {recursive: true});
    const partial = file + '.part.mp4';
    const {status, error, stderr} = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(FIXTURES, 'long-av.mp4'),
      ...cut, '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', partial], {encoding: 'utf8'});
    if (status !== 0) {
      throw new Error(`could not write the fragmented file with ffmpeg${error ? ` (${error.message})` : ''}. ` +
        `CI installs ffmpeg; locally it must be on PATH.\n${stderr || ''}`);
    }
    fs.renameSync(partial, file);
  }
  return file;
}

/**
 * A file padded with a free box to the next multiple of MP4Player's range size (1 MB): no
 * range comes back short, and only the one after its end tells where it ends.
 * @param {string} file
 * @return {Buffer}
 */
function paddedToRanges(file) {
  const bytes = fs.readFileSync(file);
  const RANGE = 1000000;
  let length = Math.ceil(bytes.length / RANGE) * RANGE;
  if (length - bytes.length < 8) length += RANGE;
  const free = Buffer.alloc(length - bytes.length);
  free.writeUInt32BE(free.length, 0);
  free.write('free', 4, 'latin1');
  return Buffer.concat([bytes, free]);
}

const FILES = {};
let requests = [];
let server;

describe('MP4 from a server without proper ranges', function() {
  before(async function() {
    FILES['long.mp4'] = path.join(FIXTURES, 'long-av.mp4');
    FILES['small.mp4'] = path.join(FIXTURES, 'sample.mp4');
    FILES['fragmented.mp4'] = fragmentedFixture('long-av-fragmented.mp4');
    FILES['padded.mp4'] = paddedToRanges(fragmentedFixture('long-av-20s-fragmented.mp4', ['-t', '20']));
    FILES['one-range.mp4'] = paddedToRanges(fragmentedFixture('long-av-6s-fragmented.mp4', ['-t', '6']));
    server = http.createServer((req, res) => {
      const [, kind, name] = new URL(req.url, ORIGIN).pathname.split('/');
      const headers = {'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
        'Access-Control-Expose-Headers': 'Content-Length', 'Content-Type': 'video/mp4'};
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {...headers, 'Access-Control-Allow-Headers': '*'});
        res.end();
        return;
      }
      const file = FILES[name];
      if (!file || !['ignore-range', 'no-content-range', 'no-content-range-416'].includes(kind)) {
        res.writeHead(404, headers);
        res.end();
        return;
      }
      requests.push({kind, name, range: req.headers.range || null});
      const bytes = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (kind === 'ignore-range' || !range) {
        // The whole file, whatever was asked.
        res.writeHead(200, {...headers, 'Content-Length': bytes.length});
        res.end(bytes);
        return;
      }
      // The range asked for, but no Content-Range: a broken server or proxy. Past the end: an
      // empty answer, or (as most servers) 416 Range Not Satisfiable.
      const start = Number(range[1]);
      if (kind === 'no-content-range-416' && start >= bytes.length) {
        res.writeHead(416, headers);
        res.end();
        return;
      }
      const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      res.writeHead(206, {...headers, 'Content-Length': end - start + 1});
      res.end(bytes.subarray(start, end + 1));
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  /**
   * Opens a source, nudges it to play, and waits until it played past `past` seconds or failed.
   * @param {string} url
   * @param {number} past
   * @return {Promise<Object>} mode, time, duration, failed
   */
  async function play(url, past) {
    requests = [];
    await browser.url(`/player/index.html?t=${Date.now()}#${url}`);
    let state = {mode: null, time: 0, duration: 0, failed: false};
    try {
      await browser.waitUntil(async () => {
        state = await browser.execute(() => {
          const client = window.fastStream;
          const video = client?.player?.getVideo();
          if (!video) return {mode: null, time: 0, duration: 0, failed: false};
          if (video.paused && !video.ended) video.play().catch(() => {});
          return {mode: client.source?.mode, time: video.currentTime, duration: video.duration,
            failed: !!client.interfaceController.failed};
        });
        return state.time > past || state.failed;
      }, {timeout: 60000, interval: 250});
    } finally {
      console.log(`      ${url.replace(ORIGIN, '')}: ${JSON.stringify(state)}; ` +
        `${requests.length} request(s): ${JSON.stringify(requests.slice(0, 6).map((request) => request.range))}`);
    }
    return state;
  }

  /**
   * Records, in order, the player's resets and where it learnt the file's end, for the log of
   * a run that does not end.
   * @return {Promise<void>}
   */
  const traceEnd = () => browser.execute(() => {
    const player = window.fastStream.player;
    const events = window.__mp4Events = [];
    for (const name of ['resetHLS', 'endsAt']) {
      const original = player[name];
      player[name] = function(...args) {
        events.push(`${name}(${args.join(',')}) at ${player.getVideo().currentTime.toFixed(2)}`);
        return original.apply(this, args);
      };
    }
  });

  /**
   * What MP4Player's end check (checkEndOfStream) looks at. Once (local, 2026-10-09) the 416
   * case sat at 20.08 of 20.3 s with every range read: this tells which condition held it.
   * @return {Promise<Object>}
   */
  const endState = () => browser.execute(() => {
    const player = window.fastStream.player;
    const ranges = (buffered) => Array.from({length: buffered?.length || 0},
        (_, i) => [buffered.start(i), buffered.end(i)].map((time) => Number(time.toFixed(3))));
    const wrapper = (w) => w && {updating: w.updating, sourceUpdating: w.sourceBuffer.updating,
      toDo: w.toDo.length, buffered: ranges(w.sourceBuffer.buffered)};
    return {
      fileLength: player.fileLength,
      hasLastRange: player.hasLastRange?.(),
      currentFragments: player.currentFragments?.map((frag) => [frag.sn, frag.rangeStart, frag.rangeEnd, frag.status]),
      loader: !!player.loader,
      mediaSource: player.mediaSource?.readyState,
      tracks: player.mp4box?.fragmentedTracks?.map((track) => [track.id, track.trak.nextSample, track.trak.samples.length]),
      video: wrapper(player.videoSourceBuffer),
      audio: wrapper(player.audioSourceBuffer),
      readyState: player.getVideo().readyState,
      events: window.__mp4Events,
    };
  });

  it('plays a big file from a server that ignores Range in Firefox\'s own player, reading it once', async function() {
    const state = await play(`${ORIGIN}/ignore-range/long.mp4`, 3);
    expect(state.failed).toBe(false);
    expect(state.mode).toBe('direct');
    expect(state.time).toBeGreaterThan(3);
    // One range for MP4Player, then Firefox's own reading; not one whole file per 1 MB range.
    expect(requests.length).toBeLessThanOrEqual(5);
  });

  it('keeps a small file the first answer brought whole in its own player', async function() {
    const state = await play(`${ORIGIN}/ignore-range/small.mp4`, 2);
    expect(state.failed).toBe(false);
    expect(state.mode).toBe('accelerated_mp4');
    expect(state.time).toBeGreaterThan(2);
  });

  it('reads a fragmented file from a 206 without Content-Range on, range by range, past the first', async function() {
    const state = await play(`${ORIGIN}/no-content-range/fragmented.mp4`, 3);
    expect(state.failed).toBe(false);
    expect(state.mode).toBe('accelerated_mp4');
    // A minute in: far past what the first range held (~9 s).
    await browser.execute(() => {
      window.fastStream.currentTime = 60;
    });
    let later = {time: 0, failed: false};
    try {
      await browser.waitUntil(async () => {
        later = await browser.execute(() => {
          const video = window.fastStream.player.getVideo();
          if (video.paused && !video.ended) video.play().catch(() => {});
          return {time: video.currentTime, failed: !!window.fastStream.interfaceController.failed, duration: video.duration};
        });
        return later.time > 61 || later.failed;
      }, {timeout: 60000, interval: 250});
    } finally {
      console.log(`      at a minute: ${JSON.stringify(later)}`);
    }
    expect(later.failed).toBe(false);
    expect(later.time).toBeGreaterThan(61);
  });

  for (const kind of ['no-content-range', 'no-content-range-416']) {
    it(`ends a fragmented file of whole ranges from a 206 without Content-Range at its end (${kind})`, async function() {
      const state = await play(`${ORIGIN}/${kind}/padded.mp4`, 1);
      expect(state.failed).toBe(false);
      expect(state.mode).toBe('accelerated_mp4');
      await traceEnd();
      // Near the end, once its ranges are all read: it ends there and fires 'ended', and no
      // range past the one after the end is asked for.
      let end = {ended: false, time: 0, duration: 0, failed: false};
      try {
        await browser.waitUntil(async () => {
          end = await browser.execute(() => {
            const client = window.fastStream;
            const video = client.player.getVideo();
            const duration = video.duration;
            if (duration > 18 && duration < 30 && video.currentTime < duration - 3) {
              client.currentTime = duration - 2;
            }
            if (video.paused && !video.ended) video.play().catch(() => {});
            return {ended: video.ended, time: video.currentTime, duration, failed: !!client.interfaceController.failed};
          });
          return end.ended || end.failed;
        }, {timeout: 60000, interval: 250});
      } finally {
        console.log(`      to its end: ${JSON.stringify(end)}; ${requests.length} request(s): ` +
          JSON.stringify(requests.map((request) => request.range)));
        if (!end.ended) {
          console.log(`      player state: ${JSON.stringify(await endState().catch((e) => String(e)))}`);
        }
      }
      expect(end.failed).toBe(false);
      expect(end.ended).toBe(true);
      expect(end.duration).toBeGreaterThan(18);
      const length = FILES['padded.mp4'].length;
      const past = requests.filter((request) => Number(/^bytes=(\d+)/.exec(request.range || '')?.[1]) > length);
      expect(past).toEqual([]);
    });
  }

  it('ends a fragmented file of exactly one range from a server that ignores Range after it', async function() {
    // Its whole file is as long as the range: the first answer cannot tell the whole file from
    // the range, so the next range is read, and the server sends the whole file again. That
    // answer is as long as a range, and FetchLoader takes it for the range: the file's start
    // again, which must not be parsed as the bytes after it.
    expect(FILES['one-range.mp4'].length).toBe(1000000);
    const state = await play(`${ORIGIN}/ignore-range/one-range.mp4`, 1);
    expect(state.failed).toBe(false);
    expect(state.mode).toBe('accelerated_mp4');
    let end = {ended: false, time: 0, duration: 0, failed: false};
    try {
      await browser.waitUntil(async () => {
        end = await browser.execute(() => {
          const client = window.fastStream;
          const video = client.player.getVideo();
          const duration = video.duration;
          if (duration > 4 && duration < 10 && video.currentTime < duration - 2) {
            client.currentTime = duration - 1;
          }
          if (video.paused && !video.ended) video.play().catch(() => {});
          return {ended: video.ended, time: video.currentTime, duration, failed: !!client.interfaceController.failed};
        });
        return end.ended || end.failed;
      }, {timeout: 30000, interval: 250});
    } finally {
      console.log(`      to its end: ${JSON.stringify(end)}; ${requests.length} request(s): ` +
        JSON.stringify(requests.map((request) => request.range)));
    }
    expect(end.failed).toBe(false);
    expect(end.ended).toBe(true);
    expect(end.duration).toBeGreaterThan(4);
    expect(end.duration).toBeLessThan(8);
    expect(requests.length).toBeLessThanOrEqual(2);
  });

  it('keeps a regular file from a 206 without Content-Range in its own player: its samples tell the length', async function() {
    const state = await play(`${ORIGIN}/no-content-range/long.mp4`, 3);
    expect(state.failed).toBe(false);
    expect(state.mode).toBe('accelerated_mp4');
    expect(state.time).toBeGreaterThan(3);
  });
});
