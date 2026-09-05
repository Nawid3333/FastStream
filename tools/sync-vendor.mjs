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
  {
    // The complete build already mounts AutoScroll, Remove/Revert, Swap and
    // MultiDrag exactly as the vendored copy did; only the export shape
    // differed. Everything else was "eslint --fix" output, including four
    // combined var declarations split into ~62 separate let/const statements,
    // which is what inflated the textual diff to 1613 lines.
    name: 'sortablejs',
    from: 'node_modules/sortablejs/modular/sortable.complete.esm.js',
    to: 'chrome/player/modules/sortable.mjs',
    transform: addSortableNamedExport,
  },
  {
    name: 'sweetalert2',
    from: 'node_modules/sweetalert2/dist/sweetalert2.js',
    to: 'chrome/player/modules/sweetalert.mjs',
    transform: toSweetAlertModule,
  },
  {
    // The vendored copy of this was hand-minified by the upstream author
    // ("Minified to reduce loading time (https://minify-js.com/)"), which is
    // the one thing AMO's policy on minified code is explicitly about: a
    // reviewer cannot read it and it corresponds to no published artifact.
    // onnxruntime-web publishes an unminified ESM build of exactly this
    // bundle, with an identical export list, so use that instead.
    //
    // Only the JavaScript API layer comes from npm. The wasm binary beside it
    // and its emscripten glue cannot: see docs/vendored-libraries.md.
    name: 'onnxruntime-web',
    from: 'node_modules/onnxruntime-web/dist/ort.wasm.mjs',
    to: 'chrome/player/modules/vad/ort.wasm.mjs',
    transform: stripInlineSourceMap,
  },
  {
    // Proven, not assumed: the vendored copy's AST is *identical* to this
    // build's once the project's own `eslint --fix` transformations are
    // normalised away - one-var splitting, curly, quote style,
    // no-var/prefer-const, and re-indentation inside a template literal.
    // Nothing else differed, so this is the same code the fork already ships.
    name: 'mp4-muxer',
    from: 'node_modules/mp4-muxer/build/mp4-muxer.mjs',
    to: 'chrome/player/modules/reencoder/mp4-muxer.mjs',
    transform: normaliseText,
  },
  {
    // Also AST-identical to the vendored copy; that one was only run through
    // a beautifier, since gif.js publishes its dist on one line.
    name: 'gif.js',
    from: 'node_modules/gif.js/dist/gif.worker.js',
    to: 'chrome/player/modules/gif/gif.worker.js',
    transform: normaliseText,
  },
  {
    name: 'gif.js',
    from: 'node_modules/gif.js/dist/gif.js',
    to: 'chrome/player/modules/gif/gif.mjs',
    transform: toGifModule,
  },
  {
    // The one vendored file that is a *concatenation* rather than a copy.
    // jswebm publishes its src/ in the npm tarball alongside the webpack
    // bundle, so each piece can be checked against a published file: 30 of
    // the 35 top-level declarations in the old vendored copy were already
    // byte-for-byte identical to these, once eslint's autofixes were
    // normalised away. The other five are FastStream's - colour metadata
    // parsing, a VP9 codec string, and three fixes - and live in
    // patches/jswebm@0.1.2.patch where a reviewer can read them.
    //
    // src/Chapters.js and src/Queue.js are deliberately absent: the vendored
    // file never included them and nothing references them.
    name: 'jswebm',
    from: [
      // Track must precede the two classes that extend it, and JsWebm must
      // follow everything it constructs. Beyond that the order is the
      // alphabetical one the original concatenation used.
      'node_modules/jswebm/src/Track.js',
      'node_modules/jswebm/src/VideoTrack.js',
      'node_modules/jswebm/src/AudioTrack.js',
      'node_modules/jswebm/src/BlockGroup.js',
      'node_modules/jswebm/src/Cluster.js',
      'node_modules/jswebm/src/CueTrackPositions.js',
      'node_modules/jswebm/src/Cues.js',
      'node_modules/jswebm/src/DataInterface/DataInterface.js',
      'node_modules/jswebm/src/DataInterface/DateParser.js',
      'node_modules/jswebm/src/ElementHeader.js',
      'node_modules/jswebm/src/JsWebm.js',
      'node_modules/jswebm/src/Seek.js',
      'node_modules/jswebm/src/SeekHead.js',
      'node_modules/jswebm/src/SegmentInfo.js',
      'node_modules/jswebm/src/SimpleBlock.js',
      'node_modules/jswebm/src/SimpleTag.js',
      'node_modules/jswebm/src/Tag.js',
      'node_modules/jswebm/src/Tags.js',
      'node_modules/jswebm/src/Targets.js',
      'node_modules/jswebm/src/Tracks.js',
    ],
    to: 'chrome/player/modules/reencoder/webm.mjs',
    patched: true,
    transform: toWebmModule,
  },
];

