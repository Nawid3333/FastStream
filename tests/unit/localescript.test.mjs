import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

// localescript.mjs, which every build runs (with no arguments: it checks the locale files'
// keys). It reads its paths from where it sits, so each test runs a copy in a temp tree.
// Without combined-locales.json it threw "Cannot read properties of undefined (reading
// 'get')", failing the build, and `--whitelist` as the last argument threw on .split (#178).

const root = path.resolve(import.meta.dirname, '..', '..');
let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localescript-'));
  fs.copyFileSync(path.join(root, 'localescript.mjs'), path.join(tmp, 'localescript.mjs'));
  for (const [locale, messages] of Object.entries({
    en: {hello: {message: 'Hello'}, bye: {message: 'Bye', description: 'Farewell'}},
    de: {hello: {message: 'Hallo'}},
  })) {
    fs.mkdirSync(path.join(tmp, 'chrome', '_locales', locale), {recursive: true});
    fs.writeFileSync(path.join(tmp, 'chrome', '_locales', locale, 'messages.json'), JSON.stringify(messages, null, 4));
  }
});
afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

const run = (...args) => {
  const r = spawnSync(process.execPath, [path.join(tmp, 'localescript.mjs'), ...args], {encoding: 'utf8', timeout: 30000});
  return {status: r.status, out: r.stdout + r.stderr};
};

describe('localescript.mjs without combined-locales.json', () => {
  it('checks the locale files, as the build runs it', () => {
    const {status, out} = run();
    expect(out).not.toMatch(/TypeError|Cannot read/);
    expect(out).toContain('Missing keys in de: [ \'bye\' ]');
    expect(status).toBe(0);
  });

  it('combines the locale files into a new combined-locales.json', () => {
    expect(run('--combine').status).toBe(0);
    const combined = JSON.parse(fs.readFileSync(path.join(tmp, 'combined-locales.json'), 'utf8'));
    expect(combined).toEqual({
      hello: {en: 'Hello', de: 'Hallo'},
      bye: {en: 'Bye', description: 'Farewell'},
    });
  });

  it('refuses to split, saying why, and leaves the locale files alone', () => {
    const before = fs.readFileSync(path.join(tmp, 'chrome', '_locales', 'de', 'messages.json'), 'utf8');
    const {status, out} = run('--split');
    expect(status).toBe(1);
    expect(out).toContain('combined-locales.json');
    expect(out).not.toMatch(/TypeError|Cannot read/);
    expect(fs.readFileSync(path.join(tmp, 'chrome', '_locales', 'de', 'messages.json'), 'utf8')).toBe(before);
  });
});

describe('localescript.mjs --whitelist', () => {
  it('asks for the list when none follows', () => {
    for (const args of [['--combine', '--whitelist'], ['--whitelist', '--combine']]) {
      const {status, out} = run(...args);
      expect(status, args.join(' ')).toBe(1);
      expect(out, args.join(' ')).toContain('--whitelist needs');
      expect(fs.existsSync(path.join(tmp, 'combined-locales.json')), args.join(' ')).toBe(false);
    }
  });

  it('takes a list', () => {
    expect(run('--combine', '--whitelist', 'en').status).toBe(0);
    const combined = JSON.parse(fs.readFileSync(path.join(tmp, 'combined-locales.json'), 'utf8'));
    expect(combined.hello).toEqual({en: 'Hello'});
  });
});
