#!/usr/bin/env node
// Lists the patched libraries (pnpm-workspace.yaml, patchedDependencies) that have a newer
// release than the version the patch is cut against.
//
// Dependabot ignores these libraries on purpose (.github/dependabot.yml): a bump leaves the
// patch unapplied, so its PR could only fail. This is how their updates are still noticed -
// .github/workflows/patched-libraries.yml runs it daily, and for each new version opens a pull
// request when tools/recut-patch.mjs moves the patch cleanly, or an issue when it cannot.
//
// A library from npm is checked against the registry's `latest` tag; one installed from
// GitHub (`github:owner/repo#tag` in package.json) against that repository's latest release.
//
// Usage: node tools/check-patched-updates.mjs [--json]
//   prints a table, or with --json one {name, current, latest, url} object per line for
//   every library, behind or not (the workflow needs both, to close issues as well as open them).

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} yaml - pnpm-workspace.yaml.
 * @return {Array<{name: string, version: string}>} The patched libraries.
 */
export function patchedDependencies(yaml) {
  const block = /^patchedDependencies:\s*\n((?:[ \t]+.*\n?)*)/m.exec(yaml);
  if (!block) return [];
  return [...block[1].matchAll(/^\s+['"]?(@?[^@\s'"]+)@([^:'"\s]+)['"]?\s*:/gm)]
      .map(([, name, version]) => ({name, version}));
}

/**
 * The libraries tools/sync-vendor.mjs marks `patched` whose patch pnpm does not apply: one
 * with no patchedDependencies entry, or installed at another version than its patch is cut
 * against. Either would be copied without FastStream's changes, with the build green (#176).
 * @param {Array<{name: string, patched?: boolean}>} vendor - sync-vendor.mjs's list.
 * @param {string} yaml - pnpm-workspace.yaml.
 * @param {function(string): ?string} installed - A library's installed version, null if none.
 * @return {string[]} One message per such library.
 */
export function unappliedPatches(vendor, yaml, installed) {
  const patches = patchedDependencies(yaml);
  const problems = [];
  for (const name of new Set(vendor.filter((lib) => lib.patched).map((lib) => lib.name))) {
    const patch = patches.find((entry) => entry.name === name);
    const version = installed(name);
    if (!patch) {
      problems.push(`${name} is marked patched in tools/sync-vendor.mjs, but pnpm-workspace.yaml's ` +
        'patchedDependencies has no entry for it, so it would ship without FastStream\'s changes. If ' +
        'every change has landed upstream (tools/recut-patch.mjs says so), take its marks out.');
    } else if (version && version !== patch.version) {
      problems.push(`${name} ${version} is installed, but its patch is cut against ${patch.version}: ` +
        'run pnpm install, or re-cut the patch (docs/updating-patched-libraries.md).');
    }
  }
  return problems;
}

/**
 * Compares two versions part by part, numerically; a leading v is ignored and a missing
 * part counts as 0. Pre-release suffixes are not expected here (only `latest` is read).
 * @param {string} a
 * @param {string} b
 * @return {number} Negative when a is older, 0 when equal, positive when newer.
 */
export function compareVersions(a, b) {
  const parts = (v) => String(v).replace(/^v/i, '').split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function getJson(url) {
  const headers = {'accept': 'application/json', 'user-agent': 'faststream-check-patched-updates'};
  if (url.startsWith('https://api.github.com/') && process.env.GH_TOKEN) {
    headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  const response = await fetch(url, {headers});
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * @param {string} name - The package name.
 * @param {string} spec - Its specifier in package.json.
 * @return {Promise<{latest: string, url: string}>}
 */
/**
 * The repository of a library installed from GitHub.
 * @param {string} [spec] - Its specifier in package.json, `github:owner/repo#ref`.
 * @return {{owner: string, repo: string}|null} Null for anything else (an npm range).
 */
export function githubRepo(spec) {
  // The #ref is part of every such spec (Coloris: github:mdbassit/Coloris#v0.25.0); a
  // pattern that ended at the repo name sent Coloris to the npm registry, which has no
  // such package (2026-10-02).
  const github = /^github:([^/#]+)\/([^/#]+)(?:#.*)?$/.exec(spec || '');
  if (!github) return null;
  if (!/^[\w.-]+$/.test(github[1]) || !/^[\w.-]+$/.test(github[2])) {
    throw new Error(`${spec}: not an owner/repo pair`);
  }
  return {owner: github[1], repo: github[2]};
}

async function latestRelease(name, spec) {
  // Both hosts are pinned; the name comes from this repo's package.json
  // (CodeQL js/request-forgery).
  const github = githubRepo(spec);
  if (github) {
    const release = await getJson(`https://api.github.com/repos/${github.owner}/${github.repo}/releases/latest`);
    return {latest: release.tag_name.replace(/^v/i, ''), url: release.html_url};
  }
  if (!/^[^/]+(\/[^/]+)?$/.test(name)) throw new Error(`${name}: not an npm package name`);
  const info = await getJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  const latest = info['dist-tags'].latest;
  return {latest, url: `https://www.npmjs.com/package/${encodeURIComponent(name)}/v/${encodeURIComponent(latest)}`};
}

async function main() {
  const json = process.argv.includes('--json');
  const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const specs = {...pkg.dependencies, ...pkg.devDependencies};

  const libraries = patchedDependencies(yaml);
  if (libraries.length === 0) {
    throw new Error('no patchedDependencies found in pnpm-workspace.yaml');
  }

  const results = [];
  for (const {name, version} of libraries) {
    const {latest, url} = await latestRelease(name, specs[name]);
    results.push({name, current: version, latest, url, behind: compareVersions(latest, version) > 0});
  }

  if (json) {
    for (const result of results) console.log(JSON.stringify(result));
    return;
  }
  for (const {name, current, latest, behind} of results) {
    console.log(`${behind ? 'UPDATE' : 'ok    '}  ${name.padEnd(12)} ${current.padEnd(10)} latest ${latest}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
