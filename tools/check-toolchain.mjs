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
//   - The player libraries the live suite plays (tests/e2e/live-specs/player-libraries.json),
//     as one set ("players" in the plan): each at its newest release of its pinned major
//     (the caret range) at least MIN_AGE_DAYS old that fits the ranges they declare on each
//     other and on hls.js (the repository's own pin); a newer major is only reported. The
//     workflow keeps ONE rolling pull request for the set (see playerTargets()).
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
//   --apply-players <players.json>
//            writes tests/e2e/live-specs/player-libraries.json at the plan's "players".target
//            (the workflow's recipe; no network), refusing any library that would go back.

import {createHash} from 'node:crypto';
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

/** The file that pins the player libraries the live suite plays. */
export const PLAYER_LIBRARIES = 'tests/e2e/live-specs/player-libraries.json';

/**
 * The slice of an npm registry document the player libraries' plan reads.
 * @typedef {{
 *   versions: Object<string, {dependencies?: Object<string, string>, peerDependencies?: Object<string, string>,
 *     deprecated?: boolean|string}>,
 *   time: Object<string, string>,
 * }} RegistryDoc
 */

/** @typedef {'in'|'below'|'above'|'unknown'} Verdict */

// compareVersions ranks a prerelease such as 1.0.0-rc.1 above 1.0.0 (it splits on '-' too),
// so only a plain x.y.z is ever compared.
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where a plain x.y.z version stands to an npm range.
 * @param {string} version
 * @param {string} range
 * @return {Verdict}
 */
export function relation(version, range) {
  if (!PLAIN_VERSION.test(version)) return 'unknown';
  const text = String(range).trim();
  if (text === '' || text === '*') return 'in';
  if (text.includes('||')) {
    // Any alternative it is in will do; one that cannot be read leaves above and below open.
    const verdicts = text.split('||').map((alternative) => relation(version, alternative));
    if (verdicts.includes('in')) return 'in';
    if (verdicts.every((verdict) => verdict === 'above')) return 'above';
    if (verdicts.every((verdict) => verdict === 'below')) return 'below';
    return 'unknown';
  }
  const atoms = text.split(/\s+/);
  if (atoms.includes('-')) return 'unknown'; // a hyphen range, "1.2.3 - 1.4.0", is not read here
  const verdicts = atoms.map((atom) => relationAtom(version, atom));
  // All of them must hold; one that cannot be read leaves the whole range unread.
  if (verdicts.every((verdict) => verdict === 'in')) return 'in';
  if (verdicts.includes('unknown')) return 'unknown';
  if (verdicts.includes('above')) return 'above';
  return 'below';
}

/**
 * One space-separated part of a range.
 * @param {string} version
 * @param {string} atom
 * @return {Verdict}
 */
function relationAtom(version, atom) {
  // npm reads a partial bound as the whole of what it names: >1.2 is >=1.3.0, <=1.2 is <1.3.0
  // (and >=1.2 is >=1.2.0, <1.2 is <1.2.0).
  if (atom.startsWith('>=')) return side(version, atom.slice(2), false, (cmp) => cmp >= 0, 'below');
  if (atom.startsWith('>')) return side(version, atom.slice(1), true, (cmp) => cmp > 0, 'below', (cmp) => cmp >= 0);
  if (atom.startsWith('<=')) return side(version, atom.slice(2), true, (cmp) => cmp <= 0, 'above', (cmp) => cmp < 0);
  if (atom.startsWith('<')) return side(version, atom.slice(1), false, (cmp) => cmp < 0, 'above');
  if (atom[0] === '^') return band(version, caretBand(atom.slice(1)));
  if (atom[0] === '~') return band(version, tildeBand(atom.slice(1)));
  return bare(version, atom);
}

/**
 * A one-sided comparator: a version outside it is on its one open side.
 * @param {string} version
 * @param {string} bound
 * @param {boolean} past - Whether a partial bound stands for the version after all it names.
 * @param {(cmp: number) => boolean} holds - Against a full bound.
 * @param {'below'|'above'} otherwise
 * @param {(cmp: number) => boolean} [holdsPast] - Against that next version, for a partial bound.
 * @return {Verdict}
 */
