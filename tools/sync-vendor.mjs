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
/** The chunks mp4box's dist/mp4box.all.mjs imports; checked by checkMp4boxImports. */
const MP4BOX_CHUNKS = ['styp-9TIZZDLN.mjs', 'rolldown-runtime-w6R9maHv.mjs'];

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
    // pako 3.x ships real ESM with named `deflate`/`inflate` exports, so
    // (unlike the 2.x UMD build this replaced) it needs no wrapper at all -
    // just a straight copy. modules/analyzer/VideoAligner.mjs imports the
    // two functions directly rather than through a synthetic `Pako` object.
    name: 'pako',
    from: 'node_modules/pako/dist/pako.mjs',
    to: 'chrome/player/modules/pako.mjs',
    transform: normaliseText,
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
    patched: true,
    transform: toSweetAlertModule,
  },
  {
    // The dialogs' stylesheet, from the same release as the script above. Until 2026-09-30
    // the copy here was 11.12.4's (2024) while the script followed npm.
    name: 'sweetalert2',
    from: 'node_modules/sweetalert2/dist/sweetalert2.css',
    to: 'chrome/player/assets/sweetalert/css/sweetalert.css',
    transform: toSweetAlertCss,
  },
  {
    // The vendored copy of this was hand-minified by the upstream author
    // ("Minified to reduce loading time (https://minify-js.com/)"), which is
    // the one thing AMO's policy on minified code is explicitly about: a
    // reviewer cannot read it and it corresponds to no published artifact.
    // onnxruntime-web publishes an unminified ESM build of exactly this
    // bundle, with an identical export list, so use that instead.
    name: 'onnxruntime-web',
    from: 'node_modules/onnxruntime-web/dist/ort.wasm.mjs',
    to: 'chrome/player/modules/vad/ort.wasm.mjs',
    transform: stripInlineSourceMap,
  },
  {
    // The runtime that loader drives, from the same release, as published: it
    // imports the emscripten glue beside itself, and the glue fetches the wasm
    // beside itself. The loader and the runtime must be one release. The
    // custom 1 MB runtime shipped until 1.3.82.44 was built from a commit two
    // months before 1.20.0, and a 1.30.0 loader on it failed (#23); see
    // docs/vendored-libraries.md, "The VAD blobs".
    name: 'onnxruntime-web',
    from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
    to: 'chrome/player/modules/vad/ort-wasm-simd-threaded.mjs',
  },
  {
    name: 'onnxruntime-web',
    from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
    to: 'chrome/player/modules/vad/ort-wasm-simd-threaded.wasm',
  },
  {
    // mp4box 2.x is TypeScript that rolldown bundles into an ES module entry
    // point importing two shared chunks. The browser resolves those imports
    // itself, so the three files are copied as published, side by side, and
    // nothing is bundled here. FastStream's changes are all in the chunk -
    // patches/mp4box@2.4.1.patch, see docs/vendored-libraries.md.
    //
    // The chunk names carry a content hash and change with every release:
    // checkMp4boxImports fails the sync if the entry point imports anything
    // but the chunks listed here.
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
    // mp4-muxer's successor, by the same author; mp4-muxer is deprecated and
    // its last release (5.2.2) crashed where 4.3.3 did not (#25). The ES module
    // bundle as published, with its MPL-2.0 header. Its four blob: Workers
    // serve camera capture and alpha-channel video, which the remuxer never
    // reaches.
    name: 'mediabunny',
    from: 'node_modules/mediabunny/dist/bundles/mediabunny.mjs',
    to: 'chrome/player/modules/remux/mediabunny.mjs',
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
    patched: true,
    transform: toGifModule,
  },
  {
    // Pinned as a git dependency because mdbassit/Coloris is not on npm - the
    // package literally named `coloris` is an unrelated project, and
    // @melloware/coloris is a different fork. pnpm records the commit and a
    // tarball integrity hash in the lockfile, which is the same thing a
    // registry version gives a reviewer.
    name: 'Coloris',
    from: 'node_modules/Coloris/dist/coloris.js',
    to: 'chrome/player/modules/coloris.mjs',
    patched: true,
    transform: toColorisModule,
  },
  {
    // The picker's stylesheet, from the same commit as the script above, unminified so a
    // reviewer can read it. Until 2026-10-03 the copy here was upstream FastStream's
    // re-minified 0.21.x stylesheet (2023), which nothing regenerated; rule by rule it
    // matched 0.25.0's but for the slider inputs' selector (input -> input[type=range]).
    name: 'Coloris',
    from: 'node_modules/Coloris/dist/coloris.css',
    to: 'chrome/player/assets/coloris/css/coloris.css',
    transform: normaliseText,
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
 * matching rather than by a line range, so it survives reformatting. The
 * releases since 11.26 no longer have it, so today nothing is removed. What is
 * left is then checked for what the block does (LOCALE_BLOCK_SIGNS): a block
 * reworded past the marker fails the sync instead of shipping unnoticed.
 *
 * @param {string} text sweetalert2 source
 * @return {string} the same source with the block removed
 */
function stripLocaleMessageBlock(text) {
  const stripped = removeLocaleMessageBlock(text);
  const sign = LOCALE_BLOCK_SIGNS.find((pattern) => pattern.test(stripped));
  if (sign) {
    throw new Error(
        `sweetalert2 still contains ${sign} after the locale-message block was removed - ` +
        'a reworded block, or new code to read before shipping. Re-check this transform.',
    );
  }
  return stripped;
}

/**
 * What the locale-message block does, however it is worded: it blocks the page's
 * pointer events and plays remote audio from a .ru host.
 */
const LOCALE_BLOCK_SIGNS = [
  /\.pointerEvents\s*=\s*['"]none['"]/,
  /createElement\(\s*['"]audio['"]\s*\)/,
  /new Audio\(/,
  /flag-gimn|xn--p1ai/,
];

/**
 * @param {string} text sweetalert2 source
 * @return {string} the source without the block that starts at its host test, if any
 */
function removeLocaleMessageBlock(text) {
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
 * sweetalert2's stylesheet with FastStream's changes.
 *
 * The dialogs render inside the player's container, not the page's <body> (see
 * toSweetAlertModule), and sweetalert2 marks that container with the classes it puts on
 * <body>: its `body.swal2-*` rules match only with the `body` left out. The one that sets
 * the body's height to auto is dropped, since on the container it would collapse the
 * player. The rest is tools/sweetalert-overrides.css, appended.
 *
 * @param {string} src sweetalert2.css
 * @return {string} the stylesheet the player loads
 */
function toSweetAlertCss(src) {
  const heightAuto = /^body\.swal2-height-auto \{\n {2}height: auto !important;\n\}\n/m;
  const text = normaliseText(src);
  if (!heightAuto.test(text)) {
    throw new Error('sweetalert2.css: the body.swal2-height-auto rule is not where it was; check the transform');
  }
  const scoped = text.replace(heightAuto, '').replaceAll('body.swal2-', '.swal2-');
  if (/\bbody\b/.test(scoped)) {
    throw new Error('sweetalert2.css: a rule still names body; check the transform');
  }
  const overrides = fs.readFileSync(path.join(root, 'tools/sweetalert-overrides.css'), 'utf8');
  return scoped + '\n' + normaliseText(overrides);
}

/**
 * Converts sweetalert2's UMD build to an ES module and retargets it at
 * FastStream's player container.
 *
 * Five changes, all of which the vendored copy also made:
 *
 * 1. The UMD dispatcher is replaced with a plain `swl = factory()`, since
 *    neither CommonJS nor AMD exists here and the global assignment is not
 *    wanted.
 * 2. Every `document.body` becomes `document_body`, bound to
 *    `DOMElements.playerContainer`. This is the main behavioural change:
 *    dialogs must render inside FastStream's player container, not the host
 *    page's body - the player is often in a fullscreen or shadow context
 *    where document.body is the wrong parent. There are exactly 32
 *    occurrences, matching the 32 in the vendored copy, and none left over.
 * 3. `document_body` is declared `let`, not `const`, and `getContainer()`
 *    (the first thing every dialog touches, via init -> resetOldContainer)
 *    re-resolves it from `DOMElements.playerContainer` if it's still falsy.
 *    `DOMElements.playerContainer` is itself a one-time
 *    `document.querySelector('.mainplayer')` snapshot taken when
 *    DOMElements.mjs first evaluates; if this module happens to import
 *    before that element exists, `document_body` is null forever without
 *    this self-heal (confirmed empirically: a direct top-level navigation
 *    to player/index.html throws "document_body is null" out of
 *    getContainer() without it).
 * 4. `getTarget()` - the function that turns the `target` option into the
 *    actual element the popup container gets appended to - special-cases
 *    the literal string `'body'` to resolve to `document_body` instead of
 *    `document.querySelector('body')`. Without this, the container is
 *    appended under the real `<body>` while every other lookup
 *    (getContainer, focus, classList, event listeners) scopes to
 *    `document_body` (`.mainplayer`, a descendant of but not equal to
 *    `<body>`), so the container is never found again after creation - the
 *    popup never becomes visible while its container sits on top of
 *    everything, eating clicks (confirmed empirically via the embedded
 *    player's real save-prompt flow: a full-size `.swal2-container` with
 *    `display: grid` and `pointer-events: auto`, containing a
 *    `.swal2-popup` stuck at `display: none`). `'body'` is the value that
 *    matters here because sweetalert2's own DEFAULT_PARAMS sets
 *    `target: 'body'` and validateCustomTargetElement() only overwrites an
 *    *invalid* target - since `document.querySelector('body')` always
 *    succeeds, that default reaches getTarget() completely unchanged on
 *    every call. (init()'s own `getTarget(params.target || 'body')` call
 *    site is therefore never reached with a falsy target in practice -
 *    patching it alone, as an earlier version of this transform did, is a
 *    no-op.) None of FastStream's own `SweetAlert.fire()` call sites
 *    (utils/AlertPolyfill.mjs) ever pass a custom `target`, so this is what
 *    every dialog actually uses.
 * 5. The trailing global assignment becomes the ES export that
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

  const getContainerDecl =
    'const getContainer = () => document_body.querySelector(`.${swalClasses.container}`);';
  const getContainerFix =
    'const getContainer = () => {\n' +
    '    if (!document_body) {\n' +
    '      document_body = DOMElements.playerContainer || document.body;\n' +
    '    }\n' +
    '    return document_body.querySelector(`.${swalClasses.container}`);\n' +
    '  };';

  const getTargetDecl =
    'const getTarget = target => {\n' +
    '    if (typeof target === \'string\') {\n' +
    '      const element = document.querySelector(target);\n' +
    '      if (!element) {\n' +
    '        throw new Error(`Target element "${target}" not found`);\n' +
    '      }\n' +
    '      return /** @type {HTMLElement} */element;\n' +
    '    }\n' +
    '    return target;\n' +
    '  };';
  const getTargetFix =
    'const getTarget = target => {\n' +
    '    if (target === \'body\') {\n' +
    '      return document_body;\n' +
    '    }\n' +
    '    if (typeof target === \'string\') {\n' +
    '      const element = document.querySelector(target);\n' +
    '      if (!element) {\n' +
    '        throw new Error(`Target element "${target}" not found`);\n' +
    '      }\n' +
    '      return /** @type {HTMLElement} */element;\n' +
    '    }\n' +
    '    return target;\n' +
    '  };';

  let body = text
      .replace(umdHead, '(function (global, factory) {\n  swl = factory();\n})(this, ')
      .replace(/document\.body/g, 'document_body')
      .replace(globalTail, '\n');

  if (!body.includes(getContainerDecl)) {
    throw new Error(
        'sweetalert2 getContainer() not in the expected shape - re-check ' +
        'this transform against the new release.',
    );
  }
  body = body.replace(getContainerDecl, getContainerFix);

  if (!body.includes(getTargetDecl)) {
    throw new Error(
        'sweetalert2 getTarget() not in the expected shape - re-check this ' +
        'transform against the new release.',
    );
  }
  body = body.replace(getTargetDecl, getTargetFix);

  return 'import {DOMElements} from \'../ui/DOMElements.mjs\';\n\n' +
    'let document_body = DOMElements.playerContainer;\n' +
    'let swl;\n' +
    body +
    '\nexport const SweetAlert = swl;\n';
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
/**
 * Checks that mp4box's entry point, and the chunks it imports, import nothing
 * but the chunks in MP4BOX_CHUNKS.
 *
 * The chunk names are content hashes, so every mp4box release renames them.
 * Renamed chunks already fail the sync as MISSING; a release that adds one
 * would copy without complaint and fail in the browser instead, on an import
 * of a file that was never vendored. This makes that fail here too.
 *
 * @param {string} src the published dist/mp4box.all.mjs
 * @return {string} the same file, unchanged
 */
function checkMp4boxImports(src) {
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
 * Turns Coloris's dist bundle into an ES module scoped to a container.
 *
 * Upstream wraps everything in `(function (window, document, Math) { ... })`
 * and assigns the result to `window.Coloris`. Removing the wrapper puts the
 * same declarations at module scope, which is what the vendored copy did and
 * what lets `bindElement` be exported alongside `Coloris`.
 *
 * The behavioural changes - the container rebinding, `bindElement`, and the
 * slider keyboard handlers - are not here. They are in
 * patches/Coloris@0.25.0.patch, so a reviewer reads them as a diff against a
 * commit the lockfile pins by hash.
 *
 * @param {string} src Coloris's dist/coloris.js
 * @return {string} the same code as an ES module
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
 * Writes every VENDOR entry's output; exits 1 if a source is missing.
 */
function main() {
  let failed = false;

  for (const lib of VENDOR) {
    // `from` may be a list, for a vendored file made by concatenating several published
    // sources rather than copying one. The order is load-bearing, so it is recorded in the
    // entry rather than inferred here.
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
    // Bytes may be large; a string read of them would mangle binary content. Read the
    // existing copy without a preceding existsSync: gone-in-between means "updated"
    // either way, which a failed read then reports (CodeQL js/file-system-race).
    const unchanged = (() => {
      try {
        return Buffer.compare(fs.readFileSync(dst), data) === 0;
      } catch (e) {
        if (e.code === 'ENOENT') return false;
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

export {stripLocaleMessageBlock};

// Run as a script (pnpm run build, vendor:sync, tools/rebuild.mjs), not when a test imports it.
if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  main();
}
