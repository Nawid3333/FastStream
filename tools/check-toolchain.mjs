#!/usr/bin/env node
// Finds the development-toolchain updates for .github/workflows/toolchain-updates.yml,
// which turns each into a pull request "Toolchain update: <name> <version>" with CI
// started on it. Node never runs inside the extension - it builds and tests it - so none
// of these changes what ships.
//
//   - Node.js: a newer LTS major than .nvmrc names. Every workflow's setup-node reads
//     .nvmrc, so the pull request changes that one file. A major is a decision: it waits
//     for the maintainer's merge.
//   - pnpm, same major: the newest release of the pinned major ("packageManager" in
//     package.json) that is at least MIN_AGE_DAYS old, so a broken release is usually
//     pulled or fixed before it is tried. Routine: .github/workflows/update-prs.yml merges
//     it once CI passes.
//   - pnpm, next major: reported only once nothing blocks it. pnpm 12 writes
//     pnpm-lock.yaml as two YAML documents; GitHub's dependency graph reads the first,
//     which holds only pnpm's own binaries, and so sees none of the project's dependencies
//     - Dependabot alerts and dependency-review.yml would go quiet
//     (dependabot/dependabot-core#15904). Measured 2026-09-25: pnpm 12.6.0 otherwise passes
//     the full `pnpm run verify`. A decision too: it waits for the maintainer.
//
// Usage: node tools/check-toolchain.mjs [--json | --plan <open.json> <titles.txt>]
//   (none)   one line per update, for reading.
//   --json   one {name, current, latest, behind, automerge, note} object per line.
//   --plan   what the workflow is to do, as one JSON object {raise: [...], close: [...]}.
//            open.json: [{number, title}] - the open pull requests and issues whose titles
//            start with TITLE_PREFIX. titles.txt: every title ever used, one per line, open
//            or closed, pull request or issue.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareVersions} from './check-patched-updates.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The issue that has to be closed before pnpm 12's lockfile is safe here. */
export const PNPM12_BLOCKER = 'dependabot/dependabot-core#15904';

/** How old a pnpm release must be before it is tried. */
export const MIN_AGE_DAYS = 5;

/** Every update pull request's title starts with this; the workflow and the plan share it. */
export const TITLE_PREFIX = 'Toolchain update: ';

/**
 * @param {Array<{version: string, lts: (string|false)}>} index - nodejs.org/dist/index.json.
 * @return {number} The newest major with an LTS release.
 */
export function latestLtsMajor(index) {
  const majors = index.filter((release) => release.lts).map((release) => parseInt(release.version.slice(1), 10));
  return Math.max(...majors);
}

/**
 * The oldest Node major the project builds with: .nvmrc, and any `node-version:` a
 * workflow still hard-codes (none should: they read .nvmrc), since one left behind is
 * what still needs moving.
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

/**
 * The newest stable release of one pnpm major that is old enough to try.
 * @param {{versions: Object<string, {deprecated?: string}>, time: Object<string, string>}} doc
 *     - registry.npmjs.org/pnpm.
 * @param {number} major
 * @param {number} now - Date.now().
 * @param {number} [minAgeDays]
 * @return {string|null}
 */
export function newestOfMajor(doc, major, now, minAgeDays = MIN_AGE_DAYS) {
  const cutoff = now - minAgeDays * 24 * 60 * 60 * 1000;
  const eligible = Object.keys(doc.versions).filter((version) =>
    /^\d+\.\d+\.\d+$/.test(version) &&
    parseInt(version, 10) === major &&
    !doc.versions[version].deprecated &&
    Date.parse(doc.time[version]) <= cutoff);
  return eligible.sort(compareVersions).pop() || null;
}

/**
 * What to do about the updates: raise each one that is behind and whose title was never
 * used (closing one by hand is how an update is skipped, for good), and close the open
 * ones the project has caught up with or that a newer one on the same track replaces.
 * Two tracks for pnpm: its current major, and the next.
 * @param {Array<{name: string, current: string, latest: string, behind: boolean}>} updates
 * @param {Array<{number: number, title: string}>} open
 * @param {Set<string>} used - Every title ever used.
 * @param {{raising?: boolean}} [options] - raising: false for a run that raises nothing (a push
 *     only closes); a newer update then replaces an open one only when it is open itself.
 * @return {{raise: Array<Object>, close: Array<{number: number, comment: string}>}}
 */
