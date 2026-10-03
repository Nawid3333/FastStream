import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {compareVersions, githubRepo, patchedDependencies} from '../../tools/check-patched-updates.mjs';

// The patched libraries are left out of Dependabot, and this script is what still notices
// their updates. Reading the list wrongly, or comparing versions as text, would hide an
// update without a word.

const yaml = fs.readFileSync(new URL('../../pnpm-workspace.yaml', import.meta.url), 'utf8');

describe('patchedDependencies', () => {
  it('reads every patched library with the version its patch is cut against', () => {
    const libraries = patchedDependencies(yaml);
    expect(libraries.length).toBeGreaterThanOrEqual(6);
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

  it('pins each patched library in package.json to exactly the version its patch is cut against', () => {
    // A range ("^1.7.3") lets any non-frozen install take 1.7.4, which the patch is not keyed
    // to: pnpm then fails, or ships the library unpatched (#247).
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const declared = {...pkg.dependencies, ...pkg.devDependencies};
    for (const {name, version} of patchedDependencies(yaml)) {
      // An exact version, or a git spec pinned to that version's tag (Coloris: github:…#v0.25.0).
      const spec = declared[name] || '';
      const exact = spec === version || spec.endsWith(`#v${version}`) || spec.endsWith(`#${version}`);
      expect(exact, `${name}: "${spec}"`).toBe(true);
    }
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
    expect(copied.size).toBeGreaterThanOrEqual(11);
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

describe('githubRepo', () => {
  it('reads every library package.json installs from GitHub, with its #ref', () => {
    // Coloris is the one today; read wrongly, the daily check asked npm for it and failed.
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const specs = {...pkg.dependencies, ...pkg.devDependencies};
    expect(githubRepo(specs.Coloris)).toEqual({owner: 'mdbassit', repo: 'Coloris'});
    for (const [name, spec] of Object.entries(specs)) {
      if (String(spec).startsWith('github:')) expect(githubRepo(spec), name).not.toBe(null);
    }
  });

  it('takes a spec with or without a ref, and nothing else', () => {
    expect(githubRepo('github:owner/repo')).toEqual({owner: 'owner', repo: 'repo'});
    expect(githubRepo('github:owner/repo#v1.2.3')).toEqual({owner: 'owner', repo: 'repo'});
    expect(githubRepo('^1.2.3')).toBe(null);
    expect(githubRepo(undefined)).toBe(null);
    expect(githubRepo('github:owner/repo/extra')).toBe(null);
    expect(() => githubRepo('github:own er/repo')).toThrow('not an owner/repo pair');
  });
});
