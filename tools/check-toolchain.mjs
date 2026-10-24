#!/usr/bin/env node
// @ts-check
// Finds the development-toolchain updates for .github/workflows/toolchain-updates.yml,
// which turns each into a pull request "Toolchain update: <name> <version>" with CI
// started on it. Node never runs inside the extension - it builds and tests it - so none
// of these changes what ships.
//
//   - Node.js: a newer LTS major than .nvmrc names. Every workflow's setup-node reads
//     .nvmrc, so the pull request changes that one file. Routine: ready to merge once CI
//     passes and the build is unchanged; the owner merges it (2026-10-02).
//   - pnpm, same major: the newest release of the pinned major ("packageManager" in
//     package.json) that is at least MIN_AGE_DAYS old, so a broken or hijacked release is
//     usually pulled before it is tried. Routine: .github/workflows/update-prs.yml says
//     it is ready to merge once CI passes.
//   - pnpm, next major: the same change, routine as the same major is, unless it wants the
//     lockfile rewritten (CI fails at the frozen install, and the owner pushes it). pnpm 12
//     came by hand on 2026-10-11; pmOnFail: ignore (pnpm-workspace.yaml) keeps its
//     pnpm-lock.yaml one YAML document, which GitHub's dependency graph needs
//     (dependabot/dependabot-core#15904).
//   - uBlock Origin, which tools/setup-dev-profile.mjs puts into the developer's Firefox
//     profile: the newest public release on AMO at least MIN_AGE_DAYS old. Dependabot cannot
//     see an add-on pin, and nothing in CI downloads it, so the workflow downloads the file
//     and checks it against AMO's SHA-256 before it pushes anything. Routine.
//
// Usage: node tools/check-toolchain.mjs [--json | --plan <open.json> <titles.txt>]
//   (none)   one line per update, for reading.
//   --json   one {name, current, latest, behind, routine, note[, file]} object per line.
//   --plan   what the workflow is to do, as one JSON object {raise: [...], close: [...],
//            updates: [...]} (updates: every track, for rebuilding an open pull request).
//            open.json: [{number, title}] - the open pull requests and issues whose titles
//            start with TITLE_PREFIX. titles.txt: every title ever used, one per line, open
//            or closed, pull request or issue.
//   --apply-addon <id> <version> <url> <sha256>
//            writes that add-on's entry in tools/setup-dev-profile.mjs and prints the version
//            it had (the workflow's recipe; no network).
//   --addon-version <id> <file>
//            prints the version a copy of tools/setup-dev-profile.mjs pins for that add-on.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareVersions} from './check-patched-updates.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How old a release must be before it is tried (the owner's call, 2026-10-20; 5 days until
 * 2026-10-11, then none): green CI cannot see a compromised release, and most are pulled
 * within hours to days. Dependabot's cooldown and update-prs.yml's lockfile check wait as
 * long. tools/newest-release.mjs takes it for the owner's PC too.
 */
export const MIN_AGE_DAYS = 3;

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

/** The add-on tools/setup-dev-profile.mjs installs, as AMO and its manifest name it. */
export const UBLOCK = {id: 'uBlock0@raymondhill.net', slug: 'ublock-origin', name: 'uBlock Origin'};

/** A plain AMO download, the only kind the recipe writes into a JavaScript string. */
const AMO_FILE = /^https:\/\/addons\.mozilla\.org\/firefox\/downloads\/file\/\d+\/[\w.-]+\.xpi$/;

/**
 * The newest release of an add-on on AMO that is old enough to try: a public file on the
 * listed channel (what addons.mozilla.org offers), a plain version number, and a download
 * of AMO's own with its SHA-256.
 * @param {{results?: Array<{version: string, channel?: string, file?: {created?: string,
 *     status?: string, hash?: string, url?: string}}>}} page - /api/v5/addons/addon/<slug>/versions/.
 * @param {number} now - Date.now().
 * @param {number} [minAgeDays]
 * @return {{version: string, url: string, sha256: string}|null}
 */
