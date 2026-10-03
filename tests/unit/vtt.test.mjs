import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';

import {installFakeDom, markup} from './fakeCueDom.mjs';

// The vendored vtt.js turns cue text into the DOM tree the player shows. Cue text comes
// from subtitle files pages offer and from OpenSubtitles, so this pins what a hostile
// cue can do there: not throw out of the render, not borrow the player's own classes,
// and not hold the page up with a tag the tag regex backtracks on.

installFakeDom();
const {WebVTT} = await import('../../chrome/player/modules/vtt.mjs');

const VTT_PATH = new URL('../../chrome/player/modules/vtt.mjs', import.meta.url);
// A backslash, without one in a string literal that a tool could rewrite.
const BACKSLASH = String.fromCharCode(92);

/**
 * Converts cue text the way the player does and writes the tree as markup.
 * @param {string} text - The cue text.
 * @return {string}
 */
function toMarkup(text) {
  return markup(WebVTT.convertCueToDOMTree(window, text));
}

/**
 * Parses a WebVTT file with the vendored parser.
 * @param {string} text - The file.
 * @return {Array<{text: string}>} The cues.
 */
function parseCues(text) {
  const cues = [];
  // eslint-disable-next-line new-cap
  const parser = new WebVTT.Parser(window, WebVTT.StringDecoder());
  parser.oncue = (cue) => cues.push(cue);
  parser.parse(text);
  parser.flush();
  return cues;
}

/**
 * Every element of a tree, the root first.
 * @param {Object} node - The root.
 * @return {Array<Object>}
 */
function elementsOf(node) {
  const children = node.childNodes.filter((child) => child.nodeType === 1);
  return [node, ...children.flatMap(elementsOf)];
}

describe('convertCueToDOMTree: tag names', () => {
  // TAG_NAME is a plain object, so TAG_NAME['constructor'] was Object and the parser
  // called createElement with "function Object() { [native code] }", which throws. In the
  // player that threw out of renderSubtitles on every time update while the cue lasted.
  const PROTOTYPE_NAMES = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty',
    '__defineGetter__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'];

  for (const name of PROTOTYPE_NAMES) {
    it(`skips a <${name}> tag as an unknown tag instead of throwing`, () => {
      expect(toMarkup(`call <${name}> now`)).toBe('<div>call  now</div>');
      expect(toMarkup(`call <${name} Bob>now</${name}>`)).toBe('<div>call now</div>');
      expect(toMarkup(`<${name}.red>x`)).toBe('<div>x</div>');
    });
  }

  it('still builds every tag WebVTT has', () => {
    expect(toMarkup('<v Bob>hi</v>')).toBe('<div><span title="Bob">hi</span></div>');
    expect(toMarkup('<i>a</i><b>b</b><u>c</u>')).toBe('<div><i>a</i><b>b</b><u>c</u></div>');
    expect(toMarkup('<ruby>a<rt>b</rt></ruby>')).toBe('<div><ruby>a<rt>b</rt></ruby></div>');
    expect(toMarkup('<lang en>x</lang>')).toBe('<div><span lang="en">x</span></div>');
    expect(toMarkup('a <00:00:01.000>b')).toBe('<div>a <?timestamp 1?>b</div>');
  });
});

describe('convertCueToDOMTree: class names', () => {
  /**
   * The class names the player's stylesheets have rules for.
   * @return {string[]}
   */
  function playerClassNames() {
    const names = new Set();
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(file);
        } else if (entry.name.endsWith('.css')) {
          const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
          for (const m of css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
            names.add(m[1]);
          }
        }
      }
    };
    visit(fileURLToPath(new URL('../../chrome/player', import.meta.url)));
    return [...names];
  }

  it('gives a cue none of the player\'s classes, so <c.pseudo_fullscreen> cannot cover the controls', () => {
    // <c.fluid_video_wrapper.fluid_player_layout_default.pseudo_fullscreen> made the cue's
    // span a fixed, full-size element at z-index 99999 over every control.
    const names = playerClassNames();
    expect(names).toContain('pseudo_fullscreen');
    expect(names).toContain('subtitle-track');
    const tree = WebVTT.convertCueToDOMTree(window, `<c.${names.join('.')}>covered</c>`);
    const span = tree.childNodes[0];
    expect(span.localName).toBe('span');
    expect(span.textContent).toBe('covered');
    const classes = span.className.split(/\s+/).filter(Boolean);
    expect(classes.filter((name) => names.includes(name))).toEqual([]);
  });

  it('still colours a cue with the WebVTT colour classes', () => {
    expect(toMarkup('<c.yellow.bg_blue>col</c>'))
        .toBe('<div><span style="color:rgba(255,255,0,1);background-color:rgba(0,0,255,1)">col</span></div>');
  });
});

