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
 * One field line of an add-on's entry, as the file writes them: `    key: 'value',`.
 * @param {string} key
 * @return {RegExp} Groups: indent, value, line end.
 */
const fieldLine = (key) => new RegExp(`^(\\s*)${key}: '([^']*)',(\\r?)$`);

/**
 * One add-on's entry in tools/setup-dev-profile.mjs's ADDONS, found by its id line: its field
 * lines, between its `{` and `}` lines. Line by line, inside the array only, so a brace or an
 * id in a comment can neither move the entry nor be taken for it.
 * @param {string[]} lines - The file's lines.
 * @param {string} id
 * @return {Object<string, number>} Each field's line index, by key.
 */
function addonFields(lines, id) {
  const where = 'ADDONS in tools/setup-dev-profile.mjs';
  const array = lines.findIndex((line) => /^export const ADDONS = \[\r?$/.test(line));
  const end = lines.findIndex((line, i) => i > array && /^\];?\r?$/.test(line));
  if (array < 0 || end < 0) throw new Error('tools/setup-dev-profile.mjs has no `export const ADDONS = [` ... `];`');
  const ids = [];
  for (let i = array + 1; i < end; i++) {
    if (lines[i].trim() === `id: '${id}',`) ids.push(i);
  }
  if (ids.length !== 1) throw new Error(`${where} names the add-on ${id} ${ids.length ? 'more than once' : 'nowhere'}`);
  let first = ids[0];
  while (first > array && lines[first].trim() !== '{') first--;
  let last = ids[0];
  while (last < end && !/^},?$/.test(lines[last].trim())) last++;
  if (first === array || last === end) throw new Error(`${where}: the entry of ${id} has no { and } lines of its own`);
  /** @type {Object<string, number>} */
  const fields = {};
  for (const key of ['version', 'url', 'sha256']) {
    const found = [];
    for (let i = first + 1; i < last; i++) {
      if (fieldLine(key).test(lines[i])) found.push(i);
    }
    if (found.length !== 1) throw new Error(`${where}: the entry of ${id} has ${found.length} ${key} lines, not one`);
    fields[key] = found[0];
  }
  return fields;
}

/**
 * The version one add-on's entry pins.
 * @param {string} text - tools/setup-dev-profile.mjs.
 * @param {string} id
 * @return {string}
 */
export function addonVersion(text, id) {
  const lines = text.split('\n');
  return /** @type {RegExpExecArray} */ (fieldLine('version').exec(lines[addonFields(lines, id).version]))[2];
}

/**
 * tools/setup-dev-profile.mjs with one add-on's version, url and sha256 lines rewritten and
 * nothing else changed.
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
  const lines = text.split('\n');
  const fields = addonFields(lines, id);
  for (const [key, value] of Object.entries({version, url, sha256})) {
    // A function, not a replacement string: no `$` in a value is read as a pattern.
    lines[fields[key]] = lines[fields[key]].replace(fieldLine(key), (_, indent, _old, end) => `${indent}${key}: '${value}',${end}`);
  }
  return {text: lines.join('\n'), was};
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

/**
 * A JSON answer, asked up to three times: no answer, none within a minute, a 5xx or 429, or an
 * answer that is not JSON is asked again. A 4xx other than 429 is the request's own fault, and
 * asking again would change nothing.
 * @param {string} url
 * @param {{wait?: (ms: number) => Promise<void>}} [options] - wait: the pause between tries.
 * @return {Promise<any>}
 */
