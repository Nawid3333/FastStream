#!/usr/bin/env node
// Reports the development-toolchain updates worth a decision; run weekly by
// .github/workflows/toolchain-updates.yml, which keeps one issue per update.
//
// Only moves that need one are tracked, not every release (pnpm ships a new 11.x almost
// weekly; those wait for a batched update):
//   - Node.js: a newer LTS major than the one CI and .nvmrc use. Node never runs inside
//     the extension - it builds and tests it - so this is about staying on a supported
//     release, and matching the maintainer's machine.
//   - pnpm: a newer major than the pinned one, reported only once nothing blocks it. pnpm
//     12 writes pnpm-lock.yaml as two YAML documents; GitHub's dependency graph reads the
//     first, which holds only pnpm's own binaries, and so sees none of the project's
//     dependencies - Dependabot alerts and dependency-review.yml would go quiet
//     (dependabot/dependabot-core#15904). Measured 2026-09-25: pnpm 12.6.0 otherwise passes
//     the full `pnpm run verify`.
//
// Usage: node tools/check-toolchain.mjs [--json]
//   --json prints one {name, current, latest, behind, note} object per line.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The issue that has to be closed before pnpm 12's lockfile is safe here. */
export const PNPM12_BLOCKER = 'dependabot/dependabot-core#15904';

/**
 * @param {Array<{version: string, lts: (string|false)}>} index - nodejs.org/dist/index.json.
 * @return {number} The newest major with an LTS release.
 */
export function latestLtsMajor(index) {
  const majors = index.filter((release) => release.lts).map((release) => parseInt(release.version.slice(1), 10));
  return Math.max(...majors);
}

/**
 * The oldest Node major the project builds with: the lowest `node-version:` in the
 * workflows and .nvmrc, since any one of them left behind is what still needs moving.
 * @param {string[]} texts - Workflow files and .nvmrc.
 * @return {number|null}
 */
export function projectNodeMajor(texts) {
  const majors = [];
  for (const text of texts) {
    for (const match of text.matchAll(/node-version:\s*['"]?(\d+)/g)) majors.push(Number(match[1]));
    const bare = /^\s*v?(\d+)(?:\.\d+)*\s*$/.exec(text);
    if (bare) majors.push(Number(bare[1]));
  }
  return majors.length ? Math.min(...majors) : null;
}

async function getJson(url) {
  const headers = {'accept': 'application/json', 'user-agent': 'faststream-check-toolchain'};
  if (url.startsWith('https://api.github.com/') && process.env.GH_TOKEN) {
    headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  const response = await fetch(url, {headers});
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const workflows = path.join(root, '.github', 'workflows');
  const texts = fs.readdirSync(workflows).filter((f) => f.endsWith('.yml'))
      .map((f) => fs.readFileSync(path.join(workflows, f), 'utf8'));
  const nvmrc = path.join(root, '.nvmrc');
  if (fs.existsSync(nvmrc)) texts.push(fs.readFileSync(nvmrc, 'utf8'));

  const nodeCurrent = projectNodeMajor(texts);
  const nodeLts = latestLtsMajor(await getJson('https://nodejs.org/dist/index.json'));

  const pin = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).packageManager || '';
  const pnpmCurrent = parseInt((/^pnpm@(\d+)/.exec(pin) || [])[1], 10);
  const pnpmLatest = parseInt((await getJson('https://registry.npmjs.org/pnpm'))['dist-tags'].latest, 10);
  const [blockerRepo, blockerNumber] = PNPM12_BLOCKER.split('#');
  const blocker = await getJson(`https://api.github.com/repos/${blockerRepo}/issues/${blockerNumber}`);
  const blocked = pnpmLatest >= 12 && blocker.state !== 'closed';

  const results = [
    {name: 'Node.js', current: String(nodeCurrent), latest: String(nodeLts), behind: nodeLts > nodeCurrent,
      note: `newest LTS is ${nodeLts}; CI/.nvmrc use ${nodeCurrent}`},
    {name: 'pnpm', current: String(pnpmCurrent), latest: String(pnpmLatest), behind: pnpmLatest > pnpmCurrent && !blocked,
      note: blocked ? `pnpm ${pnpmLatest} is out, still blocked by ${PNPM12_BLOCKER} (${blocker.state})` : `newest major is ${pnpmLatest}; pinned ${pin}`},
  ];

  if (process.argv.includes('--json')) {
    for (const result of results) console.log(JSON.stringify(result));
    return;
  }
  for (const {name, current, latest, behind, note} of results) {
    console.log(`${behind ? 'UPDATE' : 'ok    '}  ${name.padEnd(8)} ${current.padEnd(4)} -> ${latest.padEnd(4)} ${note}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
