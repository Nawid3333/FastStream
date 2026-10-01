// Keeps every geckodriver log a run writes, for CI's "upload e2e failure logs" step.
//
// wdio names a worker's driver log after the worker's id alone (wdio-0-3-geckodriver.log)
// and opens it for writing, not appending. A spec file's retry runs under the same id, so
// its log replaced the failed attempt's: the one the failure was in. And every suite
// numbers its workers from 0-0, so each suite a CI job runs (web, extension, classic,
// both builds, private browsing) replaced the logs of the one before.
//
// So once a worker ends, its log is renamed after the suite, the spec file and the
// attempt: geckodriver-classic-amo-mpv-shortcut-0-3-attempt1.log. The next worker starts
// only after this hook returns (wdio's launcher awaits onWorkerEnd before it schedules
// the retry).

import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

/**
 * An onWorkerEnd hook that renames the worker's geckodriver log.
 * @param {string} outputDir - The config's outputDir.
 * @param {string} suite - Which suite and build, for the name: 'web', 'classic-amo', ...
 * @return {function(string, number, string[]): void} The hook.
 */
export function keepDriverLogs(outputDir, suite) {
  // Workers per id so far: the first run of a spec file is attempt 1, its retry 2.
  const attempts = new Map();
  return function onWorkerEnd(cid, exitCode, specs) {
    // wdio's worker ids are digit groups joined by dashes (0, 0-4); anything else
    // never joins a path below (CodeQL js/path-injection).
    if (!/^[\d-]+$/.test(cid) || cid.startsWith('-') || cid.endsWith('-') || cid.includes('--')) {
      return;
    }
    const attempt = (attempts.get(cid) || 0) + 1;
    attempts.set(cid, attempt);
    const from = path.join(outputDir, `wdio-${cid}-geckodriver.log`);
    // Renaming (not existsSync-then-read) has no gap in between; a log that vanished
    // is a lost diagnostic, not a failure (CodeQL js/file-system-race).
    try {
      const spec = specs && specs[0] ? String(specs[0]) : '';
      const file = spec.startsWith('file:') ? url.fileURLToPath(spec) : spec;
      const name = path.basename(file).replace(/\.e2e\.mjs$/, '') || 'spec';
      fs.renameSync(from, path.join(outputDir, `geckodriver-${suite}-${name}-${cid}-attempt${attempt}.log`));
    } catch (e) {
      // A log is a diagnostic aid: failing to keep one must not fail the run.
      console.warn(`could not keep ${from}: ${e.message}`);
    }
  };
}
