// Records the spec files that failed and were run again (specFileRetries: 1 in every config).
//
// A spec file that fails once and passes on its retry leaves the run green and nothing to
// show for it: one green CI run in five hid a flake that way, and a real race (#67) passed
// for one more flake. So each config's onWorkerEnd is this hook: it keeps the driver logs as
// before (driverLogs.mjs) and, for a spec file's retry, appends one line to
// <outputDir>/retried.jsonl. ci.yml lists those lines in the run's summary, warns about each
// spec that passed only on its retry, and uploads the file; flaky-specs.yml folds a week of
// them into one issue.
//
// A retry is told apart as driverLogs.mjs tells it: it runs under the worker id of the first
// attempt, so an id that ends a second time is a retry, and its exit code the final result.

import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {keepDriverLogs} from './driverLogs.mjs';

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');

/**
 * Takes a suite's lines out of <outputDir>/retried.jsonl, keeping the others'.
 * @param {string} outputDir
 * @param {string} suite
 */
function forgetSuite(outputDir, suite) {
  const file = path.join(outputDir, 'retried.jsonl');
  try {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      // No earlier run left one.
      if (e.code === 'ENOENT') return;
      throw e;
    }
    const kept = text.split('\n').filter((line) => {
      if (!line.trim()) {
        return false;
      }
      try {
        return JSON.parse(line).suite !== suite;
      } catch (e) {
        return true;
      }
    });
    fs.writeFileSync(file, kept.map((line) => line + '\n').join(''));
  } catch (e) {
    // A diagnostic aid: failing to tidy it must not fail the run.
    console.warn(`could not drop ${suite}'s earlier lines from retried.jsonl: ${e.message}`);
  }
}

/**
 * An onWorkerEnd hook that keeps the driver logs and records the spec files that were
 * run again.
 * @param {string} outputDir - The config's outputDir; retried.jsonl goes there.
 * @param {string} suite - Which suite and build: 'web', 'ext-amo', 'pbm-github', ...
 * @return {function(string, number, string[]): void} The hook.
 */
export function recordRetriedSpecs(outputDir, suite) {
  const keepLogs = keepDriverLogs(outputDir, suite);
  const ends = new Map();
  let forgotten = false;
  return function onWorkerEnd(cid, exitCode, specs) {
    // The first worker of a run to end, before any retry of it is written: the suite's
    // lines from earlier runs go. A local run appended to every run before it, until
    // logs/ was deleted (#266); the other suites' lines stay, so after `pnpm run verify`
    // the file holds each suite's last run. CI starts each job with no file.
    if (!forgotten) {
      forgotten = true;
      forgetSuite(outputDir, suite);
    }
    const attempt = (ends.get(cid) || 0) + 1;
    ends.set(cid, attempt);
    keepLogs(cid, exitCode, specs);
    if (attempt < 2) {
      return;
    }
    try {
      const spec = specs && specs[0] ? String(specs[0]) : '';
      const file = spec.startsWith('file:') ? url.fileURLToPath(spec) : spec;
      const record = {
        suite,
        // With forward slashes, so a Windows run's line reads like a Linux run's.
        spec: path.relative(repoRoot, file).split(path.sep).join('/'),
        attempts: attempt,
        passed: exitCode === 0,
        os: process.platform,
      };
      fs.mkdirSync(outputDir, {recursive: true});
      fs.appendFileSync(path.join(outputDir, 'retried.jsonl'), JSON.stringify(record) + '\n');
    } catch (e) {
      // A diagnostic aid: failing to record a retry must not fail the run.
      console.warn(`could not record ${suite}'s retried spec ${cid}: ${e.message}`);
    }
  };
}
