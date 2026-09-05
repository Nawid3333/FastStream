#!/usr/bin/env node
// Proves where chrome/player/modules/knob.mjs came from.
//
// knob.mjs is a rotary control adapted from jherrm/knobs. It cannot be
// generated: that repository has no package.json, so no package manager can
// install it, and it was never published to npm - the npm package called
// `knob` is mmckegg/knob, an unrelated canvas widget.
//
// So it is verified instead, the same way vtt.js is: fetch the file upstream,
// and check that what FastStream ships is that file plus a known, enumerated
// set of changes. This does not diff text - the vendored copy went through
// this project's eslint, which rewrites thousands of lines without changing
// behaviour - it compares parsed declarations.
//
// The claim it establishes: 10 of 11 top-level declarations and 33 of the 39
// `members` entries are structurally identical to upstream, and every single
// difference is one of the ten changes recorded in
// docs/vendored-libraries.md. Anything else, and this fails.
//
// Run with: pnpm run verify:knob   (needs network)

import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {compareDeclarations, normalise, parse} from './ast-compare.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');
const vendored = path.join(root, 'chrome/player/modules/knob.mjs');

// Pinned by commit, not branch. The 2022 head of this repository is a third
// larger and matches far worse; this is the revision tools/find-base.mjs
// identified.
const COMMIT = 'cf2db70f';
const UPSTREAM =
  `https://raw.githubusercontent.com/jherrm/knobs/${COMMIT}/Knob.js`;

// The ten changes from docs/vendored-libraries.md, as they appear structurally.
// `Knob` itself is expected to be ours alone: upstream keeps it inside an IIFE
// that this copy unwraps in order to export it.
const EXPECTED = {
  extraTopLevel: ['Knob'],
  // Rewritten: the value-based API, the scroll gesture, the element write,
  // and the __angleFromValue bug fix.
  changedMembers: [
    'val', 'doMouseScroll', '__validateAndPublishAngle', '__angleFromValue',
    '__publish',
  ],
  // Added by the fork.
  addedMembers: [
    '__validateAndPublishValue', '__validateValue', '__valueFromAngles',
  ],
  // Renamed to __valueFromAngles.
  removedMembers: ['__determineValue'],
};

/**
 * Extracts the properties of the `members` object literal.
 *
 * Every behavioural change in this fork lives inside that one object, so
 * comparing it property by property is what turns "the file differs" into a
 * list a reviewer can check against the documentation.
 *
 * @param {string} src JavaScript source
 * @return {Map<string, string>} property name to its canonical form
 */
function members(src) {
  const out = new Map();
  const find = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(find);
      return;
    }
    if (node.type === 'VariableDeclarator' && node.id.name === 'members' &&
        node.init && node.init.type === 'ObjectExpression') {
      for (const prop of node.init.properties) {
        const key = prop.key && (prop.key.name || prop.key.value);
        if (key) out.set(String(key), JSON.stringify(normalise(prop.value)));
      }
    }
    for (const k of Object.keys(node)) {
      if (k !== 'start' && k !== 'end' && k !== 'loc') find(node[k]);
    }
  };
  find(parse(src));
  return out;
}

const res = await fetch(UPSTREAM);
if (!res.ok) {
  console.error(`could not fetch ${UPSTREAM}: ${res.status}`);
  process.exit(1);
}
const upstream = await res.text();
const ours = fs.readFileSync(vendored, 'utf8');

const problems = [];
const same = (what, got, want) => {
  const a = [...got].sort().join(', ');
  const b = [...want].sort().join(', ');
  const ok = a === b;
  console.log(`  ${ok ? 'ok  ' : 'BAD '} ${what.padEnd(22)} ${a || '(none)'}`);
  if (!ok) problems.push(`${what}\n      expected: ${b}\n      found:    ${a}`);
};

const top = compareDeclarations(ours, upstream);
console.log(`jherrm/knobs @ ${COMMIT}\n`);
console.log(`  ${'ok  '} ${'top-level identical'.padEnd(22)} ` +
  `${top.same.length} of ${top.same.length + top.differs.length + top.onlyB.length}`);
same('top-level ours only', top.onlyA, EXPECTED.extraTopLevel);
same('top-level differing', top.differs, ['members']);
same('top-level theirs only', top.onlyB, []);

const a = members(ours);
const b = members(upstream);
const identical = [];
const changed = [];
const added = [];
for (const [k, v] of a) {
  if (!b.has(k)) added.push(k);
  else if (b.get(k) === v) identical.push(k);
  else changed.push(k);
}
const removed = [...b.keys()].filter((k) => !a.has(k));

console.log();
console.log(`  ${'ok  '} ${'members identical'.padEnd(22)} ` +
  `${identical.length} of ${b.size}`);
same('members changed', changed, EXPECTED.changedMembers);
same('members added', added, EXPECTED.addedMembers);
same('members removed', removed, EXPECTED.removedMembers);

if (problems.length) {
  console.error(
      `\n${problems.length} difference(s) this does not account for:\n    ` +
      problems.join('\n    ') +
      `\n\nEither knob.mjs changed without docs/vendored-libraries.md ` +
      `changing, or upstream moved. Re-derive the provenance before trusting ` +
      `either.`);
  process.exit(1);
}

console.log(
    `\nknob.mjs is jherrm/knobs Knob.js @ ${COMMIT} plus the ten changes in ` +
    `docs/vendored-libraries.md.\nVerified: ${top.same.length} of ` +
    `${top.same.length + 1} top-level declarations and ${identical.length} of ` +
    `${b.size} members\nare structurally identical, and every difference is ` +
    `one that is written down.`);
