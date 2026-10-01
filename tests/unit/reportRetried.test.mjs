import {describe, expect, it} from 'vitest';
import {reportRetried} from '../e2e/reportRetried.mjs';

// ci.yml's list of the spec files that were run again: a spec that failed once and passed
// on its retry left a green run and no trace (W5).

const line = (record) => JSON.stringify(record) + '\n';
const flaky = {suite: 'ext-amo', spec: 'tests/e2e/specs/download-names.e2e.mjs', attempts: 2, passed: true, os: 'win32'};
const broken = {suite: 'web', spec: 'tests/e2e/specs/save-fmp4.e2e.mjs', attempts: 2, passed: false, os: 'linux'};

describe('reportRetried', () => {
  it('reports nothing when no spec file was run again', () => {
    expect(reportRetried('')).toEqual({summary: '', warnings: [], skipped: 0});
  });

  it('lists each spec file that was run again, and how its retry ended', () => {
    const {summary} = reportRetried(line(flaky) + line(broken));
    expect(summary).toContain('| tests/e2e/specs/download-names.e2e.mjs | ext-amo | win32 | passed |');
    expect(summary).toContain('| tests/e2e/specs/save-fmp4.e2e.mjs | web | linux | **failed** |');
  });

  it('warns about the ones that passed only on their retry, and only those', () => {
    const {warnings} = reportRetried(line(flaky) + line(broken));
    expect(warnings).toEqual([
      '::warning title=Passed only on its retry::tests/e2e/specs/download-names.e2e.mjs (ext-amo, win32) failed, then passed on its retry',
    ]);
  });

  it('skips a half-written line and keeps the rest', () => {
    const {summary, skipped} = reportRetried(line(flaky) + '{"suite":"web","sp');
    expect(skipped).toBe(1);
    expect(summary).toContain('download-names.e2e.mjs');
  });

  it('keeps a record from breaking the table or the workflow command', () => {
    const odd = {...flaky, suite: 'a|b', spec: 'tests/e2e/specs/x%\n::error::y.e2e.mjs'};
    const {summary, warnings} = reportRetried(line(odd));
    expect(summary).toContain('| tests/e2e/specs/x% ::error::y.e2e.mjs | a\\|b |');
    expect(warnings[0]).toContain('x%25%0A::error::y.e2e.mjs');
    expect(warnings[0].split('\n')).toHaveLength(1);
  });

  it('escapes a backslash too, so one before a | cannot undo its escape', () => {
    const {summary} = reportRetried(line({...flaky, suite: 'a\\|b'}));
    // a\|b becomes a\\\|b: the backslash, then the escaped |.
    expect(summary).toContain('| a\\\\\\|b |');
  });
});
