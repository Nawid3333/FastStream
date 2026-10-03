import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {splice, spliceAndCopy} from '../../tools/splicer.mjs';

// build.mjs's SPLICER preprocessor (tools/splicer.mjs). A directive it misreads changes what
// ships with no error: a misspelt one used to be kept as an ordinary line, and the text of
// one anywhere in a line (a string, a template literal) was obeyed (#168).

const root = path.resolve(import.meta.dirname, '..', '..');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('splice: the directives', () => {
  it('drops a line, a block and a file for its own target', () => {
    const text = [
      'import {a} from \'./a.mjs\'; // SPLICER:WEB:REMOVE_LINE',
      'keep1();',
      '  // SPLICER:WEB:REMOVE_START',
      'gone();',
      '  // SPLICER:WEB:REMOVE_END',
      'keep2();',
    ].join('\n');
    expect(splice(text, 'WEB', 'x.mjs')).toBe('keep1();\nkeep2();');
    expect(splice('// SPLICER:WEB:REMOVE_FILE\ncode();', 'WEB', 'x.mjs')).toBe('');
  });

  it('leaves another target\'s directives alone', () => {
    const text = 'a(); // SPLICER:EXTENSION:REMOVE_LINE\nb();';
    expect(splice(text, 'WEB', 'x.mjs')).toBe(text);
  });

  it('refuses a misspelt command instead of shipping the line', () => {
    expect(() => splice('a();\nb(); // SPLICER:WEB:REMOVE_LIN\n', 'WEB', 'x.mjs')).toThrow(/x\.mjs:2.*REMOVE_LIN/);
    expect(() => splice('// SPLICER:NO_UPDATE_CHECKER:REMOVE_FIEL\n', 'NO_UPDATE_CHECKER', 'x.mjs')).toThrow(/REMOVE_FIEL/);
  });

  it('refuses a misspelt command whichever target is being built', () => {
    // Every target's build reads every directive, so a typo fails each build, not only its own.
    expect(() => splice('b(); // SPLICER:EXTENSION:REMOVE_LIN\n', 'WEB', 'x.mjs')).toThrow(/REMOVE_LIN/);
  });

  it('refuses a misspelt target, which no build would ever act on', () => {
    expect(() => splice('b(); // SPLICER:EXTENSON:REMOVE_LINE\n', 'EXTENSION', 'x.mjs')).toThrow(/EXTENSON/);
  });

  it('refuses a target no directive list knows', () => {
    expect(() => splice('a();', 'CHROME', 'x.mjs')).toThrow(/CHROME/);
  });

  it('obeys a directive only in a // comment, not its text in code or a string', () => {
    const template = 'const help = `\nSPLICER:WEB:REMOVE_FILE\n`;\nrun(help);';
    expect(splice(template, 'WEB', 'x.mjs')).toBe(template);
    const blockComment = '/* SPLICER:WEB:REMOVE_LINE */\nrun();';
    expect(splice(blockComment, 'WEB', 'x.mjs')).toBe(blockComment);
  });

  it('still throws on an unmatched block', () => {
    expect(() => splice('// SPLICER:WEB:REMOVE_START\na();', 'WEB', 'x.mjs')).toThrow(/Unmatched/);
    expect(() => splice('a();\n// SPLICER:WEB:REMOVE_END', 'WEB', 'x.mjs')).toThrow(/Unmatched/);
  });

  it('accepts every directive in the tree, for every target', () => {
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.m?js$/.test(e.name)) files.push(full);
      }
    };
    walk(path.join(root, 'chrome'));
    const withDirectives = files.filter((f) => fs.readFileSync(f, 'utf8').includes('SPLICER:'));
    expect(withDirectives.length).toBeGreaterThanOrEqual(6);
    for (const file of withDirectives) {
      const text = fs.readFileSync(file, 'utf8');
      for (const target of ['EXTENSION', 'FIREFOX', 'WEB', 'NO_UPDATE_CHECKER']) {
        expect(() => splice(text, target, path.relative(root, file)), `${file} ${target}`).not.toThrow();
      }
    }
  });
});

describe('spliceAndCopy', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'splicer-'));
  });
  afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

  const source = (files) => {
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmp, 'src', name)), {recursive: true});
      fs.writeFileSync(path.join(tmp, 'src', name), text);
    }
  };

  it('ships nothing for a removed file', () => {
    source({'gone.mjs': '// SPLICER:WEB:REMOVE_FILE\ncode();\n'});
    spliceAndCopy(path.join(tmp, 'src'), path.join(tmp, 'out'), ['WEB']);
    expect(fs.existsSync(path.join(tmp, 'out', 'gone.mjs'))).toBe(false);
  });
});
