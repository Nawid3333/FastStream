// A/B benchmark of two web builds of the player, in the e2e Firefox (tests/e2e/bench/).
//
// The player's speed has been measured by turns before (docs/notes/player.md: "builds served by
// turns, 4 rounds, medians"), each time with a harness that was thrown away. This one stays:
//
//   node tools/bench-ab.mjs --a <git ref> [--b <git ref>] [--rounds N]
//
// builds both refs' web builds and runs this config with BENCH_A_DIR and BENCH_B_DIR pointing
// at them. Each build gets a server of its own (the same fixtures), so both run in one browser,
// one after the other, in alternating order (ABBA): a machine that warms up or gets busy
// weighs on both alike. The servers can stand in for a slow site: BENCH_RATE_MBIT shares one
// line between all of a server's answers, BENCH_TTFB_MS holds back each answer's first byte.
//
// It measures and writes logs/bench/ab-<time>.json and .md; it fails only when a scenario
// cannot run (a broken build), never on a number.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as url from 'node:url';

import {config as base} from './wdio.conf.mjs';
import {ensureFixtures} from './buildFixtures.mjs';
import {listenOrStop} from './listen-or-stop.mjs';
import {loopedPlaylist} from './loopedPlaylist.mjs';
import {ensureMp4Fixture} from './mp4Fixture.mjs';
import {byteRange, decodePath, resolveInside} from './serveFile.mjs';
import {BENCH_MEDIA_HOSTS, BENCH_PORTS, bench} from './bench/settings.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

for (const [name, dir] of Object.entries(bench.dirs)) {
  if (!dir || !fs.existsSync(path.join(dir, 'player', 'index.html'))) {
    throw new Error(`BENCH_${name}_DIR must name a web build (a built/web folder); got ${dir}. Run tools/bench-ab.mjs.`);
  }
}
const {rateMbit, ttfbMs, jitterMs, jitterFactor, connMbit, dropPct} = bench.line;
// BENCH_TRACE=1: the media requests' trace (benchServer), in logs/bench.
const traceFile = process.env.BENCH_TRACE === '1' ?
  path.join(__dirname, '..', '..', 'logs', 'bench', `trace-${new Date().toISOString().replaceAll(':', '-')}.jsonl`) : null;
if (traceFile) fs.mkdirSync(path.dirname(traceFile), {recursive: true});
/** @type {Map<string, number>} How many media requests each address and port had. */
const traceCounts = new Map();

/**
 * A DASH manifest as long as a scenario needs: the dash-template fixture (9 s) Period after
 * Period, each Period's segments under addresses of their own (`p=`) with the run's name in
 * them, as the looped HLS playlist does with its discontinuities.
 * @param {number} seconds - Rounded up to whole Periods.
 * @param {string} run - Already URL-encoded.
 * @return {string}
 */
function loopedManifest(seconds, run) {
  const fixture = fs.readFileSync(path.join(fixturesDir, 'dash-template', 'manifest.mpd'), 'utf8');
  const period = fixture.slice(fixture.indexOf('<Period'), fixture.indexOf('</Period>') + '</Period>'.length);
  // What it changes must be there as written: a changed fixture would otherwise give a wrong
  // manifest without a word (a review).
  for (const text of ['<Period id="0" start="PT0.0S">', 'mediaPresentationDuration="PT9.0S"',
    'initialization="init-stream', 'media="chunk-stream', '.m4s"']) {
    if (!period.includes(text) && !fixture.includes(text)) throw new Error(`looped.mpd: the dash-template fixture has no ${text}`);
  }
  const count = Math.ceil(seconds / 9);
  const periods = [];
  for (let p = 0; p < count; p++) {
    periods.push(period.replace('<Period id="0" start="PT0.0S">', `<Period id="${p}" start="PT${p * 9}.0S" duration="PT9.0S">`)
        .replaceAll('initialization="init-stream', 'initialization="dash-template/init-stream')
        .replaceAll('media="chunk-stream', 'media="dash-template/chunk-stream')
        .replaceAll('.m4s"', `.m4s?run=${run}&amp;p=${p}"`));
  }
  const head = fixture.slice(0, fixture.indexOf('<Period'))
      .replace('mediaPresentationDuration="PT9.0S"', `mediaPresentationDuration="PT${count * 9}.0S"`);
  return `${head}${periods.join('\n')}\n</MPD>\n`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.m4s': 'video/iso.segment', '.m4a': 'audio/mp4', '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t', '.mpd': 'application/dash+xml', '.vtt': 'text/vtt', '.webm': 'video/webm',
};

