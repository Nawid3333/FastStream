// A test-only native host: logs each message and its stdin's end to probe.log. PROBE_MODE: drop, silent, out, in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODES = ['drop', 'silent', 'out', 'in'];
const mode = MODES.find((name) => name === process.env.PROBE_MODE) || 'silent';
// Fixed, as run.mjs and probe.ps1 have it: Firefox starts this host with their environment.
const logFile = path.join(os.tmpdir(), 'faststream-idle-probe', 'probe.log');
const started = Date.now();
const log = (event, extra = {}) => fs.appendFileSync(logFile,
    JSON.stringify({event, mode, pid: process.pid, at: Date.now(), sinceStart: Date.now() - started, ...extra}) + '\n');

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

log('start');
let buffer = Buffer.alloc(0);
let messages = 0;
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) break;
    const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
    buffer = buffer.subarray(4 + length);
    messages++;
    if (message.type === 'hello') {
      log('hello');
      send({mode});
      if (mode === 'drop') {
        // The control: this side goes, the page has no port, and Firefox may idle it out.
        setTimeout(() => {
          log('drop');
          process.exit(0);
        }, 2000);
      }
      if (mode === 'in') {
        let n = 0;
        setInterval(() => send({type: 'line', n: n++}), 1000);
      }
    }
  }
});
process.stdin.on('end', () => {
  log('end', {messages});
  process.exit(0);
});
