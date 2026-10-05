// E2E_SHARD=<i>/<n>: a suite's spec files in n groups of about the same running time, and
// this run takes the i-th. CI runs each group in a job of its own, side by side (ci.yml's
// e2e matrix); without E2E_SHARD a config runs all its spec files, as before.
//
// Why not WebdriverIO's own --shard: it cuts the list into slices of the same number of
// files, and the long spec files sit together - on Windows one half of the extension suite
// took 527 s and the other 402 s (CI run 37382065299). The groups here are made from each
// file's running time on CI's Windows runner (specWeights.json, in seconds): the longest
// first, each to the group with the least time so far. A spec file not in the list counts
// as the median of the others; `node tools/e2e-spec-weights.mjs <CI run id>` writes the
// list anew from a run's logs.
//
// The same files always give the same groups, so a job's spec files do not change from
// one run to the next unless the files or their weights do.
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
export const WEIGHTS = JSON.parse(fs.readFileSync(path.join(here, 'specWeights.json'), 'utf8'));

/**
 * @param {string|undefined} value - E2E_SHARD.
 * @return {{index: number, total: number}|null} null when unset or empty.
 */
export function parseShard(value) {
  if (!value) return null;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (!(index >= 1 && index <= total)) {
    throw new Error(`E2E_SHARD is "${value}": expected <i>/<n> with 1 <= i <= n, such as 2/3`);
  }
  return {index, total};
}

/**
 * Files in `total` groups of about the same weight: the heaviest first, each to the
 * lightest group so far (ties: the earlier group, and files by name).
 * @param {string[]} files
 * @param {number} total
 * @param {(file: string) => number} weightOf
 * @return {string[][]} The groups, each sorted by name.
 */
export function splitByWeight(files, total, weightOf) {
  const groups = Array.from({length: total}, () => ({files: [], weight: 0}));
  const heaviestFirst = files.map((file) => ({file, weight: weightOf(file)}))
      .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  for (const {file, weight} of heaviestFirst) {
    const lightest = groups.reduce((min, group) => group.weight < min.weight ? group : min);
    lightest.files.push(file);
    lightest.weight += weight;
  }
  return groups.map((group) => group.files.sort((a, b) => a.localeCompare(b)));
}

/**
 * A wdio config's `specs`: every *.e2e.mjs under `dir`, or E2E_SHARD's group of them.
 * @param {string} dir - The suite's spec folder, absolute.
 * @param {string|undefined} [value] - E2E_SHARD.
 * @param {Object<string, number>} [weights] - Seconds per spec file, by its path from tests/e2e.
 * @return {string[]}
 */
export function shardSpecs(dir, value = process.env.E2E_SHARD, weights = WEIGHTS) {
  const shard = parseShard(value);
  if (!shard) return [path.join(dir, '**/*.e2e.mjs')];
  const files = fs.readdirSync(dir, {recursive: true})
      .map((file) => String(file).replaceAll('\\', '/'))
      .filter((file) => file.endsWith('.e2e.mjs'))
      .sort((a, b) => a.localeCompare(b));
  if (files.length < shard.total) {
    // WebdriverIO fails a run with no spec file ("No specs found to run").
    throw new Error(`E2E_SHARD is ${value}, but ${dir} has only ${files.length} spec file(s)`);
  }
  const prefix = path.relative(here, dir).replaceAll('\\', '/');
  const known = Object.values(weights).sort((a, b) => a - b);
  const median = known.length ? known[known.length >> 1] : 1;
  const weightOf = (file) => weights[`${prefix}/${file}`] ?? median;
  return splitByWeight(files, shard.total, weightOf)[shard.index - 1].map((file) => path.join(dir, file));
}