export async function getJson(url, {wait = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))} = {}) {
  /** @type {Record<string, string>} */
  const headers = {'accept': 'application/json', 'user-agent': 'faststream-check-toolchain'};
  if (url.startsWith('https://api.github.com/') && process.env.GH_TOKEN) {
    headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  for (let attempt = 1; ; attempt++) {
    /** @type {Response|null} */
    let response = null;
    /** @type {Error} */
    let error;
    try {
      response = await fetch(url, {headers, signal: AbortSignal.timeout(60 * 1000)});
      if (response.ok) return await response.json();
      error = new Error(`${url}: HTTP ${response.status}`);
    } catch (caught) {
      error = /** @type {Error} */ (caught);
    }
    const final = response !== null && !response.ok && response.status < 500 && response.status !== 429;
    if (final || attempt === 3) throw error;
    console.error(`${url}: ${error.message}; asking again`);
    await wait(attempt * 5000);
  }
}

/**
 * @typedef {{name: string, current: string, latest: string, behind: boolean, routine: boolean, note: string,
 *     file?: {url: string, sha256: string}}} Update
 */

/**
 * The updates, one per track, and what could not be read. Each source is read on its own: one
 * that fails (AMO down, say) leaves its track out and is named in `errors`, and the others go
 * ahead; the workflow then still fails the run, so the owner hears of it. A track left out is
 * neither raised nor closed (plan() leaves an open one alone).
 * @return {Promise<{list: Update[], errors: string[]}>}
 */
async function updates() {
  /** @type {Update[]} */
  const list = [];
  /** @type {string[]} */
  const errors = [];
  const now = Date.now();
  /**
   * @param {string} name
   * @param {() => Promise<Update[]>} read
   */
  const track = async (name, read) => {
    try {
      list.push(...await read());
    } catch (error) {
      errors.push(`${name}: ${/** @type {Error} */ (error).message}`);
    }
  };

  await track('Node.js', async () => {
    const workflows = path.join(root, '.github', 'workflows');
    const texts = fs.readdirSync(workflows).filter((f) => f.endsWith('.yml'))
        .map((f) => fs.readFileSync(path.join(workflows, f), 'utf8'));
    texts.push(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8'));
    const nodeCurrent = projectNodeMajor(texts);
    const nodeLts = latestLtsMajor(await getJson('https://nodejs.org/dist/index.json'));
    return [{name: 'Node.js', current: String(nodeCurrent), latest: String(nodeLts),
      behind: nodeLts > /** @type {number} */ (nodeCurrent), routine: true, note: `newest LTS is ${nodeLts}; .nvmrc names ${nodeCurrent}`}];
  });

  await track('pnpm', async () => {
    const pin = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).packageManager || '';
    const pnpmCurrent = (/^pnpm@(\d+\.\d+\.\d+)/.exec(pin) || [])[1];
    if (!pnpmCurrent) throw new Error(`package.json packageManager is "${pin}", not pnpm@<x.y.z>`);
    const major = parseInt(pnpmCurrent, 10);
    const doc = await getJson('https://registry.npmjs.org/pnpm');
    const sameMajor = newestOfMajor(doc, major, now) || pnpmCurrent;
    const nextMajor = newestOfMajor(doc, major + 1, now);
    /** @type {Update[]} */
    const tracks = [{name: 'pnpm', current: pnpmCurrent, latest: sameMajor, behind: compareVersions(sameMajor, pnpmCurrent) > 0,
      routine: true, note: `newest ${major}.x at least ${MIN_AGE_DAYS} days old is ${sameMajor}; pinned ${pin}`}];
    if (nextMajor) {
      tracks.push({name: 'pnpm', current: pnpmCurrent, latest: nextMajor, behind: true, routine: true,
        note: `pnpm ${major + 1} is out: ${nextMajor}; pinned ${pin}`});
    }
    return tracks;
  });

  await track(UBLOCK.name, async () => {
    const profile = fs.readFileSync(path.join(root, 'tools', 'setup-dev-profile.mjs'), 'utf8');
    const addonCurrent = addonVersion(profile, UBLOCK.id);
    // Newest first; a page of 25 reaches back months for an add-on that releases monthly.
    const page = await getJson(`https://addons.mozilla.org/api/v5/addons/addon/${UBLOCK.slug}/versions/?page_size=25`);
    const addon = newestAddon(page, now);
    if (!addon) throw new Error(`AMO lists no public release at least ${MIN_AGE_DAYS} days old on its first page`);
    return [{name: UBLOCK.name, current: addonCurrent, latest: addon.version,
      behind: compareVersions(addon.version, addonCurrent) > 0, routine: true,
      note: `newest on AMO at least ${MIN_AGE_DAYS} days old is ${addon.version}; tools/setup-dev-profile.mjs pins ${addonCurrent}`,
      file: {url: addon.url, sha256: addon.sha256}}];
  });
  return {list, errors};
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
  const {list, errors} = await updates();
  const plan_ = process.argv.indexOf('--plan');
  if (plan_ >= 0) {
    // The workflow acts on the tracks it has, then fails on `errors`.
    const open = JSON.parse(fs.readFileSync(process.argv[plan_ + 1], 'utf8'));
    const used = new Set(fs.readFileSync(process.argv[plan_ + 2], 'utf8').split(/\r?\n/).filter(Boolean));
    console.log(JSON.stringify({...plan(list, open, used, {raising: !process.argv.includes('--close-only')}), updates: list, errors}));
    return;
  }
  if (process.argv.includes('--json')) {
    for (const update of list) console.log(JSON.stringify(update));
  } else {
    for (const {name, current, latest, behind, note} of list) {
      console.log(`${behind ? 'UPDATE' : 'ok    '}  ${name.padEnd(13)} ${current.padEnd(8)} -> ${latest.padEnd(8)} ${note}`);
    }
  }
  for (const error of errors) console.error(`could not read ${error}`);
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
