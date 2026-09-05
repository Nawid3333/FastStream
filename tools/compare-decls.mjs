#!/usr/bin/env node
// Compares two JavaScript files declaration by declaration.
//
// Whole-file comparison answers "is this the same program?" and stops being
// useful the moment the answer is no. The files this project has to account
// for are concatenations and adapted forks, so the question that actually
// matters is *which parts* match: when 35 of 35 top-level declarations are
// identical to the published sources, the file is those sources, and the
// remainder is the change list to document.
//
// This is how webm.mjs was settled - 30 of 35 declarations were already
// byte-for-byte jswebm's, which turned an unverifiable 104 KB blob into a
// published tarball plus five named changes.
//
// Usage:
//   node tools/compare-decls.mjs <fileA> <fileB> [name]
//
// With a name, prints where that one declaration first diverges instead of
// the summary, which is what you want once the summary has narrowed it down.
// A name may be a declaration or an assignment path like
// `ISOFile.prototype.getSample`.
//
// Both sections matter. A prototype-based library declares almost nothing and
// then hangs everything off assignments: mp4box has 12 declarations and 339
// assignments, and reading only the first section reported "2 differing" while
// missing four changed prototype methods and three that exist in one file and
// not the other.

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

const show = (label, list) =>
  console.log(`${label.padEnd(12)} ${list.length}` +
    (list.length && label !== 'identical' ? `  ${list.join(', ')}` : ''));

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