function side(version, bound, past, holds, otherwise, holdsPast = holds) {
  const parts = numericParts(bound.replace(/^v/i, ''));
  if (!parts) return 'unknown';
  if (past && parts.length < 3) {
    const next = parts.map((part, index) => (index === parts.length - 1 ? part + 1 : part));
    return holdsPast(compareVersions(version, next.concat([0, 0]).slice(0, 3).join('.'))) ? 'in' : otherwise;
  }
  return holds(compareVersions(version, parts.concat([0, 0]).slice(0, 3).join('.'))) ? 'in' : otherwise;
}

/**
 * '1', '1.2' or '1.2.3' as numbers; null for anything else.
 * @param {string} text
 * @return {number[]|null}
 */
function numericParts(text) {
  if (!/^\d+(?:\.\d+){0,2}$/.test(text)) return null;
  return text.split('.').map(Number);
}

/**
 * Where a version stands to [lower, upper); null is a band that could not be read.
 * @param {string} version
 * @param {{lower: number[], upper: number[]}|null} range
 * @return {Verdict}
 */
function band(version, range) {
  if (!range) return 'unknown';
  if (compareVersions(version, range.lower.join('.')) < 0) return 'below';
  if (compareVersions(version, range.upper.join('.')) >= 0) return 'above';
  return 'in';
}

/**
 * ^ keeps the left-most part that is not 0: ^1.2.3 is below 2.0.0, ^0.3.5 below 0.4.0,
 * ^0.0.4 below 0.0.5.
 * @param {string} text
 * @return {{lower: number[], upper: number[]}|null}
 */
function caretBand(text) {
  const parts = numericParts(text.replace(/^v/i, ''));
  if (!parts) return null;
  return {lower: parts.concat([0, 0]).slice(0, 3), upper: caretUpper(parts)};
}

/**
 * @param {number[]} parts
 * @return {number[]}
 */
function caretUpper(parts) {
  if (parts[0] > 0) return [parts[0] + 1, 0, 0];
  if (parts.length < 2) return [1, 0, 0]; // ^0
  if (parts[1] > 0) return [0, parts[1] + 1, 0];
  if (parts.length < 3) return [0, 1, 0]; // ^0.0
  return [0, 0, parts[2] + 1];
}

/**
 * ~ keeps the minor when one is named, else the major: ~1.2.3 is below 1.3.0, ~1 below 2.0.0.
 * @param {string} text
 * @return {{lower: number[], upper: number[]}|null}
 */
function tildeBand(text) {
  const parts = numericParts(text.replace(/^v/i, ''));
  if (!parts) return null;
  const upper = parts.length < 2 ? [parts[0] + 1, 0, 0] : [parts[0], parts[1] + 1, 0];
  return {lower: parts.concat([0, 0]).slice(0, 3), upper};
}

/**
 * An exact '1.2.3' ('=1.2.3', 'v1.2.3'), or an x-range: '1', '1.2', '1.x', '1.2.x', 'x', '*'.
 * @param {string} version
 * @param {string} atom
 * @return {Verdict}
 */
function bare(version, atom) {
  const tokens = atom.replace(/^[=v]+/i, '').split('.');
  if (tokens.length > 3 || tokens.includes('')) return 'unknown';
  /** @type {number[]} */
  const named = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      named.push(Number(token));
    } else if (/^[*xX]$/.test(token)) {
      break; // what comes after a wildcard is not read, as in npm's 1.x.2
    } else {
      return 'unknown'; // 'latest', 'workspace:*', 'npm:...', a URL
    }
  }
  if (named.length === 3) {
    const cmp = compareVersions(version, named.join('.'));
    if (cmp === 0) return 'in';
    return cmp < 0 ? 'below' : 'above';
  }
  if (named.length === 0) return 'in';
  const upper = named.concat([0, 0]).slice(0, 3).map((part, index) => (index === named.length - 1 ? part + 1 : part));
  return band(version, {lower: named.concat([0, 0]).slice(0, 3), upper});
}

