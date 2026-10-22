#!/usr/bin/env node
// @ts-check
// The noImplicitAny ratchet (`pnpm run typecheck:strict`, a step of CI's lint job).
// tsconfig.json leaves noImplicitAny off, so a value TypeScript cannot type is `any` and
// goes unchecked. This runs the same check with the flag on and compares each file's error
// count with the record, types/implicit-any.json: a count may only fall, and a file the
// record leaves out (a file at 0, or a new one) must stay at 0.
//
//   - A count above the record fails: type what the change added (JSDoc, no `*` or `any`
//     that only silences the error).
//   - A count below the record fails too, until the record is lowered, so that a file
//     typed once cannot go back unnoticed: run `pnpm run typecheck:strict -- --update`
//     and commit types/implicit-any.json.
//
// Usage: node tools/check-implicit-any.mjs [--update]

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RECORD = 'types/implicit-any.json';

/**
 * Each file's error count in tsc's output.
 * @param {string} output - What `tsc --noEmit` printed.
 * @return {Object<string, number>} By file, relative to the repository, with `/`.
 */
export function countByFile(output) {
  /** @type {Object<string, number>} */
  const counts = {};
  for (const line of output.split(/\r?\n/)) {
    const m = /^(.+?)\(\d+,\d+\): error TS\d+:/.exec(line.trim());
    if (!m) continue;
    const file = m[1].replace(/\\/g, '/');
    counts[file] = (counts[file] || 0) + 1;
  }
  return counts;
}

/**
 * How the counts now differ from the record. A file the record leaves out counts as 0.
 * @param {Object<string, number>} recorded
 * @param {Object<string, number>} current
 * @return {{grown: {file: string, was: number, now: number}[], fallen: {file: string, was: number, now: number}[]}}
 */
export function compareCounts(recorded, current) {
  const files = [...new Set([...Object.keys(recorded), ...Object.keys(current)])].sort();
  const grown = [];
  const fallen = [];
  for (const file of files) {
    const was = recorded[file] || 0;
    const now = current[file] || 0;
    if (now > was) grown.push({file, was, now});
    else if (now < was) fallen.push({file, was, now});
  }
  return {grown, fallen};
}

/**
 * The record's text: files with errors only, sorted, so a diff shows what moved.
 * @param {Object<string, number>} counts
 * @return {string}
 */
export function recordText(counts) {
  /** @type {Object<string, number>} */
  const sorted = {};
  for (const file of Object.keys(counts).sort()) {
    if (counts[file] > 0) sorted[file] = counts[file];
  }
  return JSON.stringify(sorted, null, 2) + '\n';
}

function main() {
  // TypeScript 7 exports no ./bin/tsc; its package.json (exported) names the script.
  const pkg = createRequire(path.join(root, 'package.json')).resolve('typescript/package.json');
  const tsc = path.join(path.dirname(pkg), JSON.parse(fs.readFileSync(pkg, 'utf8')).bin.tsc);
  const run = spawnSync(process.execPath, [tsc, '--noEmit', '--noImplicitAny'], {cwd: root, encoding: 'utf8', maxBuffer: 1 << 28});
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const current = countByFile(output);
  // tsc exits 2 when it reports errors; anything else without an error line is its own failure.
  if (run.status !== 0 && Object.keys(current).length === 0) {
    console.error(output || run.error || `tsc exited with ${run.status}`);
    return 1;
  }
  const recordFile = path.join(root, RECORD);
  if (process.argv.includes('--update')) {
    // The first --update writes the record; later ones only lower it.
    const recorded = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, 'utf8')) : current;
    const {grown} = compareCounts(recorded, current);
    if (grown.length) {
      for (const g of grown) console.error(`${g.file}: ${g.was} -> ${g.now} untyped places; the record is not raised`);
      return 1;
    }
    fs.writeFileSync(recordFile, recordText(current));
    console.log(`${RECORD}: ${Object.values(current).reduce((a, b) => a + b, 0)} untyped places in ${Object.keys(current).length} files`);
    return 0;
  }
  const recorded = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  const {grown, fallen} = compareCounts(recorded, current);
  for (const g of grown) {
    console.error(`${g.file}: ${g.was} -> ${g.now} untyped places (noImplicitAny). Type what the change added.`);
  }
  for (const f of fallen) {
    console.error(`${f.file}: ${f.was} -> ${f.now} untyped places. Lower the record: pnpm run typecheck:strict -- --update`);
  }
  if (grown.length || fallen.length) {
    if (grown.length) console.error(output.split(/\r?\n/).filter((l) => grown.some((g) => l.startsWith(`${g.file}(`))).join('\n'));
    return 1;
  }
  console.log(`noImplicitAny: ${Object.values(current).reduce((a, b) => a + b, 0)} untyped places in ${Object.keys(current).length} files, as recorded`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
