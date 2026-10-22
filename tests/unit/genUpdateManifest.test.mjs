import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

// tools/gen-update-manifest.mjs points updates.json at the one .xpi in web-ext-artifacts/
// and stamps it with build_firefox_amo/manifest.json's version. It takes every path from
// its own place, so each run is a copy of it in a made-up tree, not the repository's.

/**
 * Runs a copy of the tool in a tree holding one xpi of the given name, at version 1.3.83.0.
 * @param {string} xpiName
 * @return {{dir: string, r: Object}} The tree (removed by the caller) and the run.
 */
function run(xpiName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-manifest-'));
  for (const sub of ['tools', 'build_firefox_amo', 'web-ext-artifacts']) {
    fs.mkdirSync(path.join(dir, sub));
  }
  fs.copyFileSync(path.join(import.meta.dirname, '..', '..', 'tools', 'gen-update-manifest.mjs'),
      path.join(dir, 'tools', 'gen-update-manifest.mjs'));
  fs.writeFileSync(path.join(dir, 'build_firefox_amo', 'manifest.json'), JSON.stringify({
    version: '1.3.83.0',
    browser_specific_settings: {gecko: {id: 'faststream@example.com', strict_min_version: '128.0'}},
  }));
  fs.writeFileSync(path.join(dir, 'web-ext-artifacts', xpiName), 'xpi bytes');
  const r = spawnSync(process.execPath, [path.join(dir, 'tools', 'gen-update-manifest.mjs'), 'owner/repo', 'v1.3.83.0'],
      {encoding: 'utf8', cwd: dir, timeout: 60000});
  return {dir, r};
}

describe('gen-update-manifest', () => {
  it('refuses a stale xpi left from an earlier run', () => {
    // One stale xpi passed the count check: updates.json advertised 1.3.83.0 with the old
    // file's link and hash, consistent, so Firefox installed 1.3.82.37 and offered 1.3.83.0
    // again for good.
    const {dir, r} = run('faststream-1.3.82.37.xpi');
    try {
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain('1.3.83.0');
      expect(fs.existsSync(path.join(dir, 'web-ext-artifacts', 'updates.json'))).toBe(false);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('writes updates.json for the xpi of the built version', () => {
    const {dir, r} = run('99f1b8e844554f46b28a-1.3.83.0.xpi');
    try {
      expect(r.status, r.stderr).toBe(0);
      const updates = JSON.parse(fs.readFileSync(path.join(dir, 'web-ext-artifacts', 'updates.json'), 'utf8'));
      const update = updates.addons['faststream@example.com'].updates[0];
      expect(update.version).toBe('1.3.83.0');
      expect(update.update_link).toMatch(/\/v1\.3\.83\.0\/99f1b8e844554f46b28a-1\.3\.83\.0\.xpi$/);
      expect(update.update_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
