// @ts-check
// Proves where chrome/player/modules/vtt.mjs came from.
// vtt.mjs cannot be generated: the bundle is dash.js's contrib/videojs-vtt.js/vtt.js,
// which neither dash.js nor videojs/vtt.js publishes to npm.
// So this verifies it: the upstream bundle plus the changes below must parse to the file's program.
// Run with: pnpm run verify:vtt   (needs network)

import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {compare} from './ast-compare.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');
const vendored = path.join(root, 'chrome/player/modules/vtt.mjs');

// Pinned by tag for determinism; the file is the same from dash.js v4.7.4 to v5.2.1.
const UPSTREAM =
  'https://raw.githubusercontent.com/Dash-Industry-Forum/dash.js/v5.2.1/' +
  'contrib/videojs-vtt.js/vtt.js';

/**
 * The differences between dash.js's bundle and the file FastStream ships.
 * A change to vtt.mjs goes here in the same commit, or this check fails.
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
  {
    what: 'closing-tag token: replace every ">", not the first (CodeQL alert #8)',
    from: 'tagStack[tagStack.length - 1] === t.substr(2).replace(">", "")',
    to: 'tagStack[tagStack.length - 1] === t.substr(2).replace(/>/g, "")',
  },
  {
    what: 'cue text: U+2029 becomes a line break, not the five letters "u2029" (#295)',
    from: String.raw`.replace(/u2029/g, '\n');`,
    to: String.raw`.replace(/\u2029/g, '\n');`,
  },
  {
    what: 'cue tags: only TAG_NAME\'s own names; <constructor> found Object, which threw (#291)',
    from: 'var tagName = TAG_NAME[type];',
    to: 'var tagName = Object.prototype.hasOwnProperty.call(TAG_NAME, type) ? TAG_NAME[type] : null;',
  },
  {
    what: 'cue tags: a lookahead that accepts the same tags in linear time, not quadratic (#294)',
    from: String.raw`var m = t.match(/^<(`,
    to: String.raw`var m = t.match(/^(?=<[^.\s/0-9>]+(?:[.\s/0-9][^>\\]*)?\\?>?$)<(`,
  },
  {
    what: 'cue classes: not set on the element, where the player\'s own CSS matched them (#292)',
    from: 'node.className = classes.join(\' \');',
    to: '',
  },
  {
    what: 'cue text: character references decoded by DOMParser, not an innerHTML write (addons-linter), ' +
      'all of a cue\'s texts in one parse, not one each (2026-11-17)',
    from: '  function unescape(s) {\n    TEXTAREA_ELEMENT.innerHTML = s;\n    s = TEXTAREA_ELEMENT.textContent;\n' +
      '    TEXTAREA_ELEMENT.textContent = "";\n    return s;\n  }',
    to: String.raw`function unescapeAll(nodes) {
      if (!nodes.length) { return; }
      var html = nodes.map(function (node) {
        return "<textarea>\n" + node.data.replace(/\0/g, "").replace(/</g, "&lt;") + "</textarea>";
      }).join("");
      var areas = new DOMParser().parseFromString(html, "text/html").querySelectorAll("textarea");
      for (var i = 0; i < nodes.length; i++) { nodes[i].data = areas[i].textContent; }
    }`,
  },
  {
    what: 'cue text: the texts to decode collected (2026-11-17)',
    from: '      t,\n      tagStack = [];',
    to: '      t,\n      tagStack = [],\n      toDecode = [];',
  },
  {
    what: 'cue text: a text node made of the text as it is, decoded with the others at the end (2026-11-17)',
    from: '    current.appendChild(window.document.createTextNode(unescape(t)));\n  }\n\n  return rootDiv;',
    to: String.raw`    var text = window.document.createTextNode(t);
    if (/[&\r\0]/.test(t)) { toDecode.push(text); }
    current.appendChild(text);
  }

  unescapeAll(toDecode);
  return rootDiv;`,
  },
  {
    what: 'the textarea the innerHTML write used, unused since (2026-11-17)',
    from: 'var TEXTAREA_ELEMENT = document.createElement && document.createElement("textarea");\n',
    to: '',
  },
  {
    what: 'cue region: found in a Map, not by a scan of every region (2026-11-17)',
    from: '        for (var i = regionList.length - 1; i >= 0; i--) {\n          if (regionList[i].id === v) {\n' +
      '            settings.set(k, regionList[i].region);\n            break;\n          }\n        }',
    to: '        if (regionList.has(v)) { settings.set(k, regionList.get(v)); }',
  },
  {
    what: 'regions kept in a Map by id, the last one of an id kept, as the scan found it (2026-11-17)',
    from: '      self.regionList.push({\n        id: settings.get("id"),\n        region: region\n      });',
    to: '      self.regionList.set(settings.get("id"), region);',
  },
  {
    what: 'the regions\' Map (2026-11-17)',
    from: '  this.regionList = [];',
    to: '  this.regionList = new Map();',
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
      '\nvtt.mjs is dash.js contrib/videojs-vtt.js/vtt.js (v5.2.1) plus the ' +
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