/**
 * Drops a trailing inline base64 sourcemap.
 *
 * onnxruntime-web's unminified bundle is 539 KB, of which 410 KB is an inline
 * sourcemap pointing at TypeScript sources we do not ship. Removing it leaves
 * 129 KB of readable JavaScript - still far more reviewable than the 47 KB of
 * hand-minified code it replaces, and without shipping a map that resolves to
 * nothing.
 *
 * @param {string} src file contents
 * @return {string} contents without the inline sourcemap
 */
function stripInlineSourceMap(src) {
  return normaliseText(src)
      .replace(/\n\/\/# sourceMappingURL=data:[^\n]*\n?$/, '\n');
}

/**
 * Removes sweetalert2's locale-triggered message block.
 *
 * Upstream sweetalert2 ships a block that, for users whose browser language
 * is Russian and who are on a .ru/.su/.by/.xn--p1ai host, sets
 * `document.body.style.pointerEvents = 'none'` to make the page unusable and
 * appends an <audio> element that streams and loops a file from
 * https://flag-gimn.ru. The previously vendored copy had this removed, and it
 * must stay removed:
 *
 * - it loads remote media from a third-party host at runtime, which fails
 *   AMO review on its own,
 * - it disables interaction with whatever page the extension is running on,
 * - and it triggers on the user's language, not on anything they asked for.
 *
 * The block is located by its distinctive host test and removed by brace
 * matching rather than by a line range, so it survives reformatting. If the
 * marker is ever absent - upstream removing it would be the happy case - this
 * returns the source unchanged rather than failing the build.
 *
 * @param {string} text sweetalert2 source
 * @return {string} the same source with the block removed
 */
function stripLocaleMessageBlock(text) {
  const marker = text.indexOf('if (typeof window !== \'undefined\' && /^ru\\b/');
  if (marker < 0) {
    return text;
  }

  let depth = 0;
  let end = -1;
  for (let i = text.indexOf('{', marker); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end < 0) {
    throw new Error(
        'sweetalert2 locale-message block found but its braces do not close - ' +
        'refusing to ship it. Re-check this transform.',
    );
  }

  // Also take the indentation preceding it, so no stray blank line is left.
  const lineStart = text.lastIndexOf('\n', marker) + 1;
  return text.slice(0, lineStart) + text.slice(end).replace(/^\n/, '');
}

/**
 * Adds the named export FastStream imports.
 *
 * sortablejs's complete build ends in `export default Sortable`, but
 * ui/ToolManager.mjs does `import {Sortable} from '../modules/sortable.mjs'`.
 * The vendored copy achieved that by exporting the function declaration
 * directly; adding a named export alongside the default is equivalent and
 * leaves the npm file untouched.
 *
 * @param {string} src sortablejs's complete ESM build
 * @return {string} the same module with a named Sortable export
 */
function addSortableNamedExport(src) {
  return normaliseText(src) + '\nexport {Sortable};\n';
}

/**
 * Converts sweetalert2's UMD build to an ES module and retargets it at
 * FastStream's player container.
 *
 * Three changes, all of which the vendored copy also made:
 *
 * 1. The UMD dispatcher is replaced with a plain `swl = factory()`, since
 *    neither CommonJS nor AMD exists here and the global assignment is not
 *    wanted.
 * 2. Every `document.body` becomes `document_body`, bound to
 *    `DOMElements.playerContainer`. This is the one behavioural change:
 *    dialogs must render inside FastStream's player container, not the host
 *    page's body - the player is often in a fullscreen or shadow context
 *    where document.body is the wrong parent. There are exactly 32
 *    occurrences, matching the 32 in the vendored copy, and none left over.
 * 3. The trailing global assignment becomes the ES export that
 *    utils/AlertPolyfill.mjs imports.
 *
 * It also strips sweetalert2's locale-triggered message block - see
 * stripLocaleMessageBlock. The vendored copy had it removed too; leaving it
 * in would be an AMO failure and a real user-harm bug.
 *
 * @param {string} src sweetalert2's UMD dist build
 * @return {string} an ES module scoped to the player container
 */
function toSweetAlertModule(src) {
  const text = stripLocaleMessageBlock(normaliseText(src));

  const umdHead = /\(function \(global, factory\) \{\n[\s\S]*?\n\}\)\(this, /;
  if (!umdHead.test(text)) {
    throw new Error(
        'sweetalert2 UMD wrapper not in the expected shape - re-check this ' +
        'transform against the new release.',
    );
  }

  const globalTail = /\nif \(typeof this !== 'undefined' && this\.Sweetalert2\)\{[^\n]*\}\n?$/;
  if (!globalTail.test(text)) {
    throw new Error(
        'sweetalert2 global-assignment tail not found - re-check this ' +
        'transform against the new release.',
    );
  }

  return 'import {DOMElements} from \'../ui/DOMElements.mjs\';\n\n' +
    'const document_body = DOMElements.playerContainer;\n' +
    'let swl;\n' +
    text
        .replace(umdHead, '(function (global, factory) {\n  swl = factory();\n})(this, ')
        .replace(/document\.body/g, 'document_body')
        .replace(globalTail, '\n') +
    '\nexport const SweetAlert = swl;\n';
}

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
 * Turns gif.js's UMD build into an ES module that loads a real worker file.
 *
 * Two changes, both forced by the extension environment, and both matching
 * what the previously vendored copy did by hand:
 *
 * 1. The UMD dispatcher assigns the factory result to `window.GIF`.
 *    LoopMenu.mjs does `import {GIF}`, so the dispatcher is replaced by a
 *    direct assignment to a module binding. It has to be `let`, because the
 *    assignment happens when the factory is called, not at declaration.
 *
 * 2. gif.js defaults `options.workerScript` to a bare 'gif.worker.js', which
 *    the browser resolves against the *document*. In the extension the player
 *    page is not in this directory, so that 404s. Resolving against
 *    `import.meta.url` instead points at the worker we ship beside this file.
 *    (gif.js has no blob-worker path, so unlike hls.js this is the only
 *    reason a separate worker file is needed.)
 *
 * Both anchors are asserted rather than pattern-matched loosely: if a future
 * version of gif.js changes either, this throws instead of silently emitting
 * a module that exports nothing or spawns a worker from the wrong URL.
 *
 * The MIT notice is re-attached because gif.js ships no LICENSE file in its
 * npm package - it lives only in the repository - and the licence requires
 * the notice to travel with redistributed copies.
 *
 * @param {string} src contents of gif.js's UMD dist build
 * @return {string} an ES module exporting GIF
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

/**
 * Concatenates jswebm's CommonJS sources into one ES module.
 *
 * Each file is a plain script that requires its siblings and assigns to
 * `module.exports`. Concatenated in dependency order those statements are
 * both unnecessary and invalid, so they are dropped; the classes then share
 * one scope, which is exactly what the original vendored file did.
 *
 * The export shape matches what demuxers.mjs imports, plus the global the
 * vendored file also set. Neither is patched into node_modules, because
 * jswebm's own package must stay valid CommonJS for anything else that
 * loads it.
 *
 * @param {string[]} sources the source of each file, in concatenation order
 * @return {string} one ES module
 */
function toWebmModule(sources) {
  const isRequire = /^\s*(?:const|var|let)\s+\w+\s*=\s*require\(/;
  const isExport = /^\s*module\.exports\s*=/;
  const body = sources.map((src) => src
      .split('\n')
      .filter((line) => !isRequire.test(line) && !isExport.test(line))
      .join('\n')
      .trim(),
  ).join('\n\n');

  return body.replace(/^class JsWebm \{/m, 'export class JsWebm {') +
    '\n\nwindow.JsWebm = JsWebm;\n';
}

let failed = false;

for (const lib of VENDOR) {
  // `from` is a list when the vendored file is a concatenation of several
  // published sources rather than a copy of one - see webm.mjs. The order is
  // load-bearing, so it is recorded in the entry rather than inferred here.
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

  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const data = lib.transform ?
    Buffer.from(
        lib.transform(Array.isArray(lib.from) ? sources.map(read) : read(
            sources[0])),
        'utf8') :
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
