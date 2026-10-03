import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {webExtSpawn} from '../../tools/rebuild.mjs';

// How `pnpm run start:ff` and `start:ff:fresh` start web-ext. They joined pnpm and its
// arguments into one string and spawned it with `shell: false` everywhere but Windows, so on
// Linux and macOS Node looked for a program named "pnpm exec web-ext run ..." and the launch
// died with spawn ENOENT after the whole rebuild (#165).

const root = path.resolve(import.meta.dirname, '..', '..');
const winDir = ['V:', 'Faststream modernisation', 'wt', 'build_firefox_github'].join(path.win32.sep);
const winProfile = ['V:', 'Faststream modernisation', 'wt', '.dev-profile'].join(path.win32.sep);

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

  it('is what both launchers spawn', () => {
    for (const launcher of ['tools/launch-ff.mjs', 'tools/launch-ff-fresh.mjs']) {
      const text = fs.readFileSync(path.join(root, launcher), 'utf8');
      expect(text, launcher).toContain('= webExtSpawn([');
      expect(text, launcher).toMatch(/spawn\(command, args, \{[^}]*\bshell,/);
      expect(text, launcher).not.toContain('.join(\' \')');
    }
  });
});
