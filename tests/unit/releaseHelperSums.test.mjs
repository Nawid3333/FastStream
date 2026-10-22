import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// mpv-config's one-click installer downloads the helper's install.ps1 and
// faststream-mpv-host.mjs from a release's tag and runs them: only when both match the
// release's native-host.sha256. Every release must publish that list, signed or not (the
// helper does not wait for AMO), with both files in it.

const root = path.resolve(import.meta.dirname, '..', '..');
const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');

describe('release.yml', () => {
  it('lists the helper\'s two files with their SHA-256', () => {
    expect(release).toMatch(/cd native-host\s+sha256sum install\.ps1 faststream-mpv-host\.mjs > \.\.\/built\/native-host\.sha256/);
    for (const name of ['install.ps1', 'faststream-mpv-host.mjs']) {
      expect(fs.existsSync(path.join(root, 'native-host', name)), name).toBe(true);
    }
  });

  it('publishes that list with every release, before the signed files are added', () => {
    const assets = release.match(/assets=\(\n([\s\S]*?)\n\s*\)/);
    expect(assets).not.toBeNull();
    expect(assets[1]).toContain('built/native-host.sha256');
    // written before it is published
    expect(release.indexOf('> ../built/native-host.sha256')).toBeLessThan(release.indexOf('built/native-host.sha256\n'));
  });
});