/**
 * The versions a pin may move to: plain, not deprecated, MIN_AGE_DAYS old, inside the pin's
 * caret range and not below it. Newest first, the pin itself last as the floor (even when it
 * is deprecated or young: it is what main has).
 * @param {RegistryDoc} doc
 * @param {string} pin
 * @param {number} now - Date.now().
 * @param {number} [minAgeDays]
 * @return {string[]}
 */
export function caretCandidates(doc, pin, now, minAgeDays = MIN_AGE_DAYS) {
  const cutoff = now - minAgeDays * DAY_MS;
  const upper = caretUpper(pin.split('.').map(Number)).join('.');
  const offered = Object.keys(doc.versions).filter((version) =>
    PLAIN_VERSION.test(version) && version !== pin &&
    !doc.versions[version].deprecated &&
    compareVersions(version, pin) > 0 &&
    compareVersions(version, upper) < 0 &&
    Date.parse(doc.time[version]) <= cutoff);
  offered.sort((a, b) => compareVersions(b, a));
  offered.push(pin);
  return offered;
}

/**
 * The newest release above the pin's caret range that is old enough: a new major, which is
 * reported and never taken. Null when there is none.
 * @param {RegistryDoc} doc
 * @param {string} pin
 * @param {number} now - Date.now().
 * @param {number} [minAgeDays]
 * @return {string|null}
 */
export function newerMajor(doc, pin, now, minAgeDays = MIN_AGE_DAYS) {
  const cutoff = now - minAgeDays * DAY_MS;
  const upper = caretUpper(pin.split('.').map(Number)).join('.');
  const above = Object.keys(doc.versions).filter((version) =>
    PLAIN_VERSION.test(version) &&
    !doc.versions[version].deprecated &&
    compareVersions(version, upper) >= 0 &&
    Date.parse(doc.time[version]) <= cutoff);
  return above.sort(compareVersions).pop() || null;
}

/**
 * The set the player libraries' pull request offers: each library at its newest candidate,
 * stepped down wherever a range one of them declares on another (or on a package the
 * repository pins itself, such as hls.js) does not hold. A library too new for another's
 * range steps down first, the one that declares it only when that cannot; one that needs a
 * newer library than the set can have steps down; one whose range cannot be read is not
 * taken new. Each step lowers one library along a finite list, so this ends.
 * @param {Object<string, string>} pins - player-libraries.json.
 * @param {Object<string, RegistryDoc>} docs - Each library's registry document.
 * @param {Object<string, string>} fixed - The versions the repository pins itself.
 * @param {number} now - Date.now().
 * @param {number} [minAgeDays]
 * @return {{target: Object<string, string>, changes: Array<{name: string, from: string, to: string}>,
 *     held: Array<{name: string, version: string, newest: string}>,
 *     majors: Array<{name: string, current: string, latest: string}>,
 *     unresolved: Array<{name: string, version: string, needs: string, range: string}>}}
 *     held: a newer candidate that a range keeps out; unresolved: a range that does not hold
 *     even at the pins (main's own state).
 */