export function plan(updates, open, used, {raising = true} = {}) {
  const title = (update) => `${TITLE_PREFIX}${update.name} ${update.latest}`;
  const raise = !raising ? [] : updates.filter((update) => update.behind && !used.has(title(update)))
      .map((update) => ({...update, title: title(update)}));
  // A newer update replaces an open one only when it is itself open, or raised now: one
  // skipped by hand (its pull request closed) replaces nothing.
  const live = new Set([...raise.map((update) => update.title), ...open.map((item) => item.title)]);
  const close = [];
  for (const {number, title: openTitle} of open) {
    const rest = openTitle.slice(TITLE_PREFIX.length);
    const space = rest.lastIndexOf(' ');
    const name = rest.slice(0, space);
    const version = rest.slice(space + 1);
    const tracks = updates.filter((update) => update.name === name);
    if (!tracks.length) continue; // Not a tool this checks any more; left alone.
    const current = tracks[0].current;
    if (compareVersions(current, version) >= 0) {
      close.push({number, comment: `The project now uses ${name} ${current}. Closing.`});
      continue;
    }
    // Node has one track, its LTS majors. pnpm has two: its pinned major, and the next.
    const onPinnedMajor = (version_) => parseInt(version_, 10) === parseInt(current, 10);
    const track = tracks.find((update) => name === 'Node.js' ||
        onPinnedMajor(update.latest) === onPinnedMajor(version));
    if (track && compareVersions(track.latest, version) > 0 && live.has(title(track))) {
      close.push({number, comment: `Superseded by ${name} ${track.latest}, which has its own pull request.`});
    }
  }
  return {raise, close};
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

/** The updates, one per track, each {name, current, latest, behind, automerge, note}. */
async function updates() {
  const workflows = path.join(root, '.github', 'workflows');
  const texts = fs.readdirSync(workflows).filter((f) => f.endsWith('.yml'))
      .map((f) => fs.readFileSync(path.join(workflows, f), 'utf8'));
  texts.push(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8'));
  const nodeCurrent = projectNodeMajor(texts);
  const nodeLts = latestLtsMajor(await getJson('https://nodejs.org/dist/index.json'));

  const pin = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).packageManager || '';
  const pnpmCurrent = (/^pnpm@(\d+\.\d+\.\d+)/.exec(pin) || [])[1];
  if (!pnpmCurrent) throw new Error(`package.json packageManager is "${pin}", not pnpm@<x.y.z>`);
  const major = parseInt(pnpmCurrent, 10);
  const doc = await getJson('https://registry.npmjs.org/pnpm');
  const now = Date.now();
  const sameMajor = newestOfMajor(doc, major, now) || pnpmCurrent;
  const nextMajor = newestOfMajor(doc, major + 1, now);
  const [blockerRepo, blockerNumber] = PNPM12_BLOCKER.split('#');
  // Only the move onto 12 is blocked: 12 writes the two-document lockfile, and a project
  // already on it has nothing more to lose.
  const blocker = nextMajor && major + 1 === 12 ?
    await getJson(`https://api.github.com/repos/${blockerRepo}/issues/${blockerNumber}`) : {state: 'closed'};
  const blocked = blocker.state !== 'closed';

  const result = [
    {name: 'Node.js', current: String(nodeCurrent), latest: String(nodeLts), behind: nodeLts > nodeCurrent,
      automerge: false, note: `newest LTS is ${nodeLts}; .nvmrc names ${nodeCurrent}`},
    {name: 'pnpm', current: pnpmCurrent, latest: sameMajor, behind: compareVersions(sameMajor, pnpmCurrent) > 0,
      automerge: true, note: `newest ${major}.x at least ${MIN_AGE_DAYS} days old is ${sameMajor}; pinned ${pin}`},
  ];
  if (nextMajor) {
    result.push({name: 'pnpm', current: pnpmCurrent, latest: nextMajor, behind: !blocked, automerge: false,
      note: blocked ? `pnpm ${nextMajor} is out, still blocked by ${PNPM12_BLOCKER} (${blocker.state})` :
        `pnpm ${major + 1} is out: ${nextMajor}; pinned ${pin}`});
  }
  return result;
}

async function main() {
  const list = await updates();
  const plan_ = process.argv.indexOf('--plan');
  if (plan_ >= 0) {
    const open = JSON.parse(fs.readFileSync(process.argv[plan_ + 1], 'utf8'));
    const used = new Set(fs.readFileSync(process.argv[plan_ + 2], 'utf8').split(/\r?\n/).filter(Boolean));
    console.log(JSON.stringify(plan(list, open, used, {raising: !process.argv.includes('--close-only')})));
    return;
  }
  if (process.argv.includes('--json')) {
    for (const update of list) console.log(JSON.stringify(update));
    return;
  }
  for (const {name, current, latest, behind, note} of list) {
    console.log(`${behind ? 'UPDATE' : 'ok    '}  ${name.padEnd(8)} ${current.padEnd(8)} -> ${latest.padEnd(8)} ${note}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
