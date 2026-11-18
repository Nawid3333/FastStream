// @ts-check
// Hashes an unpacked extension build so two builds can be compared.
// Text files are hashed with CRLF collapsed to LF, so a Windows build matches a Linux one.
//   node tools/hash-build.mjs build_firefox_github > before.txt
//   ...refactor...
//   node tools/hash-build.mjs build_firefox_github > after.txt
//   diff before.txt after.txt
// An output-neutral change gives an empty diff.

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TEXT = new Set([
  '.mjs', '.js', '.json', '.html', '.css', '.md', '.svg', '.txt',
]);

/**
 * @param {string} dir
 * @param {string} [base]
 * @return {string[]}
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
