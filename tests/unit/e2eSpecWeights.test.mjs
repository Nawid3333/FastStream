import {describe, expect, it} from 'vitest';
import {mergeWeights, timesFromLog} from '../../tools/e2e-spec-weights.mjs';

// tools/e2e-spec-weights.mjs times each e2e spec file from a CI job's log, for the weights
// E2E_SHARD groups the suites by (tests/e2e/shardSpecs.mjs).

const JOB = 'e2e (Windows, playback 1/3)';
const line = (step, time, text) => `${JOB}\t${step}\t2026-10-05T22:${time}Z ${text}`;
const PLAY = 'End-to-end playback (Windows Firefox)';
const EXT = 'End-to-end extension tests (Windows Firefox)';
const spec = (file) => `file:///D:/a/FastStream/FastStream/tests/e2e/${file}`;
const started = (workers) => `Execution of ${workers} workers started at 2026-10-05T22:00:00.000Z`;

describe('timesFromLog', () => {
  it('times each spec file from the line before its PASSED line, from the run\'s start', () => {
    const log = [
      line('Build all targets', '24:00.0000000', 'built'),
      line(PLAY, '24:01.0000000', '> wdio run tests/e2e/wdio.conf.mjs'),
      // onPrepare: the servers and the fixtures, not the first spec file's.
      line(PLAY, '24:10.0000000', started(2)),
      line(PLAY, '24:40.4000000', '[0-0] PASSED in firefox - ' + spec('specs/analyzer.e2e.mjs')),
      line(PLAY, '24:52.0000000', '[0-1] PASSED in firefox - ' + spec('specs/dialogs.e2e.mjs')),
    ].join('\n');
    expect(timesFromLog(log)).toEqual({'specs/analyzer.e2e.mjs': 30, 'specs/dialogs.e2e.mjs': 12});
  });

  it('starts again at each run, and counts a failed attempt as a line before the next', () => {
    const log = [
      line(EXT, '30:00.0000000', started(2)),
      line(EXT, '30:30.0000000', '[0-0] FAILED in firefox - ' + spec('ext-specs/vad.e2e.mjs')),
      line(EXT, '30:40.0000000', '[0-1] PASSED in firefox - ' + spec('ext-specs/mpv.e2e.mjs')),
      // The classic suite's run, in the same step: its own onPrepare is not timed.
      line(EXT, '31:30.0000000', started(1)),
      line(EXT, '31:45.0000000', '[0-0] PASSED in firefox - ' + spec('classic-specs/mpv-suspend.e2e.mjs')),
    ].join('\n');
    expect(timesFromLog(log)).toEqual({'ext-specs/mpv.e2e.mjs': 10, 'classic-specs/mpv-suspend.e2e.mjs': 15});
  });

  it('does not need the step names (gh can give every line as UNKNOWN STEP)', () => {
    const log = [
      line('UNKNOWN STEP', '20:00.0000000', 'Set up job'),
      line('UNKNOWN STEP', '23:30.0000000', 'choco install ffmpeg'),
      line('UNKNOWN STEP', '24:24.0000000', started(12)),
      line('UNKNOWN STEP', '24:52.0000000', '[0-0] PASSED in firefox - ' + spec('specs/archive-roundtrip.e2e.mjs')),
    ].join('\n');
    // Not 292 s: the job's setup before the run is no spec file's.
    expect(timesFromLog(log)).toEqual({'specs/archive-roundtrip.e2e.mjs': 28});
  });

  it('leaves out a spec file that needed its retry, other suites, and lines before a run', () => {
    const log = [
      line(PLAY, '23:00.0000000', '[0-0] PASSED in firefox - ' + spec('specs/early.e2e.mjs')),
      line(PLAY, '24:00.0000000', started(2)),
      line(PLAY, '25:00.0000000', '[0-0] PASSED in firefox - ' + spec('specs/hls-live.e2e.mjs') + ' (1 retries)'),
      line(PLAY, '25:10.0000000', '[0-1] PASSED in firefox - ' + spec('pbm-specs/private-browsing.e2e.mjs')),
    ].join('\n');
    expect(timesFromLog(log)).toEqual({});
  });
});

describe('mergeWeights', () => {
  it('moves a weight halfway to the new time, takes a new spec file\'s, keeps the rest, drops the gone', () => {
    const existing = new Set(['specs/a.e2e.mjs', 'specs/b.e2e.mjs', 'specs/c.e2e.mjs']);
    expect(mergeWeights({'specs/a.e2e.mjs': 10, 'specs/b.e2e.mjs': 7, 'specs/gone.e2e.mjs': 9},
        {'specs/c.e2e.mjs': 3, 'specs/a.e2e.mjs': 31}, existing)).toEqual({
      'specs/a.e2e.mjs': 21, // (10 + 31) / 2, rounded
      'specs/b.e2e.mjs': 7,
      'specs/c.e2e.mjs': 3,
    });
  });

  it('lists the spec files by name', () => {
    const existing = new Set(['specs/b.e2e.mjs', 'specs/a.e2e.mjs']);
    expect(Object.keys(mergeWeights({'specs/b.e2e.mjs': 1}, {'specs/a.e2e.mjs': 2}, existing)))
        .toEqual(['specs/a.e2e.mjs', 'specs/b.e2e.mjs']);
  });
});
