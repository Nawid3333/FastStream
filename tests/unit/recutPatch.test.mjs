import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {
  applyHunks, applyHunksByContext, bumpPackageJson, checkJavaScript, dropDependabotIgnores, mergeText,
  mergeWebpack, parseDiff, renamedCounterpart, renameHashedChunks, spliceOnto, splitWebpack,
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

describe('applyHunksByContext', () => {
  // hls.js 1.7.4 moved whole classes of its bundle: the three-way merge of 1.7.3's patch
  // marked 3 conflicts, and an issue asked for a hand update, while all four hunks fitted
  // the new release as they were. Here a small class moves below a big one.
  const big = Array.from({length: 10}, (_, i) => `  b${i};`);
  const small = ['class A {', '  a1;', '  a2;', '  a3;', '}'];
  const base = [...small, 'class B {', ...big, '}', 'export { A, B };', ''].join('\n');
  // FastStream's two changes; the first adds a line, so the second moves down by one.
  const patched = (text) => text.replace('  a2;', '  a2 = "FastStream";\n  a2b;').replace('export { A, B };', 'export { A, B, C };');
  const ours = patched(base);
  const theirs = ['class B {', ...big, '}', ...small, 'export { A, B };', ''].join('\n');
  const patch = 'diff --git a/f b/f\n' +
    '@@ -2,3 +2,4 @@ class A {\n   a1;\n-  a2;\n+  a2 = "FastStream";\n+  a2b;\n   a3;\n' +
    '@@ -17,2 +18,2 @@\n }\n-export { A, B };\n+export { A, B, C };\n';

  it('fits the hunks of a block the new release moved, where the three-way merge conflicts', () => {
    expect(applyHunks(base, hunksOf(patch), 'f')).toBe(ours);
    expect(mergeText(ours, base, theirs, 'f').conflicts).toBeGreaterThan(0);
    const fit = applyHunksByContext(theirs, hunksOf(patch));
    expect(fit.failed).toEqual([]);
    expect(fit.text).toBe(patched(theirs));
  });

  it('does not guess at a hunk whose lines are there twice or not at all', () => {
    const twice = theirs.replace('export', [...small, 'export'].join('\n'));
    const gone = theirs.replace('  a1;\n', '  a1 = 1;\n');
    for (const [text, why] of [[twice, /\("a1;"\) is there 2 times/], [gone, /\("a1;"\) is not there/]]) {
      const fit = applyHunksByContext(text, hunksOf(patch));
      expect(fit.text).toBeUndefined();
      expect(fit.failed).toEqual([expect.stringMatching(why)]);
    }
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

  it('keeps a module the patch deleted out, and stops when the new release changed it', () => {
    // In base and the new release, not in ours: the patch deleted it. The merge took the
    // new release's copy back, with a clean report: what the patch removed shipped again.
    const kept = merge({'./a.js': 'a;', './b.js': 'b;', './z.js': 'z;'}, {'./a.js': 'a;', './z.js': 'z;'}, {'./a.js': 'a;', './b.js': 'b;', './z.js': 'z;'});
    expect(kept.conflicts).toBe(0);
    expect(kept.text).not.toContain('./b.js');
    expect(kept.report.merged).toContain(`./b.js (FastStream's deletion, kept)`);
    const changed = merge({'./a.js': 'a;', './b.js': 'b;', './z.js': 'z;'}, {'./a.js': 'a;', './z.js': 'z;'}, {'./a.js': 'a;', './b.js': 'b upstream;', './z.js': 'z;'});
    expect(changed.conflicts).toBe(1);
    expect(changed.text).not.toContain('./b.js');
    expect(changed.report.conflicts[0]).toContain('./b.js');
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

describe('renameHashedChunks', () => {
  // The mp4box 2.5.0 recut: the patch renamed styp-9TIZZDLN, and the sync's
  // MP4BOX_CHUNKS still listed rolldown-runtime-w6R9maHv - whose name the release also
  // changed, from content the patch never touches. A stale name failed sync-vendor and
  // turned the update into a hand issue instead of its pull request.
  const dist = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-test-'));
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content ?? '');
    }
    return dir;
  };
  // What the sync file lists before --apply: the old release's names.
  const chunkLine = 'const MP4BOX_CHUNKS = [\'styp-9TIZZDLN.mjs\', \'rolldown-runtime-w6R9maHv.mjs\'];';

  it('renames the unpatched hashed chunk alongside the patch ones, and reports all renames', () => {
    const dir = dist({'mp4box.all.mjs': 'import \'./styp-AbC123xy.mjs\';\nimport \'./rolldown-runtime-Nw2xQ9st.mjs\';\n', 'styp-AbC123xy.mjs': '', 'rolldown-runtime-Nw2xQ9st.mjs': ''});
    try {
      const {text, renamed} = renameHashedChunks(chunkLine, dir, [{from: 'dist/styp-9TIZZDLN.mjs', to: 'dist/styp-AbC123xy.mjs'}]);
      expect(text).toBe('const MP4BOX_CHUNKS = [\'styp-AbC123xy.mjs\', \'rolldown-runtime-Nw2xQ9st.mjs\'];');
      expect(renamed).toEqual([
        {from: 'dist/styp-9TIZZDLN.mjs', to: 'dist/styp-AbC123xy.mjs'},
        {from: 'rolldown-runtime-w6R9maHv.mjs', to: 'rolldown-runtime-Nw2xQ9st.mjs'},
      ]);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('renames a hashed chunk with no patch rename recorded at all', () => {
    const dir = dist({'mp4box.all.mjs': 'import \'./styp-AbC123xy.mjs\';\nimport \'./rolldown-runtime-Nw2xQ9st.mjs\';\n', 'styp-AbC123xy.mjs': '', 'rolldown-runtime-Nw2xQ9st.mjs': ''});
    try {
      const {text, renamed} = renameHashedChunks('[\'styp-9TIZZDLN.mjs\', \'rolldown-runtime-w6R9maHv.mjs\']', dir, []);
      expect(text).toBe('[\'styp-AbC123xy.mjs\', \'rolldown-runtime-Nw2xQ9st.mjs\']');
      expect(renamed).toEqual([
        {from: 'styp-9TIZZDLN.mjs', to: 'styp-AbC123xy.mjs'},
        {from: 'rolldown-runtime-w6R9maHv.mjs', to: 'rolldown-runtime-Nw2xQ9st.mjs'},
      ]);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('keeps a name whose counterpart is ambiguous or already correct', () => {
    const dir = dist({'styp-AbC123xy.mjs': '', 'styp-ZZZ99999.mjs': '', 'styp-9TIZZDLN.mjs': ''});
    try {
      const {text, renamed} = renameHashedChunks('[\'styp-9TIZZDLN.mjs\']', dir, []);
      // Two candidates for a counterpart: no rename, the name stays and a look tells why.
      expect(text).toBe('[\'styp-9TIZZDLN.mjs\']');
      expect(renamed).toEqual([]);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('keeps a name that is already the current one in the release', () => {
    const dir = dist({'styp-9TIZZDLN.mjs': ''});
    try {
      const {text, renamed} = renameHashedChunks('[\'styp-9TIZZDLN.mjs\']', dir, []);
      expect(text).toBe('[\'styp-9TIZZDLN.mjs\']');
      expect(renamed).toEqual([]);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('leaves names without a hash counterpart in the release (a plain name, a .map)', () => {
    const dir = dist({'styp-AbC123xy.mjs': ''});
    try {
      const {text} = renameHashedChunks('[\'plain.mjs\', \'styp-AbC123xy.mjs.map\', \'styp-AbC123xy.mjs\']', dir, []);
      expect(text).toBe('[\'plain.mjs\', \'styp-AbC123xy.mjs.map\', \'styp-AbC123xy.mjs\']');
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

// The update pull request for a patched library moves it, and only it, to the new version.
describe('bumpPackageJson', () => {
  const pj = JSON.stringify({devDependencies: {'dashjs': '5.2.1', 'hls.js': '^1.7.3'}}, null, 2);

  it('moves the library alone, and keeps its range prefix', () => {
    const out = JSON.parse(bumpPackageJson(pj, 'hls.js', '1.7.3', '1.8.0'));
    expect(out.devDependencies['hls.js']).toBe('^1.8.0');
    expect(out.devDependencies['dashjs']).toBe('5.2.1');
  });

  it('refuses when the library is not at the version its patch is cut against', () => {
    expect(() => bumpPackageJson(pj, 'hls.js', '1.7.2', '1.8.0')).toThrow(/no "hls.js" at 1.7.2/);
  });
});

describe('dropDependabotIgnores', () => {
  it('takes exactly the named entries off the ignore list, and says which were there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dependabot-'));
    try {
      const file = path.join(dir, 'dependabot.yml');
      fs.writeFileSync(file, [
        '    ignore:',
        '      - dependency-name: \'dashjs\'',
        '      - dependency-name: \'gif.js\'',
        '      - dependency-name: \'hls.js\'',
        '  # - dependency-name: \'commented\'',
        '',
      ].join('\n'));
      expect(dropDependabotIgnores(['gif.js', 'dashjs', 'not-there'], file))
          .toEqual(['dashjs', 'gif.js']);
      expect(fs.readFileSync(file, 'utf8')).toBe([
        '    ignore:',
        '      - dependency-name: \'hls.js\'',
        '  # - dependency-name: \'commented\'',
        '',
      ].join('\n'));
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});

describe('recut-patch, run on a patch that changes nothing', () => {
  it('refuses it, instead of saying it merged cleanly and deleting it with --apply', () => {
    // An empty patch (truncated by accident) passed every check over no file (glm's review,
    // 2026-10-22). Refused before anything is downloaded.
    // In the repository: the tool takes a patch as a path from it, with / and no drive, and
    // the temp folder may be on another drive (Windows CI: D: and C:).
    const repo = path.join(import.meta.dirname, '..', '..');
    const dir = fs.mkdtempSync(path.join(repo, 'tests', '.recut-empty-'));
    try {
      const patch = path.join(dir, 'empty.patch');
      fs.writeFileSync(patch, '');
      const script = path.join(repo, 'tools', 'recut-patch.mjs');
      const relative = path.relative(repo, patch).split(path.sep).join('/');
      const run = spawnSync(process.execPath, [script, 'hls.js', '1.6.0', '--from', '1.5.0', '--patch', relative],
          {encoding: 'utf8', timeout: 60000});
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/changes no file/);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
