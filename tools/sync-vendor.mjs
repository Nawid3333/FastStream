// @ts-check
// Copies third-party libraries from node_modules into chrome/player/modules/,
// where build.mjs and the browser's native ES module resolution expect them.
// AMO wants third-party code from official releases: each file is a pinned npm release plus a patch in patches/.
// The output is gitignored. Run after `pnpm install`; `pnpm run build` and `pnpm test` run it too.

import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {unappliedPatches} from './check-patched-updates.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');

/** The chunks mp4box's dist/mp4box.all.mjs imports; checked by checkMp4boxImports. */
const MP4BOX_CHUNKS = ['styp-BV5G3FS-.mjs', 'rolldown-runtime-CNh9ExCG.mjs'];

const VENDOR = [
  {
    name: 'hls.js',
    from: 'node_modules/hls.js/dist/hls.mjs',
    to: 'chrome/player/modules/hls.mjs',
    patched: true,
  },
  {
    // hls.js's own worker bundle, for HLSPlayer's workerPath; unpatched: the patch only widens hls.mjs's exports.
    name: 'hls.js',
    from: 'node_modules/hls.js/dist/hls.worker.js',
    to: 'chrome/player/modules/hls.worker.js',
    transform: normaliseText,
  },
  {
    name: 'dashjs',
    from: 'node_modules/dashjs/dist/modern/esm/dash.all.debug.js',
    to: 'chrome/player/modules/dash.mjs',
    patched: true,
    transform: normaliseText,
  },
  {
    // Stock build: the old vendored copy differed only by eslint --fix output (AST-verified).
    name: 'fuse.js',
    from: 'node_modules/fuse.js/dist/fuse.mjs',
    to: 'chrome/player/modules/fuse.mjs',
    transform: normaliseText,
  },
  {
    // Stock complete build: the old vendored copy differed only by its export shape and eslint --fix output.
    name: 'sortablejs',
    from: 'node_modules/sortablejs/modular/sortable.complete.esm.js',
    to: 'chrome/player/modules/sortable.mjs',
    transform: addSortableNamedExport,
  },
  {
    // Entry point and its two chunks copied as published, side by side; FastStream's changes are in the chunk's patch.
    // The chunk names carry a content hash: checkMp4boxImports fails the sync on any other import.
    name: 'mp4box',
    from: 'node_modules/mp4box/dist/mp4box.all.mjs',
    to: 'chrome/player/modules/mp4box/mp4box.all.mjs',
    transform: checkMp4boxImports,
  },
  ...MP4BOX_CHUNKS.map((chunk) => ({
    name: 'mp4box',
    from: `node_modules/mp4box/dist/${chunk}`,
    to: `chrome/player/modules/mp4box/${chunk}`,
    patched: chunk.startsWith('styp-'),
  })),
  {
    // mp4-muxer's successor (its 5.2.2 crashed where 4.3.3 did not); the ES module bundle as published.
    // Its four blob: Workers serve camera capture and alpha-channel video, which the remuxer never reaches.
    name: 'mediabunny',
    from: 'node_modules/mediabunny/dist/bundles/mediabunny.mjs',
    to: 'chrome/player/modules/remux/mediabunny.mjs',
    transform: normaliseText,
  },
  {
    // AST-identical to the old vendored copy, which was only beautified.
    name: 'gif.js',
    from: 'node_modules/gif.js/dist/gif.worker.js',
    to: 'chrome/player/modules/gif/gif.worker.js',
    transform: normaliseText,
  },
  {
    name: 'gif.js',
    from: 'node_modules/gif.js/dist/gif.js',
    to: 'chrome/player/modules/gif/gif.mjs',
    patched: true,
    transform: toGifModule,
  },
  {
    // A git dependency: mdbassit/Coloris is not on npm (`coloris` and @melloware/coloris are other projects);
    // the lockfile pins the commit and a tarball hash.
    name: 'Coloris',
    from: 'node_modules/Coloris/dist/coloris.js',
    to: 'chrome/player/modules/coloris.mjs',
    patched: true,
    transform: toColorisModule,
  },
  {
    // The picker's stylesheet, from the same commit, unminified so a reviewer can read it.
    name: 'Coloris',
    from: 'node_modules/Coloris/dist/coloris.css',
    to: 'chrome/player/assets/coloris/css/coloris.css',
    transform: normaliseText,
  },
];

/**
 * Adds the named export ui/ToolManager.mjs imports; the npm file ends in `export default Sortable`.
 * @param {string} src
 * @return {string}
 */
function addSortableNamedExport(src) {
  return normaliseText(src) + '\nexport {Sortable};\n';
}

/**
 * Checks that mp4box's entry point and its chunks import nothing but MP4BOX_CHUNKS:
 * a release that adds a chunk would otherwise copy cleanly and fail in the browser.
 * @param {string} src
 * @return {string}
 */
function checkMp4boxImports(src) {
  /** @type {(text: string) => string[]} */
  const importsOf = (text) => [...text.matchAll(/^import\s[^;]*?\sfrom\s+"\.\/([^"]+)";?$/gm)].map((m) => m[1]);
  const dist = path.join(root, 'node_modules/mp4box/dist');
  const found = new Set(importsOf(src));
  for (const chunk of MP4BOX_CHUNKS) {
    const file = path.join(dist, chunk);
    if (fs.existsSync(file)) importsOf(fs.readFileSync(file, 'utf8')).forEach((f) => found.add(f));
  }
  const unexpected = [...found].filter((f) => !MP4BOX_CHUNKS.includes(f));
  const unused = MP4BOX_CHUNKS.filter((f) => !found.has(f));
  if (unexpected.length || unused.length) {
    throw new Error(
        `mp4box's chunks changed (imported but not vendored: ${unexpected.join(', ') || 'none'}; ` +
        `vendored but not imported: ${unused.join(', ') || 'none'}). Update MP4BOX_CHUNKS ` +
        'and re-cut patches/mp4box@*.patch against the new chunk.');
  }
  return src;
}

