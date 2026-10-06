import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

// tools/cut-release.mjs (pnpm run release <version>) run for real in a scratch clone whose
// origin is a local bare repository. It pushed the branch and then the tag; when the tag
// push failed, main kept "chore: release X" without its tag: never built, skipped by
// auto-release.yml as a release bump, and passed by the next build number (#171).

const script = path.resolve(import.meta.dirname, '../../tools/cut-release.mjs');
let dir;

afterEach(() => {
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = undefined;
});

const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();

/**
 * A clone at 1.3.82.52 with the script in its tools/, and its bare origin.
 * @return {{work: string, origin: string}}
 */
function repo() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-release-'));
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  git(dir, 'init', '-q', '--bare', origin);
  git(dir, 'init', '-q', '-b', 'main', work);
  for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.com'],
    ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) {
    git(work, 'config', key, value);
  }
  fs.mkdirSync(path.join(work, 'chrome'));
  fs.mkdirSync(path.join(work, 'tools'));
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({name: 'x', version: '1.3.82.52'}, null, 2) + '\n');
  fs.writeFileSync(path.join(work, 'chrome/manifest.json'), JSON.stringify({version: '1.3.82.52'}, null, 2) + '\n');
  fs.copyFileSync(script, path.join(work, 'tools/cut-release.mjs'));
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'start');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  return {work, origin};
}

const cut = (work, version) => spawnSync(process.execPath, ['tools/cut-release.mjs', version], {cwd: work, encoding: 'utf8'});
const ref = (repoDir, name) => {
  const r = spawnSync('git', ['rev-parse', '-q', '--verify', name], {cwd: repoDir, encoding: 'utf8'});
  return r.status === 0 ? r.stdout.trim() : null;
};

// Each test runs some fifteen git and node processes: 1-2.5 s on a Windows runner, once 6.9 s
// (PR #351, 2026-10-06), past the 5 s default.
describe('cut-release.mjs', {timeout: 30000}, () => {
  it('pushes the release commit and its tag', () => {
    const {work, origin} = repo();
    const result = cut(work, '1.3.90.0');
    expect(result.status, result.stderr).toBe(0);
    expect(git(origin, 'log', '-1', '--format=%s', 'main')).toBe('chore: release 1.3.90.0');
    expect(ref(origin, 'refs/tags/v1.3.90.0^{commit}')).toBe(ref(origin, 'main'));
  });

  it('refuses a version origin has tagged, before committing anything', () => {
    const {work, origin} = repo();
    git(work, 'tag', 'v1.3.90.0');
    git(work, 'push', '-q', 'origin', 'v1.3.90.0');
    git(work, 'tag', '-d', 'v1.3.90.0');
    const start = ref(work, 'HEAD');
    const result = cut(work, '1.3.90.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already tagged on origin');
    expect(ref(work, 'HEAD')).toBe(start);
    expect(ref(origin, 'main')).toBe(start);
  });

  it('leaves origin as it was when the tag is refused: no release commit without its tag', () => {
    const {work, origin} = repo();
    // The remote refuses every tag, as it would one it already had.
    const hook = path.join(origin, 'hooks', 'update');
    fs.writeFileSync(hook, '#!/bin/sh\ncase "$1" in refs/tags/*) echo "no tags here" >&2; exit 1 ;; esac\nexit 0\n');
    fs.chmodSync(hook, 0o755);
    const start = ref(origin, 'main');
    const result = cut(work, '1.3.90.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('neither main nor v1.3.90.0 reached origin');
    expect(ref(origin, 'main')).toBe(start);
    expect(ref(origin, 'refs/tags/v1.3.90.0')).toBe(null);
  });
});