export function newestAddon(page, now, minAgeDays = MIN_AGE_DAYS) {
  const cutoff = now - minAgeDays * 24 * 60 * 60 * 1000;
  const eligible = (page.results || []).filter(({version, channel, file}) =>
    channel === 'listed' && file?.status === 'public' &&
    /^\d+(\.\d+){1,3}$/.test(version) &&
    /^sha256:[0-9a-f]{64}$/.test(file.hash || '') &&
    AMO_FILE.test(file.url || '') &&
    Date.parse(file.created || '') <= cutoff);
  const newest = eligible.sort((a, b) => compareVersions(a.version, b.version)).pop();
  if (!newest?.file?.url || !newest.file.hash) return null;
  return {version: newest.version, url: newest.file.url, sha256: newest.file.hash.slice('sha256:'.length)};
}

/**
 * The object literal of one add-on in tools/setup-dev-profile.mjs's ADDONS, found by its id.
 * @param {string} text - The file.
 * @param {string} id
 * @return {{start: number, end: number}} The span from its `{` to its `}`.
 */
function addonEntry(text, id) {
  const needle = `id: '${id}'`;
  const at = text.indexOf(needle);
  if (at < 0 || text.indexOf(needle, at + 1) >= 0) {
    throw new Error(`tools/setup-dev-profile.mjs names the add-on ${id} ${at < 0 ? 'nowhere' : 'twice'}`);
  }
  const start = text.lastIndexOf('{', at);
  const end = text.indexOf('}', at);
  if (start < 0 || end < 0) throw new Error(`the entry of ${id} in tools/setup-dev-profile.mjs has no braces`);
  return {start, end};
}

/**
 * The version one add-on's entry pins.
 * @param {string} text - tools/setup-dev-profile.mjs.
 * @param {string} id
 * @return {string}
 */
export function addonVersion(text, id) {
  const {start, end} = addonEntry(text, id);
  const match = /\bversion: '([^']*)'/.exec(text.slice(start, end));
  if (!match) throw new Error(`the entry of ${id} in tools/setup-dev-profile.mjs has no version`);
  return match[1];
}

/**
 * tools/setup-dev-profile.mjs with one add-on's version, url and sha256 replaced and nothing
 * else changed. Each of the three must be in its entry exactly once.
 * @param {string} text - The file.
 * @param {string} id
 * @param {{version: string, url: string, sha256: string}} release
 * @return {{text: string, was: string}}
 */
export function applyAddon(text, id, {version, url, sha256}) {
  if (!/^\d+(\.\d+){1,3}$/.test(version) || !AMO_FILE.test(url) || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`not a release to write: ${version} ${url} ${sha256}`);
  }
  const was = addonVersion(text, id);
  const {start, end} = addonEntry(text, id);
  let entry = text.slice(start, end);
  for (const [key, value] of Object.entries({version, url, sha256})) {
    const field = new RegExp(`\\b${key}: '[^']*'`, 'g');
    const count = (entry.match(field) || []).length;
    if (count !== 1) throw new Error(`the entry of ${id} has ${count} ${key} fields, not one`);
    entry = entry.replace(field, `${key}: '${value}'`);
  }
  return {text: text.slice(0, start) + entry + text.slice(end), was};
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
  /** @param {{name: string, latest: string}} update */
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
    // Node and uBlock Origin have one track each. pnpm has two: its pinned major, and the next.
    /** @param {string} version_ */
    const onPinnedMajor = (version_) => parseInt(version_, 10) === parseInt(current, 10);
    const track = tracks.find((update) => name !== 'pnpm' ||
        onPinnedMajor(update.latest) === onPinnedMajor(version));
    if (track && compareVersions(track.latest, version) > 0 && live.has(title(track))) {
      close.push({number, comment: `Superseded by ${name} ${track.latest}, which has its own pull request.`});
    }
  }
  return {raise, close};
}

