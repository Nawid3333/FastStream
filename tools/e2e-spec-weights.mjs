#!/usr/bin/env node
// Writes tests/e2e/specWeights.json anew from a CI run: how long each e2e spec file took on
// the Windows runner, which tests/e2e/shardSpecs.mjs groups the suites by (E2E_SHARD).
//
// Usage: node tools/e2e-spec-weights.mjs <CI run id>
//
// Reads the logs of the run's Windows playback and extension jobs through gh (the GitHub
// build's jobs run the same spec files again). A spec file's time is from the line before
// its "PASSED in firefox" line - the previous spec file's, or WebdriverIO's "Execution of N
// workers started at", which it prints once its onPrepare (the e2e servers, the fixtures)
// is done - so the browser's start is in it, as it is on every run, and the start of the
// run is not. (Not from the step's first line: gh can give a job's log with every line's
// step as "UNKNOWN STEP", and the job's whole setup then went to its first spec file: 208 s
// for archive-roundtrip, run 37385863816.) A weight moves halfway to the run's time, so
// one slow run (a busy runner) moves it only half; a new spec file takes the run's time.
// A spec file that needed its retry keeps the weight it has: its line holds both attempts.
// Spec files the run did not reach keep theirs too, and a spec file no longer in the
// suites is dropped.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEIGHTS_FILE = path.join(root, 'tests/e2e/specWeights.json');
const SUITES = ['specs', 'ext-specs', 'classic-specs'];

/**
 * @param {string} log - `gh run view --job <id> --log`: "job<TAB>step<TAB>timestamp line".
 * @return {Object<string, number>} Seconds per spec file (by its path from tests/e2e) that
 *     passed on its first attempt.
 */
export function timesFromLog(log) {
  const times = {};
  let last = null;
  for (const line of log.split(/\r?\n/)) {
    const match = /^[^\t]*\t[^\t]*\t(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/.exec(line);
    if (!match) continue;
    const [, stamp, text] = match;
    const time = Date.parse(stamp);
    if (/^Execution of \d+ workers? started at /.test(text)) {
      last = time;
      continue;
    }
    if (last === null) continue;
    const passed = /\] PASSED in firefox - \S*?tests\/e2e\/((?:specs|ext-specs|classic-specs)\/\S+?\.e2e\.mjs)(.*)$/.exec(text);
    if (passed) {
      if (!/retr/.test(passed[2])) times[passed[1]] = Math.max(1, Math.round((time - last) / 1000));
      last = time;
    } else if (/\] FAILED in firefox - /.test(text)) {
      last = time;
    }
  }
  return times;
}

/**
 * @param {Object<string, number>} old - The weights so far.
 * @param {Object<string, number>} fresh - This run's times.
 * @param {Set<string>} existing - The spec files there are.
 * @return {Object<string, number>} By name: halfway between old and fresh where both have
 *     the spec file, else whichever has it.
 */
export function mergeWeights(old, fresh, existing) {
  const merged = {...old};
  for (const [spec, seconds] of Object.entries(fresh)) {
    merged[spec] = spec in old ? Math.round((old[spec] + seconds) / 2) : seconds;
  }
  return Object.fromEntries(Object.entries(merged)
      .filter(([spec]) => existing.has(spec))
      .sort(([a], [b]) => a.localeCompare(b)));
}

function main(runId) {
  if (!/^\d+$/.test(runId ?? '')) {
    console.error('usage: node tools/e2e-spec-weights.mjs <CI run id>');
    return 1;
  }
  const gh = (...args) => execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
  const jobs = JSON.parse(gh('run', 'view', runId, '--json', 'jobs')).jobs
      .filter((job) => /^e2e \(Windows, (playback|extension)\b/.test(job.name));
  if (jobs.length === 0) {
    console.error(`Run ${runId} has no Windows playback or extension e2e job.`);
    return 1;
  }
  const fresh = Object.assign({}, ...jobs.map((job) => timesFromLog(gh('run', 'view', '--job', String(job.databaseId), '--log'))));
  const existing = new Set(SUITES.flatMap((suite) =>
    fs.readdirSync(path.join(root, 'tests/e2e', suite), {recursive: true})
        .map((file) => `${suite}/${String(file).replaceAll('\\', '/')}`)
        .filter((file) => file.endsWith('.e2e.mjs'))));
  const old = JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8'));
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(mergeWeights(old, fresh, existing), null, 2) + '\n');
  console.log(`${Object.keys(fresh).length} spec file(s) timed in run ${runId}, from ${jobs.length} job(s); ${path.relative(root, WEIGHTS_FILE)} written.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv[2]);
}
