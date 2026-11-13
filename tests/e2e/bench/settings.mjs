// The A/B benchmark's settings, from the environment tools/bench-ab.mjs sets: read by the
// config (wdio.bench.conf.mjs, its servers) and by the spec (ab.bench.mjs), whose tests are
// made when it loads, before any hook has run.
import path from 'node:path';

export const BENCH_PORTS = {A: 41890, B: 41891};

const env = process.env;

export const bench = {
  dirs: {A: env.BENCH_A_DIR || '', B: env.BENCH_B_DIR || ''},
  origins: {A: `http://127.0.0.1:${BENCH_PORTS.A}`, B: `http://127.0.0.1:${BENCH_PORTS.B}`},
  labels: {A: env.BENCH_A_LABEL || 'A', B: env.BENCH_B_LABEL || 'B'},
  rounds: Number(env.BENCH_ROUNDS || 5),
  warmup: Number(env.BENCH_WARMUP ?? 1),
  where: env.BENCH_WHERE === '1',
  scenarios: (env.BENCH_SCENARIOS || 'mp4,hls,dash,idle').split(','),
  line: {rateMbit: Number(env.BENCH_RATE_MBIT || 0), ttfbMs: Number(env.BENCH_TTFB_MS || 0)},
  out: path.resolve(import.meta.dirname, '../../../logs/bench'),
};
