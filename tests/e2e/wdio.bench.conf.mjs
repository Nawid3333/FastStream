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
const {rateMbit, ttfbMs} = bench.line;
// BENCH_TRACE=1: the media requests' trace (benchServer), in logs/bench.
const traceFile = process.env.BENCH_TRACE === '1' ?
  path.join(__dirname, '..', '..', 'logs', 'bench', `trace-${new Date().toISOString().replaceAll(':', '-')}.jsonl`) : null;
if (traceFile) fs.mkdirSync(path.dirname(traceFile), {recursive: true});
/** @type {Map<string, number>} How many media requests each address and port had. */
const traceCounts = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.m4s': 'video/iso.segment', '.m4a': 'audio/mp4', '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t', '.mpd': 'application/dash+xml', '.vtt': 'text/vtt', '.webm': 'video/webm',
};

/**
 * One line shared by every answer of a server: a byte goes out no sooner than the line's rate
 * allows after the bytes before it, whichever answer they were in.
 * @param {number} mbit - Megabits a second; 0 for no limit.
 * @return {(bytes: number) => number} How long to wait, in ms, before sending so many bytes.
 */
function sharedLine(mbit) {
  let freeAt = 0;
  const bytesPerMs = mbit * 1e6 / 8 / 1000;
  return (bytes) => {
    if (!mbit) return 0;
    const now = performance.now();
    const start = Math.max(now, freeAt);
    freeAt = start + bytes / bytesPerMs;
    return freeAt - now;
  };
}

/**
 * Sends a file, or part of it, in 64 KiB pieces at the line's rate.
 * @param {http.ServerResponse} res
 * @param {string} file
 * @param {{start: number, end: number}} range
 * @param {(bytes: number) => number} line
 * @param {number} ttfb - How long the first byte is held back, in ms.
 */
function sendPaced(res, file, {start, end}, line, ttfb) {
  const fd = fs.openSync(file, 'r');
  let at = start;
  const next = () => {
    if (res.destroyed || at > end) {
      fs.closeSync(fd);
      if (!res.destroyed) res.end();
      return;
    }
    const piece = Buffer.alloc(Math.min(65536, end - at + 1));
    fs.readSync(fd, piece, 0, piece.length, at);
    at += piece.length;
    setTimeout(() => {
      if (res.destroyed) {
        fs.closeSync(fd);
        return;
      }
      res.write(piece) ? next() : res.once('drain', next);
    }, line(piece.length));
  };
  setTimeout(next, ttfb);
}

/**
 * A server for one build: the build's files and the fixtures, with Range.
 * @param {string} buildDir
 * @return {http.Server}
 */
function benchServer(buildDir) {
  const line = sharedLine(rateMbit);
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
    const pace = fromFixtures ? line : () => 0;
    if (range) {
      res.writeHead(206, {...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': range.end - range.start + 1});
      return sendPaced(res, abs, range, pace, fromFixtures ? ttfbMs : 0);
    }
    res.writeHead(200, {...headers, 'Content-Length': size});
    sendPaced(res, abs, {start: 0, end: size - 1}, pace, fromFixtures ? ttfbMs : 0);
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
