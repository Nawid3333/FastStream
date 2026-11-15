// @ts-check
// Whether a change is comments only - JSDoc types, casts, notes - as a typing pass should be.
// Each .js/.mjs file that differs from <base> is parsed as it was there and as it is now, and
// the two programs are compared without positions, comments, parentheses (a JSDoc cast needs
// them, acorn drops them) and a literal's raw text (its quotes). Lists every file whose code
// differs, with the line where it first does; exits 1 when one does.
//
//   node tools/same-code.mjs <base commit> [path ...]     (paths default to chrome)
//
// Run from the repository's root. A file that is new (untracked ones too), or gone, counts as
// differing.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {parse} from './ast-compare.mjs';

const [given, ...paths] = process.argv.slice(2);

/** @param {string[]} args - quotePath off: a name with other than ASCII in it comes as it is. */
const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
  encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
});

// Git says whether it names a commit: none given, or a mistyped one, gets the usage.
let base = '';
try {
  base = git('rev-parse', '--verify', '--end-of-options', `${given ?? ''}^{commit}`).trim();
} catch {
  console.error('usage: node tools/same-code.mjs <base commit> [path ...]');
  process.exit(2);
}

/**
 * The program without what carries no behaviour.
 * @param {string} src
 * @return {any}
 */
function program(src) {
  return JSON.parse(JSON.stringify(parse(src), /** @this {any} @param {string} key @param {any} value */ function(key, value) {
    if (key === 'start' || key === 'end') return undefined;
    // A literal's raw text is its quotes; a template's is what a tag gets (String.raw).
    if (key === 'raw' && this.type === 'Literal') return undefined;
    return typeof value === 'bigint' ? `${value}n` : value;
  }));
}

/** @param {any} node */
const rawStart = (node) => (typeof node?.start === 'number' ? node.start : -1);

/**
 * The first node of `b` that differs from `a`, with its start in the source.
 * @param {any} a
 * @param {any} b
 * @param {any} rawB the same node of `b` before program() dropped its positions
 * @return {number | null} the start of the differing node, -1 when no position is known
 */
function firstDifference(a, b, rawB) {
  if (a === b) return null;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    return rawStart(rawB);
  }
  const lists = Array.isArray(a);
  // A list is compared over the part both have, before a missing element is looked at: that
  // has no position of its own.
  const keys = lists ? Array.from({length: Math.min(a.length, b.length)}, (_, i) => i) :
    new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const found = firstDifference(a[key], b[key], rawB?.[key]);
    if (found !== null) return found === -1 ? rawStart(rawB) : found;
  }
  if (lists && a.length !== b.length) {
    // the first element added, or the last one left when some were removed
    return rawStart(rawB?.[a.length < b.length ? a.length : b.length - 1]);
  }
  return null;
}

/** @param {string} src @param {number} at */
const lineOf = (src, at) => (at < 0 ? '?' : String(src.slice(0, at).split('\n').length));

const pathspec = paths.length ? paths : ['chrome'];
const changed = [...new Set([
  ...git('diff', '--name-only', '--diff-filter=ACMRD', base, '--', ...pathspec).split('\n'),
  ...git('ls-files', '--others', '--exclude-standard', '--', ...pathspec).split('\n'),
])].filter((file) => /\.m?js$/.test(file));

let differ = 0;
for (const file of changed) {
  let before = null;
  try {
    before = git('show', `${base}:${file}`);
  } catch {
    // new since <base>
  }
  const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (before === null || after === null) {
    console.log(`${before === null ? 'NEW ' : 'GONE'}  ${file}`);
    differ++;
    continue;
  }
  const rawAfter = parse(after);
  const at = firstDifference(program(before), program(after), rawAfter);
  if (at !== null) {
    differ++;
    console.log(`CODE  ${file}:${lineOf(after, at)}`);
  }
}
console.log(`${changed.length} changed file(s): ${changed.length - differ} with the same code, ${differ} differ`);
process.exitCode = differ ? 1 : 0;
