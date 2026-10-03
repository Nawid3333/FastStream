import {spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

// generate-locales.mjs (pnpm run gen-locale), which translates combined-locales.json through
// the OpenAI API. It only checked a --lang code's shape after every batch had been paid for,
// its help named the wrong default model and thread count, and a request that never got an
// answer waited forever (#246). Nothing here reaches the real API: there is no key, or the
// base URL points at a local server.

const script = path.resolve(import.meta.dirname, '..', '..', 'generate-locales.mjs');
let tmp;
let input;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-locales-'));
  input = path.join(tmp, 'combined-locales.json');
  fs.writeFileSync(input, JSON.stringify({hello: {en: 'Hello', de: 'Hallo'}}, null, 4));
});
afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

// Runs the script; the test's own deadline ends it if it does not end by itself.
function run(args, env = {}, deadlineMs = 25000) {
  return new Promise((resolve) => {
    const childEnv = {...process.env, ...env};
    delete childEnv.OPENAI_API_KEY;
    if (env.OPENAI_API_KEY) childEnv.OPENAI_API_KEY = env.OPENAI_API_KEY;
    const child = spawn(process.execPath, [script, ...args], {env: childEnv});
    let out = '';
    child.stdout.on('data', (d) => out += d);
    child.stderr.on('data', (d) => out += d);
    const deadline = setTimeout(() => child.kill(), deadlineMs);
    child.on('exit', (status) => {
      clearTimeout(deadline);
      resolve({status, out});
    });
  });
}

describe('generate-locales.mjs', () => {
  it('refuses a malformed --lang before translating anything', async () => {
    const before = fs.readFileSync(input, 'utf8');
    for (const lang of ['french', 'zh-cn', '__proto__']) {
      const {status, out} = await run(['--lang', lang, '--input', input]);
      expect(status, lang).toBe(1);
      expect(out, lang).toContain('--lang');
      expect(out, lang).toContain('zh_CN');
      expect(out, lang).not.toContain('Translating');
    }
    expect(fs.readFileSync(input, 'utf8')).toBe(before);
  });

  it('takes the locale codes the extension uses', async () => {
    for (const lang of ['fr', 'pt_BR', 'zh_CN', 'zh_TW']) {
      // No API key: it gets as far as the first request, and no further.
      const {status, out} = await run(['--lang', lang, '--input', input]);
      expect(status, lang).toBe(1);
      expect(out, lang).toContain('Translating 1 keys');
      expect(out, lang).toContain('OPENAI_API_KEY is not set');
    }
  });

  it('names the defaults it uses in its help', async () => {
    const {status, out} = await run(['--help'], {OPENAI_MODEL: ''});
    expect(status).toBe(0);
    expect(out).toContain('(default: OPENAI_MODEL or gpt-5-mini)');
    expect(out).toMatch(/--threads <n>\s+Number of concurrent batches \(default: 10\)/);
    expect(out).not.toContain('zh-cn');
  });

  it('gives up on a request that gets no answer', async () => {
    // Accepts the connection and never answers, not even the TLS handshake.
    const sockets = [];
    const server = net.createServer((socket) => {
      socket.on('error', () => {}); // the script's end resets it
      sockets.push(socket);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const started = Date.now();
      const {status, out} = await run(['--lang', 'fr', '--input', input, '--timeout', '1'], {
        OPENAI_API_KEY: 'test-key-not-real',
        OPENAI_BASE_URL: `https://127.0.0.1:${server.address().port}`,
      });
      expect(out).toContain('no answer');
      expect(status).toBe(1);
      expect(Date.now() - started).toBeLessThan(20000); // about 6 s here; it waited forever
      expect(sockets.length).toBe(3); // the three attempts
    } finally {
      sockets.forEach((s) => s.destroy());
      await new Promise((resolve) => server.close(resolve));
    }
  }, 30000);
});
