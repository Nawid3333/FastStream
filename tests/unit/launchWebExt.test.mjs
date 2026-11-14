import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {nodeVersionNote, webExtSpawn} from '../../tools/rebuild.mjs';

// How `pnpm run start:ff` and `start:ff:fresh` start web-ext. They joined pnpm and its
// arguments into one string and spawned it with `shell: false` everywhere but Windows, so on
// Linux and macOS Node looked for a program named "pnpm exec web-ext run ..." and the launch
// died with spawn ENOENT after the whole rebuild (#165).

const root = path.resolve(import.meta.dirname, '..', '..');
const winDir = ['V:', 'work', 'wt', 'build_firefox_github'].join(path.win32.sep);
const winProfile = ['V:', 'work', 'wt', '.dev-profile'].join(path.win32.sep);

describe('webExtSpawn', () => {
  for (const platform of ['linux', 'darwin']) {
    it(`spawns pnpm itself on ${platform}, with every argument as it is`, () => {
      const dir = '/home/nawid/Fast Stream/build_firefox_github';
      expect(webExtSpawn(['run', '--source-dir', dir, '--arg=-no-remote'], platform)).toEqual({
        command: 'pnpm',
        args: ['exec', 'web-ext', 'run', '--source-dir', dir, '--arg=-no-remote'],
        shell: false,
      });
    });
  }

  it('gives Windows the same quoted command line as before', () => {
    const args = ['run', '--source-dir', winDir, '--target', 'firefox-desktop', '--firefox-profile', winProfile,
      '--profile-create-if-missing', '--keep-profile-changes', '--arg=-no-remote', '--arg=-new-instance'];
    // What tools/launch-ff.mjs built until #165, which works on Windows.
    const quote = (s) => s.includes(' ') ? `"${s}"` : s;
    const before = ['pnpm', 'exec', 'web-ext', 'run', '--source-dir', quote(winDir), '--target', 'firefox-desktop',
      '--firefox-profile', quote(winProfile), '--profile-create-if-missing', '--keep-profile-changes',
      '--arg=-no-remote', '--arg=-new-instance'].join(' ');
    expect(webExtSpawn(args, 'win32')).toEqual({command: before, args: [], shell: true});
  });

  it('quotes a Windows path that cmd.exe would split, a space or not', () => {
    // C:\dev\a&b: cmd ran `b\build_firefox_github ...` as a command of its own, and web-ext got
    // C:\dev\a (glm's review, 2026-10-22).
    const dir = ['C:', 'dev', 'a&b', 'build_firefox_github'].join(path.win32.sep);
    expect(webExtSpawn(['run', '--source-dir', dir], 'win32').command)
        .toBe(`pnpm exec web-ext run --source-dir "${dir}"`);
  });

  it('is what both launchers spawn', () => {
    for (const launcher of ['tools/launch-ff.mjs', 'tools/launch-ff-fresh.mjs']) {
      const text = fs.readFileSync(path.join(root, launcher), 'utf8');
      expect(text, launcher).toContain('= webExtSpawn([');
      expect(text, launcher).toMatch(/spawn\(command, args, \{[^}]*\bshell,/);
      expect(text, launcher).not.toContain('.join(\' \')');
    }
  });
});

describe('nodeVersionNote', () => {
  it('says so on a newer Node than the project is made for, where web-ext could not connect', () => {
    expect(nodeVersionNote('27.0.0-alpha', '26\n')).toMatch(/Node 27\.0\.0-alpha.*made for Node 26.*start it with Node 26/);
    expect(nodeVersionNote('28.1.0', 'v26.2.0')).toContain('Node 26');
  });

  it('says nothing on the project\'s Node or an older one', () => {
    expect(nodeVersionNote('26.6.1', '26\n')).toBeNull();
    expect(nodeVersionNote('22.3.0', '26')).toBeNull();
  });

  it('reads the project\'s Node from .nvmrc', () => {
    const wanted = Number(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8'));
    expect(nodeVersionNote(`${wanted + 1}.0.0`)).toContain(`made for Node ${wanted} `);
    expect(nodeVersionNote(`${wanted}.0.0`)).toBeNull();
  });

  it('is printed by both launchers before they start web-ext', () => {
    for (const launcher of ['launch-ff.mjs', 'launch-ff-fresh.mjs']) {
      const source = fs.readFileSync(path.join(root, 'tools', launcher), 'utf8');
      expect(source.indexOf('nodeVersionNote()'), launcher).toBeGreaterThan(-1);
      expect(source.indexOf('nodeVersionNote()'), launcher).toBeLessThan(source.indexOf('spawn(command'));
    }
  });
});
