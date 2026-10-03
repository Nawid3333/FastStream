import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {glob} from '../../miniglob.mjs';

// miniglob.mjs, the glob build.mjs lists the source tree and the old zips with. Its path
// separator came from a `require` that an ES module run by Node does not have, so it was
// always '/', while Windows paths use '\': a pattern built with path.join() matched nothing
// there (#245). Under vitest, which does define `require`, it was '\' instead, and build.mjs's
// own `glob(dir + '/**')` found nothing.

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miniglob-'));
  fs.mkdirSync(path.join(tmp, 'sub', 'deeper'), {recursive: true});
  for (const f of ['a.zip', 'b.txt', 'sub/c.zip', 'sub/deeper/d.mjs']) {
    fs.writeFileSync(path.join(tmp, f), f);
  }
});
afterAll(() => fs.rmSync(tmp, {recursive: true, force: true}));

const found = (list) => list.map((f) => path.relative(tmp, f).split(path.sep).join('/')).sort();

describe('glob', () => {
  it('walks a tree the way build.mjs asks for it: dir + "/**"', () => {
    expect(found(glob(tmp + '/**'))).toEqual(['a.zip', 'b.txt', 'sub/c.zip', 'sub/deeper/d.mjs']);
  });

  it('matches a wildcard after a "/"', () => {
    expect(found(glob(tmp + '/*.zip'))).toEqual(['a.zip']);
  });

  it('matches a wildcard in a pattern built with path.join', () => {
    expect(found(glob(path.join(tmp, '*.zip')))).toEqual(['a.zip']);
    expect(found(glob(path.join(tmp, 'sub', '*.zip')))).toEqual(['sub/c.zip']);
  });

  describe('on Windows', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.resetModules();
    });

    it('takes a backslash in a pattern as a separator', async () => {
      // Simulated where the tests do not run on Windows: miniglob reads the platform at load.
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', {value: 'win32'});
      let windowsGlob;
      try {
        vi.resetModules();
        windowsGlob = (await import('../../miniglob.mjs')).glob;
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
      const backslashed = (p) => p.split(path.sep).join('\\');
      expect(found(windowsGlob(backslashed(path.join(tmp, '*.zip'))))).toEqual(['a.zip']);
      expect(found(windowsGlob(backslashed(tmp) + '\\**'))).toEqual(['a.zip', 'b.txt', 'sub/c.zip', 'sub/deeper/d.mjs']);
    });
  });
});
