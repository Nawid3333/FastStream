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
  {
    name: 'hls.js',
    from: 'node_modules/hls.js/dist/hls.js',
    to: 'chrome/player/modules/hls.worker.js',
    patched: true,
    transform: toClassicWorker,
  },
  {
    name: 'dashjs',
    from: 'node_modules/dashjs/dist/modern/esm/dash.all.debug.js',
    to: 'chrome/player/modules/dash.mjs',
    patched: true,
    transform: normaliseText,
  },
  {
    // Stock build, no patch. The previously vendored copy differed only by
    // "eslint --fix" output - 32 let->const, one var->const, one quote style
    // (same string value) - plus an eslint-disable header. Verified by AST
    // comparison; the exports are identical.
    name: 'fuse.js',
    from: 'node_modules/fuse.js/dist/fuse.mjs',
    to: 'chrome/player/modules/fuse.mjs',
    transform: normaliseText,
  },
  {
    name: 'pako',
    from: 'node_modules/pako/dist/pako.js',
    to: 'chrome/player/modules/pako.mjs',
    transform: toPakoModule,
  },
];

/**
 * Wraps pako's UMD build as an ES module.
 *
 * pako ships UMD, which assigns to `window.pako`; FastStream imports
 * `{Pako}` from this file in modules/analyzer/VideoAligner.mjs. The previously
 * vendored copy was stock pako 2.1.0 with exactly this one line appended,
 * plus an eslint-disable header and some reformatted brace placement - all of
 * which parse to an identical AST, verified against the vendored file before
 * this replaced it. So no patch is needed: the npm file is used untouched and
 * only the export is added.
 *
 * @param {string} src pako's UMD dist build
 * @return {string} the same file, re-exported as an ES module
 */
function toPakoModule(src) {
  return normaliseText(src).replace(/\s*$/, '\n') +
    '\nexport const Pako = window.pako;\n';
}

/**
 * Normalises line endings and guarantees a trailing newline.
 *
 * dash.js's published bundle embeds 428 stray CR characters inside a vendored
 * BSD licence comment, because one of its bundled dependencies ships CRLF
 * source. Diff and patch formats cannot represent a trailing-CR-only change
 * reliably, so the patch in patches/ cannot carry that difference and it has
 * to be normalised here instead. Without this the generated file differs from
 * the previously vendored one by exactly those 428 bytes plus a final
 * newline - a pure whitespace difference inside a comment, but one that would
 * break byte-for-byte verification against the baseline build.
 *
 * @param {string} src file contents
 * @return {string} contents with LF endings and a trailing newline
 */
function normaliseText(src) {
  const lf = src.replace(/\r\n/g, '\n').replace(/\r/g, '');
  return lf.endsWith('\n') ? lf : lf + '\n';
}

/**
 * Turns hls.js's UMD build into a standalone classic worker script.
 *
 * hls.js normally builds its own worker at runtime from a `blob:` URL, but
 * Manifest V3's extension CSP blocks blob workers, so HLSPlayer.mjs sets the
 * `workerPath` config option (official hls.js API) to a real file in the
 * package instead. That file is what this produces.
 *
 * The transform is deliberately the same one hls.js applies to itself: its
 * UMD bundle is wrapped in a `__HLS_WORKER_BUNDLE__(__IN_WORKER__)` function
 * that self-invokes with `false` on the main thread, and hls.js's blob path
 * re-invokes that same function with `true` behind a tiny CommonJS/AMD shim.
 * So: prepend the shim, flip the final `(false)` to `(true)`, and drop the
 * sourcemap reference to a .map we do not ship.
 *
 * @param {string} src contents of hls.js's UMD dist build
 * @return {string} a classic worker script
 */
function toClassicWorker(src) {
  const body = src.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
  const tail = '})(false);\n';
  if (!body.endsWith(tail)) {
    throw new Error(
        'hls.js UMD build does not end with the expected worker-bundle ' +
        `self-invocation; got ${JSON.stringify(body.slice(-40))}. The ` +
        'upstream build layout changed - re-check this transform.',
    );
  }
  return 'var exports={};var module={exports:exports};' +
    'function define(f){f()};define.amd=true;\n' +
    body.slice(0, -tail.length) + '})(true);\n';
}

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

  const data = lib.transform ?
    Buffer.from(lib.transform(fs.readFileSync(src, 'utf8')), 'utf8') :
    fs.readFileSync(src);
  const unchanged = fs.existsSync(dst) &&
    Buffer.compare(fs.readFileSync(dst), data) === 0;

  fs.mkdirSync(path.dirname(dst), {recursive: true});
  fs.writeFileSync(dst, data);

  const kind = [lib.patched && '+ patch', lib.transform && 'generated']
      .filter(Boolean).join(', ');
  const state = unchanged ? 'unchanged' : 'updated';
  console.log(
      `${lib.name}@${version}${kind ? ' ' + kind : ''} -> ${lib.to} (${state}, ` +
      `${(data.length / 1024).toFixed(0)} KB)`,
  );
}

if (failed) process.exit(1);
