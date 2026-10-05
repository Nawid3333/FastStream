import {describe, expect, it} from 'vitest';
import {mergeWeights, timesFromLog} from '../../tools/e2e-spec-weights.mjs';

// tools/e2e-spec-weights.mjs times each e2e spec file from a CI job's log, for the weights
// E2E_SHARD groups the suites by (tests/e2e/shardSpecs.mjs).

const JOB = 'e2e (Windows, playback 1/3)';
const line = (step, time, text) => `${JOB}\t${step}\t2026-10-05T22:${time}Z ${text}`;
const PLAY = 'End-to-end playback (Windows Firefox)';
const spec = (file) => `file:///D:/a/FastStream/FastStream/tests/e2e/${file}`;

describe('timesFromLog', () => {
  it('times each spec file from the line before its PASSED line', () => {
    const log = [
      line('Build all targets', '24:00.0000000', 'built'),
      line(PLAY, '24:10.0000000', '> wdio run tests/e2e/wdio.conf.mjs'),
      line(PLAY, '24:40.4000000', '[0-0] PASSED in firefox - ' + spec('specs/analyzer.e2e.mjs')),
      line(PLAY, '24:52.0000000', '[0-1] PASSED in firefox - ' + spec('specs/dialogs.e2e.mjs')),
    ].join('\n');
    expect(timesFromLog(log)).toEqual({'specs/analyzer.e2e.mjs': 30, 'specs/dialogs.e2e.mjs': 12});
  });

  it('starts again at each step, and counts a failed attempt as a line before the next', () => {
    const EXT = 'End-to-end extension tests (Windows Firefox)';
    const log = [
      line(PLAY, '24:00.0000000', 'start'),
      line(PLAY, '24:20.0000000', '[0-0] PASSED in firefox - ' + spec('specs/analyzer.e2e.mjs')),
      line(EXT, '30:00.0000000', 'start'),
      line(EXT, '30:30.0000000', '[0-0] FAILED in firefox - ' + spec('ext-specs/vad.e2e.mjs')),
      line(EXT, '30:45.0000000', '[0-1] PASSED in firefox - ' + spec('classic-specs/mpv-suspend.e2e.mjs')),
    ].join('\n');
    expect(timesFromLog(log)).toEqual({'specs/analyzer.e2e.mjs': 20, 'classic-specs/mpv-suspend.e2e.mjs': 15});
  });

  it('leaves out a spec file that needed its retry, and other suites', () => {
    const log = [
      line(PLAY, '24:00.0000000', 'start'),
      line(PLAY, '25:00.0000000', '[0-0] PASSED in firefox - ' + spec('specs/hls-live.e2e.mjs') + ' (1 retries)'),
      line(PLAY, '25:10.0000000', '[0-1] PASSED in firefox - ' + spec('pbm-specs/private-browsing.e2e.mjs')),
    ].join('\n');
    expect(timesFromLog(log)).toEqual({});
  });
});

describe('mergeWeights', () => {
  it('takes the new times, keeps the old ones the run did not have, drops spec files that are gone', () => {
    const existing = new Set(['specs/a.e2e.mjs', 'specs/b.e2e.mjs', 'specs/c.e2e.mjs']);
    expect(mergeWeights({'specs/a.e2e.mjs': 5, 'specs/b.e2e.mjs': 7, 'specs/gone.e2e.mjs': 9},
        {'specs/c.e2e.mjs': 3, 'specs/a.e2e.mjs': 6}, existing)).toEqual({
      'specs/a.e2e.mjs': 6, 'specs/b.e2e.mjs': 7, 'specs/c.e2e.mjs': 3,
    });
  });
});
