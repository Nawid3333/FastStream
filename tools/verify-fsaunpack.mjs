#!/usr/bin/env node
// Starts fsaunpack/testserver.mjs on a recorded archive and checks what it serves.
//
// fsaunpack is a helper outside the extension, with its own package.json and npm
// lockfile. Before this, CI neither installed nor ran it, so a Dependabot pull request
// for its express passed CI without the server ever starting. This installs its
// lockfile as it stands (npm ci, with install scripts off: npm runs them by default)
// and serves paths that hold ':', '(', ')' and '*', which express reads as route syntax.
//
// Run with: pnpm run verify:fsaunpack   (npm ci needs network)

import {execSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'fsaunpack');

execSync('npm ci --ignore-scripts --no-audit --no-fund', {cwd: dir, stdio: 'inherit'});
const expressVersion = JSON.parse(
    fs.readFileSync(path.join(dir, 'node_modules/express/package.json'), 'utf8')).version;

// An archive as unpack.mjs writes it: header.json, then <i>.json and <i>.txt or <i>.bin.
const entries = [
  {url: 'https://cdn.example/v/master.m3u8', responseType: 'text', data: '#EXTM3U\n'},
  {url: 'https://cdn.example/seg(1)*:2.ts', responseType: 'arraybuffer', data: Buffer.from([0x47, 0x40, 0x11, 0x10])},
  // A second recording of the first URL: the first one is served.
  {url: 'https://cdn.example/v/master.m3u8?retry=1', responseType: 'text', data: 'the second recording\n'},
];
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fsaunpack-'));
const output = path.join(work, 'output');
fs.mkdirSync(output);
fs.writeFileSync(path.join(output, 'header.json'), JSON.stringify({number_of_entries: entries.length}));
entries.forEach((entry, i) => {
  fs.writeFileSync(path.join(output, `${i}.json`), JSON.stringify({url: entry.url, responseType: entry.responseType}));
  fs.writeFileSync(path.join(output, `${i}.${entry.responseType === 'arraybuffer' ? 'bin' : 'txt'}`), entry.data);
});

/**
 * @return {?string} An IPv4 address of this machine that is not the loopback one, if any.
 */
function notLoopbackAddress() {
  const found = Object.values(os.networkInterfaces()).flat()
      .find((address) => address && (address.family === 'IPv4' || address.family === 4) && !address.internal);
  return found ? found.address : null;
}

/**
 * Whether a TCP connection to an address and port is accepted within 3 s.
 * @param {string} host - The address.
 * @param {number} port - The port.
 * @return {Promise<boolean>}
 */
function reachable(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(3000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const {port: free} = probe.address();
    probe.close(() => resolve(free));
  });
});

const server = spawn(process.execPath, [path.join(dir, 'testserver.mjs')], {
  cwd: work,
  env: {...process.env, PORT: String(port)},
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (chunk) => log += chunk);
server.stderr.on('data', (chunk) => log += chunk);

const failures = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the server did not start within 20 s')), 20000);
    server.once('exit', (code) => reject(new Error(`the server exited with code ${code}`)));
    const check = () => /Listening on port/.test(log) ? (clearTimeout(timer), resolve()) : setTimeout(check, 100);
    check();
  });

  const get = async (pathname) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
    return {status: response.status, cors: response.headers.get('access-control-allow-origin'),
      rateLimit: response.headers.get('ratelimit-policy'), body: Buffer.from(await response.arrayBuffer())};
  };
  const expect = async (pathname, status, body) => {
    const got = await get(pathname);
    if (got.status !== status) failures.push(`${pathname}: HTTP ${got.status}, expected ${status}`);
    if (body === undefined) return;
    if (!got.body.equals(Buffer.from(body))) failures.push(`${pathname}: served ${JSON.stringify(got.body.toString())}`);
    if (got.cors !== '*') failures.push(`${pathname}: Access-Control-Allow-Origin is ${got.cors}, expected *`);
  };
  await expect('/v/master.m3u8', 200, entries[0].data);
  await expect('/seg(1)*:2.ts', 200, entries[1].data);
  await expect('/not-recorded.ts', 404);

  // Every request goes through the rate limiter (CodeQL's js/missing-rate-limiting).
  const limited = await get('/v/master.m3u8');
  if (!limited.rateLimit) failures.push('/v/master.m3u8: no RateLimit-Policy header, so no rate limiter');

  // Only this machine reaches it: an archive's manifests can hold a CDN's tokens.
  const outside = notLoopbackAddress();
  if (outside && await reachable(outside, port)) {
    failures.push(`the server answers on ${outside}, not only on 127.0.0.1`);
  }
} catch (e) {
  failures.push(e.message);
} finally {
  // Windows keeps a running process's files; remove them once it is gone.
  const exited = server.exitCode !== null || server.signalCode !== null ? Promise.resolve() : new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  await exited;
  fs.rmSync(work, {recursive: true, force: true});
}

if (failures.length) {
  console.error(`fsaunpack, express ${expressVersion}:\n  ${failures.join('\n  ')}\nserver output:\n${log}`);
  process.exit(1);
}
console.log(`fsaunpack, express ${expressVersion}: the test server serves a recorded archive.`);
