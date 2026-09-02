#!/usr/bin/env node
// Copies third-party libraries from node_modules into chrome/player/modules/,
// where build.mjs and the browser's native ES module resolution expect them.
//
// Why this exists: AMO requires third-party code to come from official
// releases. Previously chrome/player/modules/hls.mjs was a 1.3 MB file with
// no recorded version and no provenance - Mozilla could not verify what it
// was, which is the stated reason FastStream was refused. Now the file is
// generated from a pinned npm release plus a reviewable patch in patches/,
// so a reviewer can check the base by hash and read the diff in minutes.
//
// The generated files are gitignored. Run after `pnpm install`, or let
// `pnpm run build` do it.

import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');

/**
 * Libraries copied verbatim out of node_modules.
 *
 * `patched` records whether a patch in patches/ applies on install. Any
 * entry marked true must have a corresponding patchedDependencies line in
 * pnpm-workspace.yaml, or the copied file silently loses FastStream's
 * changes and playback breaks in ways that look like a network fault.
 */
const VENDOR = [
  {
    name: 'hls.js',
    from: 'node_modules/hls.js/dist/hls.mjs',
    to: 'chrome/player/modules/hls.mjs',
    patched: true,
  },
];

let failed = false;

for (const lib of VENDOR) {
  const src = path.join(root, lib.from);
  const dst = path.join(root, lib.to);

  if (!fs.existsSync(src)) {
    console.error(`MISSING ${lib.name}: ${lib.from}\n  run: pnpm install`);
    failed = true;
    continue;
  }

  const pkgPath = path.join(root, 'node_modules', lib.name, 'package.json');
  const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;

  const data = fs.readFileSync(src);
  const unchanged = fs.existsSync(dst) &&
    Buffer.compare(fs.readFileSync(dst), data) === 0;

  fs.mkdirSync(path.dirname(dst), {recursive: true});
  fs.writeFileSync(dst, data);

  const patch = lib.patched ? ' + patch' : '';
  const state = unchanged ? 'unchanged' : 'updated';
  console.log(
      `${lib.name}@${version}${patch} -> ${lib.to} (${state}, ` +
      `${(data.length / 1024).toFixed(0)} KB)`,
  );
}

if (failed) process.exit(1);