/**
 * A line: a byte goes out no sooner than the line's rate allows after the bytes before it,
 * whichever answer they were in (one line for all of a server's answers; one per answer for a
 * cap per connection).
 * @param {number} mbit - Megabits a second; 0 for no limit.
 * @param {number} [jitter] - Every so many ms the rate switches between full and `factor` of
 *   it (0: steady), full first, from `since`: each run's own start (benchServer), so every run
 *   of both builds meets the same line. On one clock for all, the ABBA order was to spread
 *   where each build's runs fell in the pattern, and did not: in 5 rounds main's HLS first
 *   frames came at 4.1 s three times and 6.2 and 7.7 s, the other build's at 6.7-7.7 s each time,
 *   the same requests on the same line, its slow half or not (2026-11-15).
 * @param {number} [factor]
 * @return {(bytes: number, since?: number) => number} When (performance.now() ms) so many bytes
 *   are sent, if they are handed over now.
 */
function paceLine(mbit, jitter = 0, factor = 1) {
  let freeAt = 0;
  const bytesPerMs = mbit * 1e6 / 8 / 1000;
  const slow = Math.max(factor, 0.01);
  return (bytes, since = 0) => {
    const now = performance.now();
    if (!mbit) return now;
    const start = Math.max(now, freeAt);
    const rate = jitter && Math.floor((start - since) / jitter) % 2 === 1 ? bytesPerMs * slow : bytesPerMs;
    freeAt = start + bytes / rate;
    return freeAt;
  };
}

/** @type {Map<string, number>} How often each media request was asked for, per run (cutAt). */
const asked = new Map();

/**
 * Where to cut an answer part-way, if at all (BENCH_DROP_PCT): the same requests for both
 * builds - by path, place in a looped playlist and where the range ends, not by run - and only
 * the first time a run asks, so a retry gets through. By the range's end, not its start: a
 * retry that goes on from where the cut answer stopped is the same request (a review: by its
 * start, whether it was cut again would depend on how many bytes had arrived).
 * @param {string} rel - The path.
 * @param {URLSearchParams} params - The request's query.
 * @param {{start: number, end: number}} range
 * @return {number} The byte to cut at; Infinity for none.
 */
function cutAt(rel, params, range) {
  if (!dropPct || /\.(m3u8|mpd)$/.test(rel)) return Infinity;
  const run = params.get('run') || '';
  const rest = new URLSearchParams(params);
  rest.delete('run');
  const key = `${rel}?${rest}|${range.end}`;
  const count = (asked.get(`${run}|${key}`) || 0) + 1;
  asked.set(`${run}|${key}`, count);
  const hash = crypto.createHash('sha1').update(key).digest();
  if (count > 1 || hash.readUInt16BE(0) % 1000 >= dropPct * 10) return Infinity;
  // Somewhere from a tenth to nine tenths in.
  return range.start + Math.floor((range.end - range.start + 1) * (0.1 + (hash.readUInt16BE(2) % 800) / 1000));
}

