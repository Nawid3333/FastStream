import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  applyHunks, checkJavaScript, mergeWebpack, parseDiff, renamedCounterpart, spliceOnto, splitWebpack,
} from '../../tools/recut-patch.mjs';

// tools/recut-patch.mjs moves a library's pnpm patch onto a new release. Each piece below
// is one way that could go quietly wrong and ship: a patch applied differently from how
// pnpm applies it, a module taken from the wrong side, stray CRs turned into patch noise,
// or a clean merge that leaves a name undefined - which is what happened twice on the
// dash.js 5.2.1 upgrade.

const hunksOf = (diff) => parseDiff(diff)[0].hunks;

describe('applyHunks', () => {
  it('applies a pnpm patch that drops the last line of a file without a final newline, as pnpm does', () => {
    // pnpm writes no "\ No newline at end of file" marker here, and git apply refuses it.
    const patch = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,2 @@\n a\n-b\n-//# sourceMappingURL=x.map\n+c\n';
    expect(applyHunks('a\nb\n//# sourceMappingURL=x.map', hunksOf(patch), 'f')).toBe('a\nc');
  });

  it('follows the end-of-file markers when there are some', () => {
    const drop = 'diff --git a/f b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file\n';
    expect(applyHunks('a\nb\n', hunksOf(drop), 'f')).toBe('a\nc');
    const add = 'diff --git a/f b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n';
    expect(applyHunks('a\nb', hunksOf(add), 'f')).toBe('a\nc\n');
  });

  it('matches context lines that carry a stray CR, and finds a hunk that moved', () => {
    const patch = 'diff --git a/f b/f\n@@ -5,2 +5,2 @@\n x\n-y\n+Y\n';
    expect(applyHunks('0\n1\nx\r\ny\nz\n', hunksOf(patch), 'f')).toBe('0\n1\nx\r\nY\nz\n');
  });

  it('refuses a hunk whose lines are not in the file', () => {
    const patch = 'diff --git a/f b/f\n@@ -1,1 +1,1 @@\n-nothere\n+x\n';
    expect(() => applyHunks('a\nb\n', hunksOf(patch), 'f')).toThrow(/does not apply/);
  });
});

/**
 * A minimal webpack debug bundle: the runtime head, one entry per module keyed by its
 * source path, and the runtime tail.
 */
function bundle(modules) {
  return '/******/ var __webpack_modules__ = ({\n\n' +
    Object.entries(modules).map(([p, body]) => `/***/ "${p}":\n/***/ (function() {\n${body}\n/***/ }),\n`).join('\n') +
    '\n/******/ \t});\nexport {};\n';
}

describe('mergeWebpack', () => {
  const merge = (b, o, t) => mergeWebpack(splitWebpack(bundle(b)), splitWebpack(bundle(o)), splitWebpack(bundle(t)), 'test');

  it('takes each module from the side that changed it', () => {
    const m = merge(
        {'./a.js': 'a = 1;', './b.js': 'b = 1;', './c.js': 'c = 1;'},
        {'./a.js': 'a = "FastStream";', './b.js': 'b = 1;', './c.js': 'c = 1;'},
        {'./a.js': 'a = 1;', './b.js': 'b = "upstream";', './c.js': 'c = 1;'});
    expect(m.conflicts).toBe(0);
    expect(m.text).toContain('a = "FastStream";');
    expect(m.text).toContain('b = "upstream";');
    expect(m.report).toMatchObject({ours: 1, theirs: 2});
  });

  it('merges a module both sides changed, and names it when they collide', () => {
    // Two modules at least: splitWebpack takes nothing smaller for a bundle.
    const base = {'./m.js': 'one;\ntwo;\nthree;\nfour;\nfive;', './n.js': 'n;'};
    const clean = merge(base, {...base, './m.js': 'ONE;\ntwo;\nthree;\nfour;\nfive;'}, {...base, './m.js': 'one;\ntwo;\nthree;\nfour;\nFIVE;'});
    expect(clean.conflicts).toBe(0);
    expect(clean.text).toContain('ONE;\ntwo;\nthree;\nfour;\nFIVE;');
    const clash = merge(base, {...base, './m.js': 'ours;\ntwo;\nthree;\nfour;\nfive;'}, {...base, './m.js': 'theirs;\ntwo;\nthree;\nfour;\nfive;'});
    expect(clash.conflicts).toBe(1);
    expect(clash.report.conflicts[0]).toContain('./m.js');
  });

  it('keeps a module FastStream added, and stops on one it changed that upstream deleted', () => {
    const added = merge({'./a.js': 'a;', './z.js': 'z;'}, {'./a.js': 'a;', './z.js': 'z;', './mine.js': 'mine;'}, {'./a.js': 'a;', './z.js': 'z;'});
    expect(added.conflicts).toBe(0);
    expect(added.text).toContain('mine;');
    const gone = merge({'./a.js': 'a;', './b.js': 'b;', './z.js': 'z;'}, {'./a.js': 'a;', './b.js': 'b changed;', './z.js': 'z;'}, {'./a.js': 'a;', './z.js': 'z;'});
    expect(gone.conflicts).toBe(1);
    expect(gone.report.removedUpstream).toEqual(['./b.js']);
  });

  it('does not take a plain file for a bundle', () => {
    expect(splitWebpack('export const x = 1;\n')).toBe(null);
  });
});