describe('convertCueToDOMTree: the tag regex', () => {
  // The regex dash.js's vtt.js ships. Its class and annotation groups overlap, so a tag
  // that fails to match at its end is retried for every split of the two: quadratic.
  const UPSTREAM_TAG = /^<([^.\s/0-9>]+)(\.[^\s\\>]+)?([^>\\]+)?(\\?)>?$/;

  /**
   * The tag regex vtt.mjs uses, read from its source.
   * @return {RegExp}
   */
  function shippedTagRegex() {
    const source = fs.readFileSync(VTT_PATH, 'utf8');
    const literal = source.match(/var m = t\.match\(\/(\^.*\$)\/\);/);
    expect(literal).not.toBeNull();
    return new RegExp(literal[1]);
  }

  it('reads a long tag that never closes in linear time', () => {
    // n = 20000 took about 1.5 s with the upstream regex (4x per doubling); a page that
    // auto-loads such a file froze the player the moment the cue showed.
    const n = 20000;
    const tag = '<a.' + 'b'.repeat(n) + ' ' + 'c'.repeat(n) + BACKSLASH + 'x>';
    const started = performance.now();
    const tree = WebVTT.convertCueToDOMTree(window, tag + 'after');
    const elapsed = performance.now() - started;
    expect(tree.textContent).toBe('after');
    expect(elapsed).toBeLessThan(250);
  });

  it('accepts and captures exactly what the upstream regex does', () => {
    const shipped = shippedTagRegex();
    const alphabet = ['<', '>', '.', ' ', '\t', '/', '0', '7', 'a', 'b', 'c', 'v', BACKSLASH, ':'];
    const tag = fc.array(fc.constantFrom(...alphabet), {maxLength: 14}).map((chars) => '<' + chars.join(''));
    fc.assert(fc.property(tag, (t) => {
      expect(shipped.exec(t)).toEqual(UPSTREAM_TAG.exec(t));
    }), {numRuns: 5000});
    for (const t of ['<v Bob>', '<v.loud Bob Smith>', '<c.a.b.c>', '<v2 Bob>', '<b/>', '<i >', '<.a>',
      '<a\\b>', '<a\\b c>', '<a.b\\>', '<a.b c\\>', '<a. b>', '<a.>', '<lang en-GB>', '<c', '<c.x']) {
      expect(shipped.exec(t)).toEqual(UPSTREAM_TAG.exec(t));
    }
  });
});

describe('Parser: cue text', () => {
  it('keeps the letters "u2029" in cue text and breaks the line at U+2029', () => {
    // The upstream code replaced /u2029/g, the five characters, not the separator.
    const separator = String.fromCharCode(0x2029);
    const cues = parseCues('WEBVTT\n\n00:00.000 --> 00:01.000\nFlight u2029 leaves\n\n' +
      '00:01.000 --> 00:02.000\nLine one' + separator + 'line two\n');
    expect(cues.map((cue) => cue.text)).toEqual(['Flight u2029 leaves', 'Line one\nline two']);
  });
});

describe('convertCueToDOMTree: arbitrary cue text', () => {
  it('never throws, and builds only WebVTT\'s elements with no class names', () => {
    const pieces = ['<', '>', '</', '.', ' ', '/', 'c', 'v', 'b', 'i', 'ruby', 'rt', 'lang', 'constructor',
      '__proto__', 'toString', 'pseudo_fullscreen', 'red', 'bg_', '&amp;', '0', ':', BACKSLASH, 'text'];
    const text = fc.oneof(
        fc.string({unit: 'binary'}),
        fc.array(fc.constantFrom(...pieces), {maxLength: 24}).map((parts) => parts.join('')),
    );
    const allowed = new Set(['div', 'span', 'i', 'b', 'u', 'ruby', 'rt']);
    fc.assert(fc.property(text, (t) => {
      const tree = WebVTT.convertCueToDOMTree(window, t);
      if (!t) {
        expect(tree).toBeNull();
        return;
      }
      for (const element of elementsOf(tree)) {
        expect(allowed.has(element.localName)).toBe(true);
        expect(element.className).toBe('');
      }
    }), {numRuns: 1000});
  });
});
