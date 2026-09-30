import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as url from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {recordRetriedSpecs} from '../e2e/retriedSpecs.mjs';

// A spec file that failed and passed on its retry left a green run and no trace; CI now
// lists these (ci.yml) and flaky-specs.yml reports a week of them. The hook tells a retry
// by its worker id ending a second time, as driverLogs.mjs names the attempts' logs.

const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const spec = url.pathToFileURL(path.join(repo, 'tests/e2e/specs/save-fmp4.e2e.mjs')).href;
let dir;

const records = () => {
  const file = path.join(dir, 'retried.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retried-'));
});
afterEach(() => {
  fs.rmSync(dir, {recursive: true, force: true});
});

describe('recordRetriedSpecs', () => {
  it('records nothing for spec files that passed or failed on their only run', () => {
    const hook = recordRetriedSpecs(dir, 'web');
    hook('0-0', 0, [spec]);
    hook('0-1', 1, [spec]);
    expect(records()).toEqual([]);
  });

  it('records a spec file that passed on its retry, with its path from the repository', () => {
    const hook = recordRetriedSpecs(dir, 'ext-amo');
    hook('0-3', 1, [spec]);
    hook('0-3', 0, [spec]);
    expect(records()).toEqual([{
      suite: 'ext-amo', spec: 'tests/e2e/specs/save-fmp4.e2e.mjs', attempts: 2, passed: true, os: process.platform,
    }]);
  });

  it('records one that failed twice as not passed', () => {
    const hook = recordRetriedSpecs(dir, 'web');
    hook('0-2', 1, [spec]);
    hook('0-2', 1, [spec]);
    expect(records().map((r) => r.passed)).toEqual([false]);
  });

  it('keeps each attempt\'s driver log, as before', () => {
    const hook = recordRetriedSpecs(dir, 'web');
    fs.writeFileSync(path.join(dir, 'wdio-0-4-geckodriver.log'), 'first');
    hook('0-4', 1, [spec]);
    fs.writeFileSync(path.join(dir, 'wdio-0-4-geckodriver.log'), 'retry');
    hook('0-4', 0, [spec]);
    expect(fs.readFileSync(path.join(dir, 'geckodriver-web-save-fmp4-0-4-attempt1.log'), 'utf8')).toBe('first');
    expect(fs.readFileSync(path.join(dir, 'geckodriver-web-save-fmp4-0-4-attempt2.log'), 'utf8')).toBe('retry');
  });
});
