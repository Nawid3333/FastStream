#!/usr/bin/env node
// Hashes an unpacked extension build so two builds can be compared.
//
// Text files are hashed with CRLF collapsed to LF. Without that, a build made
// on Windows never matches one made on Linux CI even when every byte of
// meaning is the same - line endings alone change all 620 text hashes. Binary
// assets (png, wasm, ort) are hashed verbatim.
//
//   node tools/hash-build.mjs build_firefox_github > before.txt
//   ...refactor...
//   node tools/hash-build.mjs build_firefox_github > after.txt
//   diff before.txt after.txt
//
// Any change claiming to be output-neutral must produce an empty diff.

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TEXT = new Set([
  '.mjs', '.js', '.json', '.html', '.css', '.md', '.svg', '.txt',
]);

/**
 * Lists every file under dir, depth first, as paths relative to dir.
 * @param {string} dir Directory to walk.
 * @param {string} [base] Internal: the root the paths are relative to.
 * @return {string[]} Relative POSIX-style paths, unsorted.
 */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

const root = process.argv[2];
if (!root || !fs.existsSync(root)) {
  console.error('usage: node tools/hash-build.mjs <build-dir>');
  console.error('hint: run `pnpm run build:keep` first - a plain build deletes');
  console.error('      the unpacked directories and leaves only zips.');
  process.exit(2);
}

for (const rel of walk(root).sort()) {
  let buf = fs.readFileSync(path.join(root, rel));
  if (TEXT.has(path.extname(rel).toLowerCase())) {
    buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  }
  console.log(`${createHash('sha256').update(buf).digest('hex')}  ${rel}`);
}
