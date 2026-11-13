// The A/B benchmark's settings, from the environment tools/bench-ab.mjs sets: read by the
// config (wdio.bench.conf.mjs, its servers) and by the spec (ab.bench.mjs), whose tests are
// made when it loads, before any hook has run.
import path from 'node:path';

export const BENCH_PORTS = {A: 41890, B: 41891};

const env = process.env;

/**
 * A number from the environment, refused outside its range: the delays and loops it sets
 * stay bounded whatever was passed.
 * @param {string} name
 * @param {number} fallback
 * @param {number} max
 * @return {number}
 */
export function boundedNumber(name, fallback, max) {
  const text = env[name];
  const value = text === undefined || text === '' ? fallback : Number(text);
  if (!(value >= 0 && value <= max)) throw new Error(`${name} must be a number from 0 to ${max}`);
  return value;
}

export const bench = {
  dirs: {A: env.BENCH_A_DIR || '', B: env.BENCH_B_DIR || ''},
  origins: {A: `http://127.0.0.1:${BENCH_PORTS.A}`, B: `http://127.0.0.1:${BENCH_PORTS.B}`},
  labels: {A: env.BENCH_A_LABEL || 'A', B: env.BENCH_B_LABEL || 'B'},
  rounds: boundedNumber('BENCH_ROUNDS', 5, 100),
  warmup: boundedNumber('BENCH_WARMUP', 1, 10),
  where: env.BENCH_WHERE === '1',
  scenarios: (env.BENCH_SCENARIOS || 'mp4,hls,dash,idle').split(','),
  line: {rateMbit: boundedNumber('BENCH_RATE_MBIT', 0, 10000), ttfbMs: boundedNumber('BENCH_TTFB_MS', 0, 10000)},
  out: path.resolve(import.meta.dirname, '../../../logs/bench'),
};
