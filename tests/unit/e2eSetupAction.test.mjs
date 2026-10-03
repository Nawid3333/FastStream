import fs from 'node:fs';
import path from 'node:path';

// js-yaml 5 has no default export, only named ones; this form reads 4 and 5 alike.
import * as yaml from 'js-yaml';
import {describe, expect, it} from 'vitest';

import {MP4_FIXTURE} from '../e2e/mp4Fixture.mjs';

// How .github/actions/e2e-setup keeps sample.mp4 in the Actions cache (#256): restored
// under the SHA-256 it is pinned to, checked (and fetched when the cache had none or
// another file), and saved only after that check, only when the cache had no entry.
// Its shell steps are tests/workflows/e2e-setup.test.sh's.

const root = path.resolve(import.meta.dirname, '../..');
const action = yaml.load(fs.readFileSync(path.join(root, '.github/actions/e2e-setup/action.yml'), 'utf8'));
const steps = action.runs.steps;
const step = (name) => {
  const found = steps.filter((s) => s.name === name);
  expect(found, name).toHaveLength(1);
  return found[0];
};

describe('the e2e setup action', () => {
  const pin = step('Read the MP4 fixture\'s pin');
  const restore = step('Restore the MP4 fixture from the cache');
  const check = step('Check the MP4 fixture, or fetch it');
  const save = step('Save the MP4 fixture to the cache');

  it('restores, checks, then saves the MP4 fixture, in that order', () => {
    const at = (s) => steps.indexOf(s);
    expect(at(pin)).toBeLessThan(at(restore));
    expect(at(restore)).toBeLessThan(at(check));
    expect(at(check)).toBeLessThan(at(save));
    expect(check.run.trim()).toBe('node tests/e2e/mp4FixtureCli.mjs ensure');
  });

  it('keys the cache on the pinned SHA-256, at the fixture\'s own path', () => {
    expect(pin.id).toBe('mp4-pin');
    expect(pin.run).toContain('node tests/e2e/mp4FixtureCli.mjs pin');
    for (const s of [restore, save]) {
      expect(s.with.key).toBe('e2e-sample-mp4-${{ steps.mp4-pin.outputs.sha256 }}');
      expect(s.with.path).toBe(path.relative(root, MP4_FIXTURE).replaceAll(path.sep, '/'));
    }
  });

  it('saves only when the cache had no entry for the key', () => {
    expect(restore.id).toBe('mp4-cache');
    expect(save.if).toBe('steps.mp4-cache.outputs.cache-hit != \'true\'');
  });

  it('pins the cache actions by commit, the same release for both', () => {
    const [, restoreSha] = /^actions\/cache\/restore@([0-9a-f]{40})$/.exec(restore.uses) || [];
    const [, saveSha] = /^actions\/cache\/save@([0-9a-f]{40})$/.exec(save.uses) || [];
    expect(restoreSha).toMatch(/^[0-9a-f]{40}$/);
    expect(saveSha).toBe(restoreSha);
  });

  it('gives Firefox a sound device on Linux only', () => {
    expect(step('Give Firefox a sound device').if).toBe('runner.os == \'Linux\'');
  });
});
