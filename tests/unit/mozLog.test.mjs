import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {MozLogSpecs, mozLogHooks} from '../e2e/mozLog.mjs';

// The e2e hooks that give a listed spec's Firefox a MOZ_LOG, through the worker's
// environment, and keep the log only for a failed attempt (tests/e2e/mozLog.mjs).
describe('mozLogHooks', () => {
  let root;
  const listed = [...MozLogSpecs.keys()][0];
  const spec = (name) => [path.join('tests', 'e2e', 'specs', `${name}.e2e.mjs`)];
  const caps = () => ({'browserName': 'firefox', 'moz:firefoxOptions': {args: ['-headless']}});

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mozlog-'));
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  it('sets MOZ_LOG and MOZ_LOG_FILE in the worker\'s environment for a listed spec', () => {
    const env = {E2E_MOZ_LOG: '1', PATH: 'x'};
    const hooks = mozLogHooks(root, env);
    const capabilities = caps();
    hooks.beforeSession({}, capabilities, spec(listed));
    expect(env.MOZ_LOG).toBe(MozLogSpecs.get(listed));
    expect(path.dirname(path.dirname(env.MOZ_LOG_FILE))).toBe(root);
    expect(fs.existsSync(path.dirname(env.MOZ_LOG_FILE))).toBe(true);
    expect(env.PATH).toBe('x');
    expect(capabilities).toEqual(caps());
  });

  it('works on a spec given as a file: URL', () => {
    const env = {E2E_MOZ_LOG: '1'};
    const hooks = mozLogHooks(root, env);
    const file = path.resolve('tests', 'e2e', 'specs', `${listed}.e2e.mjs`);
    hooks.beforeSession({}, caps(), ['file:///' + file.replace(/\\/g, '/').replace(/^\//, '')]);
    expect(env.MOZ_LOG).toBe(MozLogSpecs.get(listed));
  });

  it('leaves every other spec, and every run without E2E_MOZ_LOG=1, alone', () => {
    for (const [env, name] of [[{E2E_MOZ_LOG: '1'}, 'playback'], [{}, listed], [{E2E_MOZ_LOG: '0'}, listed]]) {
      const hooks = mozLogHooks(root, env);
      hooks.beforeSession({}, caps(), spec(name));
      expect(env.MOZ_LOG).toBeUndefined();
      expect(env.MOZ_LOG_FILE).toBeUndefined();
      hooks.afterSession();
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('deletes the log of an attempt whose tests all passed, and clears the variables', () => {
    const env = {E2E_MOZ_LOG: '1'};
    const hooks = mozLogHooks(root, env);
    hooks.beforeSession({}, caps(), spec(listed));
    fs.writeFileSync(env.MOZ_LOG_FILE + '.moz_log', 'log');
    hooks.afterTest({}, {}, {passed: true});
    hooks.afterTest({}, {}, {passed: true});
    hooks.afterSession();
    expect(fs.readdirSync(root)).toEqual([]);
    expect(env.MOZ_LOG).toBeUndefined();
    expect(env.MOZ_LOG_FILE).toBeUndefined();
  });

  it('keeps the log of an attempt with a failed test, and starts the next attempt clean', () => {
    const env = {E2E_MOZ_LOG: '1'};
    const hooks = mozLogHooks(root, env);
    hooks.beforeSession({}, caps(), spec(listed));
    const kept = env.MOZ_LOG_FILE + '.moz_log';
    fs.writeFileSync(kept, 'log');
    hooks.afterTest({}, {}, {passed: true});
    hooks.afterTest({}, {}, {passed: false});
    hooks.afterSession();
    expect(fs.existsSync(kept)).toBe(true);
    expect(env.MOZ_LOG).toBeUndefined();

    // The retry is a new worker in the real run; the same hooks object must not carry
    // the failure over either.
    hooks.beforeSession({}, caps(), spec(listed));
    const retryLog = env.MOZ_LOG_FILE + '.moz_log';
    expect(retryLog).not.toBe(kept);
    fs.writeFileSync(retryLog, 'log');
    hooks.afterTest({}, {}, {passed: true});
    hooks.afterSession();
    expect(fs.existsSync(retryLog)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
  });
});
