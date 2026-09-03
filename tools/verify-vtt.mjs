#!/usr/bin/env node
// Proves where chrome/player/modules/vtt.mjs came from.
//
// vtt.mjs is the one vendored bundle that cannot be generated during the
// build. videojs/vtt.js publishes only `lib/*` to npm - never the browserify
// bundle - and the bundle FastStream ships is the one dash.js maintains at
// contrib/videojs-vtt.js/vtt.js, which dash.js does not include in its npm
// package either (it ships only the minified vtt.min.js).
//
// So instead of generating the file, this verifies it: fetch the upstream
// bundle, apply the three changes FastStream makes, and assert the result
// parses to the same program as the file in the tree. That turns "trust this
// vendored blob" into a claim anyone can re-run, which is the thing AMO's
// review of vendored code is actually asking for.
//
// Run with: pnpm run verify:vtt   (needs network)

import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {compare} from './ast-compare.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');
const vendored = path.join(root, 'chrome/player/modules/vtt.mjs');

// Pinned by tag rather than branch so this cannot start failing because
// upstream moved. The file is byte-identical across dash.js v4.7.4 through
// v5.1.0, so the tag choice is not load-bearing - it is pinned for
// determinism, not because only this tag matches.
const UPSTREAM =
  'https://raw.githubusercontent.com/Dash-Industry-Forum/dash.js/v5.1.0/' +
  'contrib/videojs-vtt.js/vtt.js';

/**
 * The differences between dash.js's bundle and the file FastStream ships.
 *
 * Two of the three are *removals* of dash.js's own additions, which is the
 * useful detail: FastStream's copy is closer to videojs/vtt.js than dash.js's
 * is. The third is a real product change - subtitles are rendered at a fifth
 * of the default size relative to the container.
 */
const CHANGES = [
  {
    what: 'subtitle font size: 25% of container height -> 5%',
    from: 'var FONT_SIZE_PERCENT = 0.25;',
    to: 'var FONT_SIZE_PERCENT = 0.05;',
  },
  {
    what: 'drop dash.js\'s parentId parameter',
    from: 'var processCues = function(window, cues, overlay, parentId) {',
    to: 'var processCues = function(window, cues, overlay) {',
  },
  {
    what: 'drop dash.js\'s parentId assignment',
    from: '  if(parentId) {\n    paddedOverlay.id = parentId;\n  }\n',
    to: '',
  },
];

// Appended so the bundle, which assigns to a global, can be imported.
const EXPORT_LINE = '\nexport const WebVTT = window.WebVTT;\n';

const res = await fetch(UPSTREAM);
if (!res.ok) {
  console.error(`could not fetch ${UPSTREAM}: ${res.status}`);
  process.exit(1);
}
let upstream = await res.text();

for (const c of CHANGES) {
  if (!upstream.includes(c.from)) {
    console.error(
        `upstream no longer contains the text this change edits:\n` +
        `  ${c.what}\n  looked for: ${JSON.stringify(c.from.slice(0, 60))}\n` +
        `The vendored file and upstream have diverged - re-derive the ` +
        `provenance before trusting docs/vendored-libraries.md.`,
    );
    process.exit(1);
  }
  upstream = upstream.replace(c.from, c.to);
  console.log(`  applied: ${c.what}`);
}
upstream += EXPORT_LINE;

const result = compare(fs.readFileSync(vendored, 'utf8'), upstream);
if (result.equal) {
  console.log(
      '\nvtt.mjs is dash.js contrib/videojs-vtt.js/vtt.js (v5.1.0) plus the ' +
      'changes above.\nVerified: the two parse to the same program.',
  );
} else {
  console.error(
      `\nvtt.mjs does NOT match. First difference at character ${result.at} ` +
      `of the normalised AST:\n  vendored: ...${result.aCtx}\n` +
      `  upstream: ...${result.bCtx}`,
  );
  process.exit(1);
}