/**
 * Sends a file, or part of it, in 64 KiB pieces at the line's rate.
 * @param {http.ServerResponse} res
 * @param {string} file
 * @param {{start: number, end: number}} range
 * @param {(bytes: number) => number} line
 * @param {number} ttfb - How long the first byte is held back, in ms.
 * @param {{cut?: number, capMbit?: number}} [media] - For the media: the byte at which the
 *   connection is cut (cutAt), and the cap on this answer (BENCH_CONN_MBIT, 0: none).
 */
function sendPaced(res, file, {start, end}, line, ttfb, {cut = Infinity, capMbit = 0} = {}) {
  const fd = fs.openSync(file, 'r');
  let at = start;
  // The cap per connection: this answer's own line beside the shared one.
  const own = paceLine(capMbit);
  const next = () => {
    if (!res.destroyed && at >= cut && at <= end) {
      // Cut at the byte chosen, after what came before it has gone out (an answer smaller
      // than a piece was never cut, a larger one only at the next piece: a review).
      fs.closeSync(fd);
      res.destroy();
      return;
    }
    if (res.destroyed || at > end) {
      fs.closeSync(fd);
      if (!res.destroyed) res.end();
      return;
    }
    const piece = Buffer.alloc(Math.min(65536, end - at + 1, cut - at));
    fs.readSync(fd, piece, 0, piece.length, at);
    at += piece.length;
    setTimeout(() => {
      if (res.destroyed) {
        fs.closeSync(fd);
        return;
      }
      if (at >= cut) {
        // The last piece before the cut: cut once it has been handed to the connection.
        res.write(piece, () => next());
      } else {
        res.write(piece) ? next() : res.once('drain', next);
      }
    }, Math.max(line(piece.length), own(piece.length)) - performance.now());
  };
  setTimeout(next, ttfb);
}

/**
 * A server for one build: the build's files and the fixtures, with Range.
 * @param {string} buildDir
 * @return {http.Server}
 */