/**
 * Turns gif.js's UMD build into an ES module whose worker URL resolves from import.meta.url.
 * Both anchors are asserted; the MIT notice is re-attached (gif.js's npm package has no LICENSE).
 * @param {string} src
 * @return {string}
 */
function toGifModule(src) {
  const umdHead = '(function(f){if(typeof exports==="object"&&typeof ' +
    'module!=="undefined"){module.exports=f()}else if(typeof define===' +
    '"function"&&define.amd){define([],f)}else{var g;if(typeof window!==' +
    '"undefined"){g=window}else if(typeof global!=="undefined"){g=global}' +
    'else if(typeof self!=="undefined"){g=self}else{g=this}g.GIF=f()}})(';
  const workerCall = 'new Worker(_this.options.workerScript)';

  if (!src.includes(umdHead)) {
    throw new Error(
        'gif.js UMD wrapper not found; its dist layout changed - re-check ' +
        'this transform before shipping a build.',
    );
  }
  const workers = src.split(workerCall).length - 1;
  if (workers !== 1) {
    throw new Error(
        `expected exactly one ${workerCall} in gif.js, found ${workers}; ` +
        'the worker-spawning code changed - re-check this transform.',
    );
  }

  const licence = [
    '/*', 'The MIT License (MIT)', '',
    'Copyright (c) 2013-2018 Johan Nordberg', '',
    'Permission is hereby granted, free of charge, to any person obtaining ' +
      'a copy',
    'of this software and associated documentation files (the "Software"), ' +
      'to deal',
    'in the Software without restriction, including without limitation the ' +
      'rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or ' +
      'sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:', '',
    'The above copyright notice and this permission notice shall be ' +
      'included in',
    'all copies or substantial portions of the Software.', '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, ' +
      'EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF ' +
      'MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT ' +
      'SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ' +
      'ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS ' +
      'IN',
    'THE SOFTWARE. */',
  ].join('\n');

  const preamble = licence + '\n\nexport let GIF;\n\n' +
    '// Resolved from this module rather than the document: see the note in\n' +
    '// tools/sync-vendor.mjs.\n' +
    'const WORKER_URL = new URL(\'gif.worker.js\', import.meta.url).href;\n\n';

  return preamble + normaliseText(src)
      .replace(umdHead, '(function(f) {\n  GIF = f();\n})(')
      .replace(workerCall, 'new Worker(WORKER_URL)');
}

/**
 * Normalises line endings and guarantees a trailing newline: a patch cannot carry dash.js's stray CRs.
 * @param {string} src
 * @return {string}
 */
function normaliseText(src) {
  const lf = src.replace(/\r\n/g, '\n').replace(/\r/g, '');
  return lf.endsWith('\n') ? lf : lf + '\n';
}

/**
 * Turns Coloris's dist bundle into an ES module: the wrapper goes, its declarations at module scope.
 * The behavioural changes are in patches/Coloris@<version>.patch.
 * @param {string} src
 * @return {string}
 */
function toColorisModule(src) {
  const head = '(function (window, document, Math, undefined) {\n';
  const tail = '})(window, document, Math);';
  if (!src.includes(head) || !src.includes(tail)) {
    throw new Error(
        'coloris: the UMD wrapper is not where it was. Re-derive the ' +
        'transform before trusting the generated module.');
  }
  return normaliseText(src)
      .replace(head, '')
      .replace(tail, '')
      .replace('window.Coloris = function () {', 'export const Coloris = function () {') +
    '\nColoris.bindElement = bindElement;\n';
}

/**
 * Writes every VENDOR entry's output; exits 1 if a patched library's patch is not
 * applied or a source is missing.
 */
function main() {
  // A library marked patched must have its patch applied at its version, checked before anything is copied.
  const unapplied = unappliedPatches(VENDOR, fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'), (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
    } catch (e) {
      return null; // not installed: the copy reports it MISSING
    }
  });
  if (unapplied.length) {
    unapplied.forEach((problem) => console.error(`UNPATCHED ${problem}`));
    process.exit(1);
  }

  let failed = false;

  for (const lib of VENDOR) {
    // `from` may be a list, concatenated in that recorded order.
    const sources = Array.isArray(lib.from) ? lib.from : [lib.from];
    const src = path.join(root, sources[0]);
    const dst = path.join(root, lib.to);

    const missing = sources.filter((f) => !fs.existsSync(path.join(root, f)));
    if (missing.length) {
      console.error(`MISSING ${lib.name}: ${missing.join(', ')}\n  run: pnpm install`);
      failed = true;
      continue;
    }

    const pkgPath = path.join(root, 'node_modules', lib.name, 'package.json');
    const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;

    /** @type {(f: string) => string} */
    const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
    const data = lib.transform ?
      Buffer.from(
          lib.transform(/** @type {string} */ (Array.isArray(lib.from) ? sources.map(read) : read(
              sources[0]))),
          'utf8') :
      fs.readFileSync(src);
    // Bytes are compared as bytes. No existsSync first: a failed read means "updated" (CodeQL js/file-system-race).
    const unchanged = (() => {
      try {
        return Buffer.compare(fs.readFileSync(dst), data) === 0;
      } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return false;
        throw e;
      }
    })();

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
}


// Run as a script (pnpm run build, vendor:sync, tools/rebuild.mjs), not when a test imports it.
if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  main();
}
