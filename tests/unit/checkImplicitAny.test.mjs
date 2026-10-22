import {describe, expect, it} from 'vitest';
import {compareCounts, countByFile, recordText} from '../../tools/check-implicit-any.mjs';

// The noImplicitAny ratchet (`pnpm run typecheck:strict`) fails CI on these answers: a
// wrong one either lets an untyped place back in or blocks a change that typed one.

describe('countByFile', () => {
  it('counts the error lines per file, and nothing else tsc prints', () => {
    const output = [
      'chrome/player/a.mjs(3,7): error TS7006: Parameter \'x\' implicitly has an \'any\' type.',
      'chrome/player/a.mjs(9,1): error TS7034: Variable \'y\' implicitly has type \'any\' in some locations.',
      'tools/b.mjs(1,2): error TS2339: Property \'z\' does not exist on type \'Object\'.',
      '',
      'Found 3 errors in 2 files.',
      '  chrome/player/a.mjs(3,7) is mentioned here, but not as an error',
    ].join('\n');
    expect(countByFile(output)).toEqual({'chrome/player/a.mjs': 2, 'tools/b.mjs': 1});
  });

  it('reads Windows line ends and backslashes as the same file', () => {
    const output = 'tools\\b.mjs(1,2): error TS7006: x\r\ntools/b.mjs(4,2): error TS7006: y\r\n';
    expect(countByFile(output)).toEqual({'tools/b.mjs': 2});
  });
});

describe('compareCounts', () => {
  it('passes counts that match the record', () => {
    expect(compareCounts({'a.mjs': 3}, {'a.mjs': 3})).toEqual({grown: [], fallen: []});
  });

  it('fails a count that grew', () => {
    expect(compareCounts({'a.mjs': 3}, {'a.mjs': 4}).grown).toEqual([{file: 'a.mjs', was: 3, now: 4}]);
  });

  it('holds a file the record leaves out at 0: a typed file, or a new one', () => {
    expect(compareCounts({}, {'new.mjs': 1}).grown).toEqual([{file: 'new.mjs', was: 0, now: 1}]);
  });

  it('reports a count that fell, so the record is lowered with it', () => {
    expect(compareCounts({'a.mjs': 3, 'b.mjs': 2}, {'a.mjs': 1})).toEqual({
      grown: [],
      fallen: [{file: 'a.mjs', was: 3, now: 1}, {file: 'b.mjs', was: 2, now: 0}],
    });
  });
});

describe('recordText', () => {
  it('lists only files with errors, sorted, one per line', () => {
    expect(recordText({'b.mjs': 2, 'a.mjs': 1, 'c.mjs': 0})).toBe('{\n  "a.mjs": 1,\n  "b.mjs": 2\n}\n');
  });
});