function benchServer(buildDir) {
  const line = paceLine(rateMbit, jitterMs, jitterFactor);
  /** @type {Set<string>} The runs this server has seen. */
  const runsSeen = new Set();
  // When the run going on started (paceLine's pattern starts with it).
  let lineSince = performance.now();
  return http.createServer((req, res) => {
    // BENCH_TRACE=1: each media request's start and end, one JSON line each, to see who had
    // the line when (the tabs scenario). Only what the server knows itself goes in it - the
    // address and port it was asked on (a tab's host, a build), the kind of file, a count -
    // and into a file of its own choosing: nothing a request sends ends up in a file or a path
    // (CodeQL, 2026-11-14).
    if (traceFile && req.url.startsWith('/fixtures/')) {
      const socket = req.socket;
      const where = `${socket.localAddress}:${socket.localPort}`;
      // wdio loads this file in each of its processes; the servers run in one of them.
      if (traceCounts.size === 0) console.log(`Trace: ${traceFile}`);
      const count = (traceCounts.get(where) || 0) + 1;
      traceCounts.set(where, count);
      const entry = {where, kind: req.url.includes('.m3u8') ? 'playlist' : 'segment', count};
      fs.appendFileSync(traceFile, JSON.stringify({at: Date.now(), event: 'start', ...entry}) + '\n');
      res.on('close', () => fs.appendFileSync(traceFile,
          JSON.stringify({at: Date.now(), event: res.writableFinished ? 'end' : 'cut', ...entry}) + '\n'));
    }
    const rel = decodePath(req.url.split('?')[0].split('#')[0]);
    if (rel === null) {
      res.writeHead(400);
      return res.end();
    }
    // A video as long as a scenario needs, at a film's bitrate (about 2.1 Mbit/s): the hls-ts
    // fixture's segments over and over, each under an address of its own, the run's name in it
    // (the tabs scenario: four players, each its own video).
    if (rel === '/fixtures/looped.m3u8') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const seconds = Math.min(Math.max(Number(query.get('seconds')) || 90, 9), 3600);
      const run = encodeURIComponent(query.get('run') || '');
      res.writeHead(200, {'Content-Type': MIME['.m3u8'], 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'});
      return res.end(loopedPlaylist(seconds, '/fixtures/hls-ts/', {unique: true}).replaceAll('?i=', `?run=${run}&i=`));
    }
    // The same for DASH: the dash-template fixture's 9 s Period after Period (loopedManifest).
    if (rel === '/fixtures/looped.mpd') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const seconds = Math.min(Math.max(Number(query.get('seconds')) || 90, 9), 3600);
      const run = encodeURIComponent(query.get('run') || '');
      res.writeHead(200, {'Content-Type': MIME['.mpd'], 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'});
      return res.end(loopedManifest(seconds, run));
    }
    const fromFixtures = rel.startsWith('/fixtures/');
    const abs = resolveInside(fromFixtures ? fixturesDir : buildDir, fromFixtures ? rel.slice('/fixtures'.length) : rel);
    if (abs === null || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    const size = fs.statSync(abs).size;
    const headers = {
      'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    };
    const range = byteRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, {'Content-Range': `bytes */${size}`});
      return res.end();
    }
    // Only the media goes over the slow line and waits for its first byte: the player's own
    // files come at once, as from the extension's package (they waited too at first, 150 ms
    // for each module, and every start took 4.5 s).
    // A run starts its line's pattern (paceLine): the first request a server sees with a run's
    // name (its manifest or file; a playlist's segments carry none, and come from the run going on).
    const run = new URL(req.url, 'http://localhost').searchParams.get('run');
    if (fromFixtures && run && !runsSeen.has(run)) {
      runsSeen.add(run);
      lineSince = performance.now();
    }
    const since = lineSince;
    const pace = fromFixtures ? (/** @type {number} */ bytes) => line(bytes, since) : () => performance.now();
    const span = range || {start: 0, end: size - 1};
    const media = fromFixtures ? {cut: cutAt(rel, new URL(req.url, 'http://localhost').searchParams, span), capMbit: connMbit} : {};
    if (range) {
      res.writeHead(206, {...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': range.end - range.start + 1});
      return sendPaced(res, abs, range, pace, fromFixtures ? ttfbMs : 0, media);
    }
    res.writeHead(200, {...headers, 'Content-Length': size});
    sendPaced(res, abs, span, pace, fromFixtures ? ttfbMs : 0, media);
  });
}

/** @type {http.Server[]} */
const servers = [];

export const config = {
  ...base,
  specs: [path.join(__dirname, 'bench', '*.bench.mjs')],
  // A number is no flake: never run again.
  specFileRetries: 0,
  onWorkerEnd: undefined,
  baseUrl: `http://127.0.0.1:${BENCH_PORTS.A}`,
  mochaOpts: {...base.mochaOpts, timeout: 60 * 60 * 1000},
  onPrepare: async function() {
    await ensureMp4Fixture();
    await ensureFixtures();
    fs.mkdirSync(bench.out, {recursive: true});
    for (const name of /** @type {const} */ (['A', 'B'])) {
      const server = benchServer(bench.dirs[name]);
      servers.push(server);
      await new Promise((resolve) => listenOrStop(server, BENCH_PORTS[name], resolve));
      // The same server under other hosts' names, on the same line (the tabs scenario: a
      // video host of its own for each tab, as tabs on different sites have).
      for (const host of BENCH_MEDIA_HOSTS) {
        const other = http.createServer((req, res) => server.emit('request', req, res));
        servers.push(other);
        await new Promise((resolve) => {
          other.on('error', (error) => {
            console.error(`
The test server on ${host}:${BENCH_PORTS[name]} failed: ${error.message}
`);
            process.exit(1);
          });
          other.listen(BENCH_PORTS[name], host, () => resolve(undefined));
        });
      }
    }
  },
  beforeTest: undefined,
  afterTest: undefined,
  onComplete: function() {
    return Promise.all(servers.map((server) => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    })));
  },
};
