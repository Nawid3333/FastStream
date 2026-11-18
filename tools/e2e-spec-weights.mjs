// @ts-check
// Writes tests/e2e/specWeights.json from a CI run: each spec file's time on the Windows runner (shardSpecs.mjs).
// Usage: node tools/e2e-spec-weights.mjs <CI run id>
// A spec file's time runs from the line before its "PASSED in firefox"; a weight moves halfway to the run's time.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEIGHTS_FILE = path.join(root, 'tests/e2e/specWeights.json');
const SUITES = ['specs', 'ext-specs', 'classic-specs'];

/**
 * @param {string} log - `gh run view --job <id> --log`.
 * @return {Object<string, number>} Seconds per spec file that passed on its first attempt.
 */
export function timesFromLog(log) {
  const times = /** @type {Object<string, number>} */ ({});
  /** @type {number|null} */
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
 * @param {Object<string, number>} old
 * @param {Object<string, number>} fresh
 * @param {Set<string>} existing
 * @return {Object<string, number>} Halfway between old and fresh where both have it, else whichever has it.
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

/** @param {string} runId */
function main(runId) {
  if (!/^\d+$/.test(runId ?? '')) {
    console.error('usage: node tools/e2e-spec-weights.mjs <CI run id>');
    return 1;
  }
  /** @type {(...args: string[]) => string} */
  const gh = (...args) => execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
  const jobs = /** @type {{name: string, databaseId: number}[]} */ (JSON.parse(gh('run', 'view', runId, '--json', 'jobs')).jobs)
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
