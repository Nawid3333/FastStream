// @ts-check
// Compares two JavaScript files declaration by declaration.
// Which declarations match, not only whether the files do: what matches is the published source.
// Usage:
//   node tools/compare-decls.mjs <fileA> <fileB> [name]
// With a name (a declaration, or an assignment path like ISOFile.prototype.getSample): where it first diverges.
// Both declarations and assignments: a prototype-based library declares almost nothing.

import fs from 'node:fs';

import {compareDeclarations, comparePrototypes, declarations,
  prototypeAssignments} from './ast-compare.mjs';

const [fileA, fileB, name] = process.argv.slice(2);
if (!fileA || !fileB) {
  console.error('usage: node tools/compare-decls.mjs <fileA> <fileB> [name]');
  process.exit(2);
}

const a = fs.readFileSync(fileA, 'utf8');
const b = fs.readFileSync(fileB, 'utf8');

if (name) {
  const x = declarations(a).get(name) ?? prototypeAssignments(a).get(name);
  const y = declarations(b).get(name) ?? prototypeAssignments(b).get(name);
  if (!x || !y) {
    console.error(`${name} is missing from ${x ? fileB : fileA}`);
    process.exit(1);
  }
  if (x === y) {
    console.log(`${name}: identical`);
    process.exit(0);
  }
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  console.log(`${name}: A ${x.length}, B ${y.length}, diverges at ${i}`);
  console.log('  A:', x.slice(Math.max(0, i - 100), i + 240));
  console.log('  B:', y.slice(Math.max(0, i - 100), i + 240));
  process.exit(1);
}

/**
 * @param {string} label
 * @param {string[]} list
 */
const show = (label, list) =>
  console.log(`${label.padEnd(12)} ${list.length}` +
    (list.length && label !== 'identical' ? `  ${list.join(', ')}` : ''));

/**
 * @param {string} heading
 * @param {{same: string[], differs: string[], onlyA: string[], onlyB: string[]}} r
 */
const report = (heading, r) => {
  console.log(heading);
  show('identical', r.same);
  show('differing', r.differs);
  show('only in A', r.onlyA);
  show('only in B', r.onlyB);
  console.log();
  return !r.differs.length && !r.onlyA.length && !r.onlyB.length;
};

const decls = report('declarations', compareDeclarations(a, b));
const protos = report('assignments', comparePrototypes(a, b));

if (decls && protos) {
  console.log('Every top-level declaration and assignment matches.');
} else {
  console.log('Re-run with a name to see where one of them diverges.');
  process.exit(1);
}
