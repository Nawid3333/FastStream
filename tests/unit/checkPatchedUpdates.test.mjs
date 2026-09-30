import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {compareVersions, patchedDependencies} from '../../tools/check-patched-updates.mjs';

// The patched libraries are left out of Dependabot, and this script is what still notices
// their updates. Reading the list wrongly, or comparing versions as text, would hide an
// update without a word.

const yaml = fs.readFileSync(new URL('../../pnpm-workspace.yaml', import.meta.url), 'utf8');

describe('patchedDependencies', () => {
  it('reads every patched library with the version its patch is cut against', () => {
    const libraries = patchedDependencies(yaml);
    expect(libraries.length).toBeGreaterThanOrEqual(7);
    expect(libraries).toContainEqual({name: 'hls.js', version: '1.7.3'});
    expect(libraries).toContainEqual({name: 'Coloris', version: '0.25.0'});
    for (const {name, version} of libraries) {
      expect(fs.existsSync(new URL(`../../patches/${name}@${version}.patch`, import.meta.url)), name).toBe(true);
    }
  });

  it('reads scoped names and quoted keys, and stops at the next section', () => {
    const text = 'packages: []\npatchedDependencies:\n  \'@scope/lib@1.2.3\': patches/a.patch\n  plain@4.5.6: patches/b.patch\nonlyBuilt:\n  - x@1.0.0: y\n';
    expect(patchedDependencies(text)).toEqual([
      {name: '@scope/lib', version: '1.2.3'},
      {name: 'plain', version: '4.5.6'},
    ]);
    expect(patchedDependencies('packages: []\n')).toEqual([]);
  });

  it('is the list Dependabot is told to ignore', () => {
    const dependabot = fs.readFileSync(new URL('../../.github/dependabot.yml', import.meta.url), 'utf8');
    const ignored = [...dependabot.matchAll(/dependency-name: '([^']+)'/g)].map((match) => match[1]).sort();
    expect(ignored).toEqual(patchedDependencies(yaml).map(({name}) => name).sort());
  });

  it('leaves the other libraries the build copies to Dependabot\'s shipped group', () => {
    // In the tooling group, a shipped library's update would make the whole tooling pull
    // request change the extension, and wait for the owner (update-prs.yml).
    const dependabot = fs.readFileSync(new URL('../../.github/dependabot.yml', import.meta.url), 'utf8');
    const ignored = new Set([...dependabot.matchAll(/dependency-name: '([^']+)'/g)].map((match) => match[1]));
    const vendor = fs.readFileSync(new URL('../../tools/sync-vendor.mjs', import.meta.url), 'utf8');
    // A package name after node_modules/, ended by a path separator or the string's end.
    const copied = new Set([...vendor.matchAll(/node_modules\/((?:@[\w.-]+\/)?[\w.-]+)(?=[/'"`])/g)].map((match) => match[1]));
    expect(copied.size).toBeGreaterThanOrEqual(12);
    const names = (list) => {
      expect(list).not.toBeNull();
      return [...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
    };
    const patterns = names(dependabot.match(/shipped-minor-and-patch:\n\s+patterns: \[([^\]]*)\]/));
    expect(patterns).toEqual([...copied].filter((name) => !ignored.has(name)).sort());
    // The tooling group leaves out the same names.
    expect(names(dependabot.match(/tooling-minor-and-patch:\n\s+exclude-patterns: \[([^\]]*)\]/))).toEqual(patterns);
  });
});

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('11.26.25', '11.26.3')).toBeGreaterThan(0);
    expect(compareVersions('2.4.1', '0.5.3')).toBeGreaterThan(0);
    expect(compareVersions('5.1.0', '5.2.1')).toBeLessThan(0);
  });

  it('ignores a leading v and treats a missing part as 0', () => {
    expect(compareVersions('v0.25.0', '0.25.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0);
  });
});
