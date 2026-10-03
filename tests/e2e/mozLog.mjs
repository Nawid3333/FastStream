// Firefox's own network log (MOZ_LOG) for the specs that ask for one, kept only for an
// attempt that failed.
//
// loader-retry.e2e.mjs "stalls before its body" failed twice on the Windows runner
// (runs 36636900642 and 36669374448) with every retry stalled before it reached the
// test server, and never locally. The lead is Firefox's HTTP cache: the stalled
// response's cache entry is still being written when the retry for the same URL asks
// for it. A passing run shows the entry doomed at the abort and the retry opening a
// fresh one (cache2 and nsHttp at level 5); only a failing run's log can show whether
// the retry waited on the old entry. That log is ~40 MB per run, so only the listed
// specs write one, only when E2E_MOZ_LOG=1 (CI's Windows playback step), and an
// attempt that passes deletes its own.
//
// The variables go into the worker's own environment: wdio starts geckodriver from the
// worker, and geckodriver starts Firefox, each inheriting it. Every spec file, and
// every retry, runs in a worker of its own, so no other spec gets them.
// moz:firefoxOptions.env does not work here: with geckodriver 0.37.1 and Firefox 156
// the session was created with it (requestedCapabilities showed it) and Firefox wrote
// no log.

import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

/** Spec file name (without .e2e.mjs) -> the MOZ_LOG modules its Firefox logs. */
export const MozLogSpecs = new Map([
  ['loader-retry', 'timestamp,sync,cache2:5,nsHttp:5'],
]);

/**
 * The spec file's name without its directory and .e2e.mjs.
 * @param {string[]} specs - The worker's spec files (paths or file: URLs).
 * @return {string} The name, or '' when there is none.
 */
function specName(specs) {
  const spec = specs && specs[0] ? String(specs[0]) : '';
  const file = spec.startsWith('file:') ? url.fileURLToPath(spec) : spec;
  return path.basename(file).replace(/\.e2e\.mjs$/, '');
}

/**
 * The wdio hooks that give the listed specs a MOZ_LOG and keep it only on failure.
 * @param {string} logRoot - Where each attempt's log directory goes.
 * @param {Object<string, string|undefined>} [env] - The worker's environment: where
 *     E2E_MOZ_LOG is read and MOZ_LOG/MOZ_LOG_FILE are set.
 * @return {{beforeSession: Function, afterHook: Function, afterTest: Function, afterSession: Function}}
 */
export function mozLogHooks(logRoot, env = process.env) {
  let dir = null;
  let failed = false;
  let testsRun = 0;
  return {
    beforeSession(config, capabilities, specs) {
      dir = null;
      failed = false;
      testsRun = 0;
      if (env.E2E_MOZ_LOG !== '1') return;
      const name = specName(specs);
      const modules = MozLogSpecs.get(name);
      if (!modules) return;
      fs.mkdirSync(logRoot, {recursive: true});
      // Unique per attempt: a passing retry deletes its own directory, never the failed one's.
      dir = fs.mkdtempSync(path.join(logRoot, `${name}-`));
      env.MOZ_LOG = modules;
      env.MOZ_LOG_FILE = path.join(dir, 'moz.log');
    },
    // A failed hook (a server that did not start in `before`, the case the log is for)
    // reaches no afterTest: WebdriverIO reports it here, and its tests do not run.
    afterHook(test, context, {error, passed}) {
      if (error || passed === false) failed = true;
    },
    afterTest(test, context, {passed}) {
      testsRun++;
      if (!passed) failed = true;
    },
    afterSession() {
      if (!dir) return;
      delete env.MOZ_LOG;
      delete env.MOZ_LOG_FILE;
      // Kept too when no test ran: nothing passed.
      if (failed || testsRun === 0) return;
      try {
        // Firefox has exited by now, but on Windows a child process can hold its log
        // file for a moment longer.
        fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
      } catch (e) {
        // A log is a diagnostic aid: failing to delete one must not fail the run.
        console.warn(`could not delete ${dir}: ${e.message}`);
      }
    },
  };
}