/** @param {string} url */
async function getJson(url) {
  /** @type {Record<string, string>} */
  const headers = {'accept': 'application/json', 'user-agent': 'faststream-check-toolchain'};
  if (url.startsWith('https://api.github.com/') && process.env.GH_TOKEN) {
    headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  // Tried three times: one failed request fails the whole weekly run, and no answer is never
  // taken for "no update". A 4xx other than 429 is the request's own fault and is not repeated.
  for (let attempt = 1; ; attempt++) {
    let response = null;
    try {
      response = await fetch(url, {headers});
    } catch (error) {
      if (attempt === 3) throw error;
    }
    if (response?.ok) return response.json();
    if (response && ((response.status < 500 && response.status !== 429) || attempt === 3)) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
  }
}

/** The updates, one per track, each {name, current, latest, behind, routine, note[, file]}. */
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

  /** @type {Array<{name: string, current: string, latest: string, behind: boolean, routine: boolean, note: string,
   *     file?: {url: string, sha256: string}}>} */
  const result = [
    {name: 'Node.js', current: String(nodeCurrent), latest: String(nodeLts), behind: nodeLts > /** @type {number} */ (nodeCurrent),
      routine: true, note: `newest LTS is ${nodeLts}; .nvmrc names ${nodeCurrent}`},
    {name: 'pnpm', current: pnpmCurrent, latest: sameMajor, behind: compareVersions(sameMajor, pnpmCurrent) > 0,
      routine: true, note: `newest ${major}.x at least ${MIN_AGE_DAYS} days old is ${sameMajor}; pinned ${pin}`},
  ];
  if (nextMajor) {
    result.push({name: 'pnpm', current: pnpmCurrent, latest: nextMajor, behind: true, routine: true,
      note: `pnpm ${major + 1} is out: ${nextMajor}; pinned ${pin}`});
  }

  const profile = fs.readFileSync(path.join(root, 'tools', 'setup-dev-profile.mjs'), 'utf8');
  const addonCurrent = addonVersion(profile, UBLOCK.id);
  // Newest first; a page of 25 reaches back months for an add-on that releases monthly.
  const addon = newestAddon(await getJson(`https://addons.mozilla.org/api/v5/addons/addon/${UBLOCK.slug}/versions/?page_size=25`), now);
  if (!addon) throw new Error(`AMO lists no public release of ${UBLOCK.name} at least ${MIN_AGE_DAYS} days old`);
  result.push({name: UBLOCK.name, current: addonCurrent, latest: addon.version,
    behind: compareVersions(addon.version, addonCurrent) > 0, routine: true,
    note: `newest on AMO at least ${MIN_AGE_DAYS} days old is ${addon.version}; tools/setup-dev-profile.mjs pins ${addonCurrent}`,
    file: {url: addon.url, sha256: addon.sha256}});
  return result;
}

async function main() {
  const apply = process.argv.indexOf('--apply-addon');
  if (apply >= 0) {
    const [id, version, url, sha256] = process.argv.slice(apply + 1, apply + 5);
    const file = path.join(root, 'tools', 'setup-dev-profile.mjs');
    const {text, was} = applyAddon(fs.readFileSync(file, 'utf8'), id, {version, url, sha256});
    fs.writeFileSync(file, text);
    console.log(was);
    return;
  }
  const pinned = process.argv.indexOf('--addon-version');
  if (pinned >= 0) {
    console.log(addonVersion(fs.readFileSync(process.argv[pinned + 2], 'utf8'), process.argv[pinned + 1]));
    return;
  }
  const list = await updates();
  const plan_ = process.argv.indexOf('--plan');
  if (plan_ >= 0) {
    const open = JSON.parse(fs.readFileSync(process.argv[plan_ + 1], 'utf8'));
    const used = new Set(fs.readFileSync(process.argv[plan_ + 2], 'utf8').split(/\r?\n/).filter(Boolean));
    console.log(JSON.stringify({...plan(list, open, used, {raising: !process.argv.includes('--close-only')}), updates: list}));
    return;
  }
  if (process.argv.includes('--json')) {
    for (const update of list) console.log(JSON.stringify(update));
    return;
  }
  for (const {name, current, latest, behind, note} of list) {
    console.log(`${behind ? 'UPDATE' : 'ok    '}  ${name.padEnd(13)} ${current.padEnd(8)} -> ${latest.padEnd(8)} ${note}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
