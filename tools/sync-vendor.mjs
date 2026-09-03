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
    name: 'mp4box',
    from: 'node_modules/mp4box/dist/mp4box.all.js',
    to: 'chrome/player/modules/mp4box.mjs',
    transform: toMp4BoxModule,
  },
];

/**
 * Exposes mp4box's two globals as ES module exports.
 *
 * mp4box 0.5.3 ships a concatenated script that defines everything as plain
 * `var`s and, at the end, assigns to CommonJS `exports` if it exists.
 * players/mp4/MP4Player.mjs and modules/dash2mp4/mp4merger.mjs both import
 * `{MP4Box, DataStream}`, so those two bindings are exported and the trailing
 * CommonJS block - the only one that references MP4Box - is dropped. The
 * other `typeof exports` guards in the file are left alone; they are inert in
 * a browser module.
 *
 * Base version was established by diffing against every release: 0.5.3 is a
 * clear minimum at 238 lines against 617 for 0.5.2 and 711 for 0.5.4. The
 * previously vendored copy was built from a commit slightly *before* 0.5.3 -
 * it lacks the lhvC box parser and the fLaC sample entry that the release
 * has - so moving to 0.5.3 adds two box types rather than removing anything.
 *
 * @param {string} src mp4box's concatenated dist build
 * @return {string} the same script with ES exports
 */
function toMp4BoxModule(src) {
  const text = normaliseText(src);

  const edits = [
    ['var DataStream = function(arrayBuffer, byteOffset, endianness) {',
      'export const DataStream = function(arrayBuffer, byteOffset, endianness) {'],
    ['var MP4Box = {};', 'export const MP4Box = {};'],
    ['\nif (typeof exports !== \'undefined\') {\n\texports.createFile = MP4Box.createFile;\n}\n', '\n'],
  ];

  return edits.reduce((acc, [find, replace]) => {
    const count = acc.split(find).length - 1;
    if (count !== 1) {
      throw new Error(
          `mp4box transform expected exactly one occurrence of ` +
          `${JSON.stringify(find.slice(0, 50))}, found ${count}. The upstream ` +
          'build changed - re-check this transform.',
      );
    }
    return acc.replace(find, replace);
  }, text);
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
