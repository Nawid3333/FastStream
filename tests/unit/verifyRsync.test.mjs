import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

// tools/linux/verify.sh mirrors the working tree into its copy with rsync. This runs the
// script's own rsync line (read from the file, so the two cannot drift) over a made-up
// working tree and copy. It needs bash and rsync, as verify:linux and CI's Linux have; a
// Windows checkout without rsync skips it.

const hasRsync = spawnSync('bash', ['-c', 'command -v rsync'], {encoding: 'utf8'}).status === 0;

/**
 * The rsync command of verify.sh, its continued lines joined.
 * @return {string}
 */
function rsyncCommand() {
  const script = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'tools', 'linux', 'verify.sh'), 'utf8');
  const lines = [];
  for (const line of script.split('\n')) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].endsWith('\\')) {
      lines[last] = lines[last].slice(0, -1).trimEnd() + ' ' + line.trim();
    } else {
      lines.push(line);
    }
  }
  const command = lines.find((line) => line.startsWith('rsync '));
  expect(command, 'verify.sh has an rsync line').toBeTruthy();
  return command;
}

describe('verify.sh\'s copy of the working tree', () => {
  it.skipIf(!hasRsync)('drops a generated file ignored in both trees, and keeps what stays between runs', () => {
    // An exclude also protects the copy's matching files from deletion: a generated file
    // ignored before and after (a recut renames styp-<hash>.mjs) stayed in the copy for
    // good, and went into every local build.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-rsync-'));
    try {
      const src = path.join(base, 'src');
      const dst = path.join(base, 'dst');
      // The working tree has tests/e2e, as the repository does (only its fixtures are ignored).
      fs.mkdirSync(path.join(src, 'gen'), {recursive: true});
      fs.mkdirSync(path.join(src, 'tests', 'e2e'), {recursive: true});
      fs.writeFileSync(path.join(src, 'tests', 'e2e', 'spec.mjs'), 'spec\n');
      fs.writeFileSync(path.join(src, '.gitignore'), 'gen/\nnode_modules/\n');
      // Of another size than the copy's: rsync -a passes over a file of the same size and time.
      fs.writeFileSync(path.join(src, 'keep.txt'), 'the new text\n');
      for (const dir of ['gen', 'node_modules/pkg', '.git', 'tests/e2e/fixtures']) {
        fs.mkdirSync(path.join(dst, dir), {recursive: true});
      }
      fs.writeFileSync(path.join(dst, '.gitignore'), 'gen/\nnode_modules/\nlegacy.mjs\n');
      fs.writeFileSync(path.join(dst, 'keep.txt'), 'old\n');
      fs.writeFileSync(path.join(dst, 'gen', 'styp-OLD.mjs'), 'stale\n');
      fs.writeFileSync(path.join(dst, 'legacy.mjs'), 'stale\n');
      fs.writeFileSync(path.join(dst, 'node_modules', 'pkg', 'index.js'), 'kept\n');
      fs.writeFileSync(path.join(dst, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      fs.writeFileSync(path.join(dst, 'tests', 'e2e', 'fixtures', 'sample.mp4'), 'kept\n');

      const r = spawnSync('bash', ['-c', rsyncCommand()], {encoding: 'utf8', env: {...process.env, src, dst}});
      expect(r.status, r.stderr).toBe(0);
      expect(fs.readFileSync(path.join(dst, 'keep.txt'), 'utf8')).toBe('the new text\n');
      // One that stopped being ignored (#101), and one ignored in both trees: both gone.
      expect(fs.existsSync(path.join(dst, 'legacy.mjs'))).toBe(false);
      expect(fs.existsSync(path.join(dst, 'gen', 'styp-OLD.mjs'))).toBe(false);
      // What stays between runs, node_modules although .gitignore names it.
      expect(fs.existsSync(path.join(dst, '.git', 'HEAD'))).toBe(true);
      expect(fs.existsSync(path.join(dst, 'node_modules', 'pkg', 'index.js'))).toBe(true);
      expect(fs.existsSync(path.join(dst, 'tests', 'e2e', 'fixtures', 'sample.mp4'))).toBe(true);
    } finally {
      fs.rmSync(base, {recursive: true, force: true});
    }
  });
});
