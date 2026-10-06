import {describe, expect, it} from 'vitest';
import {issueBody, merge, missed, perFile, summary} from '../../tools/mutation-report.mjs';

// mutation-tests.yml's summary table and weekly issue, from Stryker's report.

const mutant = (status, line, mutatorName = 'EqualityOperator', replacement = 'a <= b') =>
  ({status, mutatorName, replacement, location: {start: {line, column: 1}, end: {line, column: 9}}});

const report = {
  files: {
    'chrome/player/utils/StreamPick.mjs': {mutants: [
      mutant('Killed', 3), mutant('Killed', 4), mutant('Timeout', 5), mutant('Survived', 9, 'ConditionalExpression', 'true'),
    ]},
    'chrome/background/DownloadFilename.mjs': {mutants: [
      mutant('NoCoverage', 20, 'StringLiteral', '""'), mutant('Killed', 2), mutant('Ignored', 1), mutant('CompileError', 7),
    ]},
  },
};

describe('mutation-report', () => {
  it('counts each file\'s caught (killed, timed out) and not caught (survived, no coverage) mutants', () => {
    expect(perFile(report)).toEqual([
      {file: 'chrome/background/DownloadFilename.mjs', total: 4, caught: 1, missed: 1, score: 50},
      {file: 'chrome/player/utils/StreamPick.mjs', total: 4, caught: 3, missed: 1, score: 75},
    ]);
  });

  it('writes a row per file and the total', () => {
    const text = summary(report);
    expect(text).toContain('| chrome/player/utils/StreamPick.mjs | 4 | 3 | 1 | 75% |');
    expect(text).toContain('| **All** | 8 | 4 | 2 | 66.7% |');
  });

  it('lists what was not caught, by file and line', () => {
    expect(missed(report).map((m) => `${m.file}:${m.line} ${m.status}`)).toEqual([
      'chrome/background/DownloadFilename.mjs:20 NoCoverage',
      'chrome/player/utils/StreamPick.mjs:9 Survived',
    ]);
  });

  it('writes the issue: who to tell, the run, and each mutant with what the line became', () => {
    const body = issueBody(report, 'Nawid3333', 'https://github.com/x/y/actions/runs/1');
    expect(body).toMatch(/^@Nawid3333 The unit tests did not catch 2 of this week's mutants/);
    expect(body).toContain('Run: https://github.com/x/y/actions/runs/1');
    expect(body).toContain('- line 20: no test reaches it - StringLiteral: `""`');
    expect(body).toContain('- line 9: survived - ConditionalExpression: `true`');
  });

  it('keeps a replacement from breaking the list, and shows at most 100 mutants', () => {
    const many = {files: {'a.mjs': {mutants: Array.from({length: 150}, (_, i) => mutant('Survived', i + 1, 'X', 'a | `b`\nc'))}}};
    const body = issueBody(many, 'o', 'r');
    expect(body).toContain('### Not caught (the first 100 of 150)');
    expect(body).toContain('- line 1: survived - X: `a \\| \'b\' c`');
    expect(body.match(/^- line /gm)).toHaveLength(100);
  });

  it('puts the shards\' reports together, every file of each (#253)', () => {
    const network = {schemaVersion: '2', files: {'chrome/player/network/FetchLoader.mjs': {mutants: [mutant('Survived', 4)]}}};
    const merged = merge([{schemaVersion: '2', ...report}, network]);
    expect(merged.schemaVersion).toBe('2');
    expect(Object.keys(merged.files).sort()).toEqual([
      'chrome/background/DownloadFilename.mjs', 'chrome/player/network/FetchLoader.mjs', 'chrome/player/utils/StreamPick.mjs',
    ]);
    expect(missed(merged)).toHaveLength(3);
    expect(merge([])).toEqual({files: {}});
  });

  it('refuses a module two shards both report', () => {
    expect(() => merge([report, report])).toThrow(/is in two reports/);
  });
});
