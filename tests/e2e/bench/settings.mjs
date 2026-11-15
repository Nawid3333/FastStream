// The A/B benchmark's settings, from the environment tools/bench-ab.mjs sets: read by the
// config (wdio.bench.conf.mjs, its servers) and by the spec (ab.bench.mjs), whose tests are
// made when it loads, before any hook has run.
import path from 'node:path';

export const BENCH_PORTS = {A: 41890, B: 41891};
// Other names each build's server answers to (all of 127.0.0.0/8 is this computer): Firefox
// counts its connections, and orders what waits for one, per host.
export const BENCH_MEDIA_HOSTS = ['127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5'];

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
  // The tabs scenario: every tab's video from one host (BENCH_TABS_HOSTS=same) or each from
  // its own (the default).
  tabsOwnHosts: env.BENCH_TABS_HOSTS !== 'same',
  line: {
    rateMbit: boundedNumber('BENCH_RATE_MBIT', 0, 10000),
    ttfbMs: boundedNumber('BENCH_TTFB_MS', 0, 10000),
    // A line whose rate falls now and then, as a real one does: every BENCH_JITTER_MS the
    // shared line's rate switches between its full rate and BENCH_JITTER_FACTOR of it (0 ms:
    // a steady line).
    jitterMs: boundedNumber('BENCH_JITTER_MS', 0, 600000),
    jitterFactor: boundedNumber('BENCH_JITTER_FACTOR', 0.25, 1),
    // A cap per answer, as servers that throttle each connection have (0: none).
    connMbit: boundedNumber('BENCH_CONN_MBIT', 0, 10000),
    // Answers cut part-way, in percent: decided per request by its path and range, the first
    // time only, so both builds lose the same answers and a retry gets through.
    dropPct: boundedNumber('BENCH_DROP_PCT', 0, 50),
  },
  // How long the stall scenarios play before their seeks.
  stallMs: boundedNumber('BENCH_STALL_MS', 60000, 3600000),
  out: path.resolve(import.meta.dirname, '../../../logs/bench'),
};