describe('spliceOnto', () => {
  it('keeps the stray CRs of every line the merge did not change', () => {
    // dash.js ships 428 CRs inside a licence comment; a diff cannot carry them, so they
    // would otherwise show up in the patch as changes FastStream never made.
    expect(spliceOnto('keep\r\nold\nlast\r\n', 'keep\nnew\nlast\n')).toBe('keep\r\nnew\nlast\r\n');
    expect(spliceOnto('a\r\nb', 'a\nb')).toBe('a\r\nb');
  });
});

describe('renamedCounterpart', () => {
  it('finds a content-hashed chunk under its new name, and only when there is one candidate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'dist'));
      fs.writeFileSync(path.join(dir, 'dist/styp-AbC123xy.mjs'), '');
      fs.writeFileSync(path.join(dir, 'dist/styp-AbC123xy.mjs.map'), '');
      expect(renamedCounterpart('dist/styp-9TIZZDLN.mjs', dir).match).toBe('dist/styp-AbC123xy.mjs');
      fs.writeFileSync(path.join(dir, 'dist/styp-ZZZ99999.mjs'), '');
      expect(renamedCounterpart('dist/styp-9TIZZDLN.mjs', dir).match).toBe(undefined);
      expect(renamedCounterpart('dist/styp-9TIZZDLN.mjs', dir).candidates).toHaveLength(2);
      expect(renamedCounterpart('dist/plain.mjs', dir).candidates).toEqual([]);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});

describe('checkJavaScript', () => {
  // The old release had helper(); FastStream's patch added g(), which calls it; the new
  // release deleted helper() - and the merge, clean, keeps g().
  const oldBase = 'function helper() {\n  return 1;\n}\nexport function f() {\n  return helper();\n}\n';
  const oldOurs = oldBase + 'export function g() {\n  return helper() + 1;\n}\n';
  const stock = 'export function f() {\n  return 1;\n}\n';
  const merged = stock + 'export function g() {\n  return helper() + 1;\n}\n';

  it('reports a name the merge left undefined', async () => {
    const problems = await checkJavaScript(merged, stock, 'm.mjs', oldBase, oldOurs);
    expect(problems).toEqual(['m.mjs: no-undef: \'helper\' is not defined.']);
  });

  it('accepts what the current patch already did, but not more of it', async () => {
    // Like dash.js's _getL3DBootstrapTracks: the patch removed the only caller of an
    // upstream function on purpose, and that was reviewed when the patch was cut.
    const unusedBase = 'export function f() {\n  function helper() {\n    return 1;\n  }\n  return helper();\n}\n';
    const unusedOurs = 'export function f() {\n  function helper() {\n    return 1;\n  }\n  return 2;\n}\n';
    expect(await checkJavaScript(unusedOurs, unusedBase, 'u.mjs', unusedBase, unusedOurs)).toEqual([]);
    const twoUnused = 'export function f() {\n  function helper() {\n    return 1;\n  }\n  function other() {\n    return 3;\n  }\n  return 2;\n}\n';
    expect(await checkJavaScript(twoUnused, unusedBase, 'u.mjs', unusedBase, unusedOurs))
        .toEqual(['u.mjs: no-unused-vars: \'other\' is defined but never used.']);
  });

  it('reports a merge that does not parse', async () => {
    const problems = await checkJavaScript('export function f( {\n', stock, 'p.mjs', stock, stock);
    expect(problems[0]).toMatch(/^p\.mjs: does not parse/);
  });
});