export function playerTargets(pins, docs, fixed, now, minAgeDays = MIN_AGE_DAYS) {
  const names = Object.keys(pins);
  // Maps, not objects: the names come from files and the registry, and none may reach a
  // prototype (CodeQL js/remote-property-injection).
  /** @type {Map<string, string[]>} */
  const ladder = new Map();
  /** @type {Map<string, number>} */
  const step = new Map();
  /** @type {Map<string, string>} */
  const target = new Map();
  /** @type {Map<string, string>} */
  const fixedVersions = new Map(Object.entries(fixed));
  const majors = [];
  const unresolved = [];
  const reported = new Set();

  for (const name of names) {
    const pin = pins[name];
    const doc = Object.hasOwn(docs, name) ? docs[name] : null;
    if (!doc?.versions) throw new Error(`no registry document for ${name}`);
    if (!Object.hasOwn(doc.versions, pin)) throw new Error(`the registry has no ${name}@${pin}`);
    const candidates = caretCandidates(doc, pin, now, minAgeDays);
    ladder.set(name, candidates);
    step.set(name, 0);
    target.set(name, candidates[0]);
    const latest = newerMajor(doc, pin, now, minAgeDays);
    if (latest) majors.push({name, current: pin, latest});
  }

  /** @param {string} name */
  const canStep = (name) => ladder.has(name) && /** @type {number} */ (step.get(name)) + 1 < /** @type {string[]} */ (ladder.get(name)).length;
  /** @param {string} name */
  const stepDown = (name) => {
    const next = /** @type {number} */ (step.get(name)) + 1;
    step.set(name, next);
    target.set(name, /** @type {string[]} */ (ladder.get(name))[next]);
  };

  let moved = true;
  while (moved) {
    moved = false;
    for (const name of names) {
      const declared = docs[name].versions[/** @type {string} */ (target.get(name))];
      const ranges = {...declared.dependencies, ...declared.peerDependencies};
      for (const [other, range] of Object.entries(ranges)) {
        const isPin = target.has(other);
        if (!isPin && !fixedVersions.has(other)) continue; // not one of the set: not ours to meet
        const verdict = relation(/** @type {string} */ (isPin ? target.get(other) : fixedVersions.get(other)), range);
        if (verdict === 'in') continue;
        let mover = null;
        if (verdict === 'above' && canStep(other)) {
          mover = other;
        } else if (canStep(name)) {
          mover = name;
        }
        if (mover) {
          stepDown(mover);
          moved = true;
          break;
        }
        // At the pins already, and no step left: main's own state. A range that cannot be
        // read is left as main has it, unreported.
        const key = `${name}|${other}|${range}`;
        if (verdict !== 'unknown' && !reported.has(key)) {
          reported.add(key);
          unresolved.push({name, version: /** @type {string} */ (target.get(name)), needs: other, range});
        }
      }
    }
  }

  /** @param {string} name */
  const at = (name) => /** @type {string} */ (target.get(name));
  /** @param {string} name */
  const newest = (name) => /** @type {string[]} */ (ladder.get(name))[0];
  const changes = names.filter((name) => at(name) !== pins[name]).map((name) => ({name, from: pins[name], to: at(name)}));
  const held = names.filter((name) => at(name) !== newest(name)).map((name) => ({name, version: at(name), newest: newest(name)}));
  return {target: Object.fromEntries(names.map((name) => [name, at(name)])), changes, held, majors, unresolved};
}

/** An npm package name, scoped or not: lower case, no leading dot or underscore. */
const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

/**
 * A short name for a set of versions: the pull request's marker, so that one closed by hand
 * skips exactly that set.
 * @param {Object<string, string>} target
 * @return {string} 12 hex digits.
 */
export function playerState(target) {
  const lines = Object.keys(target).sort().map((name) => `${name}@${target[name]}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12);
}

/**
 * player-libraries.json at a set's versions: the same libraries in the same order, each at a
 * plain x.y.z no lower than it is. Anything else is refused, not written.
 * @param {string} text - player-libraries.json as it is.
 * @param {Object<string, string>} target
 * @return {string}
 */
export function applyPlayers(text, target) {
  const pins = JSON.parse(text);
  const names = Object.keys(pins);
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(target))) {
    throw new Error(`the set names ${Object.keys(target).join(', ')}, not ${names.join(', ')} as ${PLAYER_LIBRARIES} does`);
  }
  for (const name of names) {
    if (!PLAIN_VERSION.test(String(target[name]))) throw new Error(`${name} ${target[name]} is not x.y.z`);
    if (compareVersions(target[name], pins[name]) < 0) throw new Error(`${name} would go back from ${pins[name]} to ${target[name]}`);
  }
  return `${JSON.stringify(target, null, 2)}\n`;
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

/** @typedef {ReturnType<typeof playerTargets> & {behind: boolean, state: string}} PlayerSet */

/**
 * @typedef {{name: string, current: string, latest: string, behind: boolean, routine: boolean, note: string,
 *     file?: {url: string, sha256: string}}} Update
 */

/**
 * The updates, one per track, the player libraries' set, and what could not be read. Each
 * source is read on its own: one that fails (AMO down, say) leaves its track out and is named in
 * `errors`, and the others go ahead; the workflow then still fails the run, so the owner hears
 * of it. A track left out is neither raised nor closed (plan() leaves an open one alone); a set
 * left out (players null) leaves the rolling pull request as it is.
 * @return {Promise<{list: Update[], errors: string[], players: PlayerSet|null}>}
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

  /** @type {PlayerSet|null} */
  let players = null;
  try {
    const pins = JSON.parse(fs.readFileSync(path.join(root, PLAYER_LIBRARIES), 'utf8'));
    for (const name of Object.keys(pins)) {
      if (!NPM_NAME.test(name)) throw new Error(`${PLAYER_LIBRARIES} names ${JSON.stringify(name)}, not an npm package`);
    }
    // hls.js is the repository's own pin (pnpm-patched): a library that needs another one waits.
    const devDependencies = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies || {};
    const hls = String(devDependencies['hls.js'] || '').replace(/^[\^~]/, '');
    /** @type {[string, RegistryDoc][]} */
    const fetched = [];
    for (const name of Object.keys(pins)) {
      fetched.push([name, await getJson(`https://registry.npmjs.org/${name.replaceAll('/', '%2F')}`)]);
    }
    const set = playerTargets(pins, Object.fromEntries(fetched), hls ? {'hls.js': hls} : {}, now);
    players = {...set, behind: set.changes.length > 0, state: playerState(set.target)};
  } catch (error) {
    errors.push(`player libraries: ${/** @type {Error} */ (error).message}`);
  }
  return {list, errors, players};
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
  const players = process.argv.indexOf('--apply-players');
  if (players >= 0) {
    const file = path.join(root, PLAYER_LIBRARIES);
    const {target} = JSON.parse(fs.readFileSync(process.argv[players + 1], 'utf8'));
    fs.writeFileSync(file, applyPlayers(fs.readFileSync(file, 'utf8'), target));
    return;
  }
  const {list, errors, players: set} = await updates();
  const plan_ = process.argv.indexOf('--plan');
  if (plan_ >= 0) {
    // The workflow acts on the tracks it has, then fails on `errors`.
    const open = JSON.parse(fs.readFileSync(process.argv[plan_ + 1], 'utf8'));
    const used = new Set(fs.readFileSync(process.argv[plan_ + 2], 'utf8').split(/\r?\n/).filter(Boolean));
    console.log(JSON.stringify({...plan(list, open, used, {raising: !process.argv.includes('--close-only')}), updates: list,
      players: set, errors}));
    return;
  }
  if (process.argv.includes('--json')) {
    for (const update of list) console.log(JSON.stringify(update));
  } else {
    for (const {name, current, latest, behind, note} of list) {
      console.log(`${behind ? 'UPDATE' : 'ok    '}  ${name.padEnd(13)} ${current.padEnd(8)} -> ${latest.padEnd(8)} ${note}`);
    }
    if (set) {
      console.log(`${set.behind ? 'UPDATE' : 'ok    '}  player libraries: ${set.changes.map(
          (/** @type {{name: string, from: string, to: string}} */ c) => `${c.name} ${c.from} -> ${c.to}`).join(', ') || 'all current'}`);
      for (const major of set.majors) console.log(`        a newer major, not taken: ${major.name} ${major.latest} (pinned ${major.current})`);
      for (const held of set.held) console.log(`        held back by a range: ${held.name} ${held.newest} (stays ${held.version})`);
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
