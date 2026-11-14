// The numbers of an A/B benchmark (wdio.bench.conf.mjs): medians, their spread, and whether a
// difference stands out from the run-to-run noise. Pure, so unit-tested (tests/unit/benchStats).

/**
 * @param {number[]} values
 * @return {number} The median; NaN for none.
 */
export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The median absolute deviation: how far a run typically lies from the median. Unlike the
 * standard deviation, one stray run (a GC, a busy machine) barely moves it.
 * @param {number[]} values
 * @return {number}
 */
export function mad(values) {
  const m = median(values);
  return median(values.filter(Number.isFinite).map((value) => Math.abs(value - m)));
}

// How many splits rankSumP looks at before it samples instead (10 + 10 runs are 184,756).
const PERMUTATION_LIMIT = 200000;
// The level the rank-sum test must reach for a verdict.
export const SIGNIFICANCE = 0.05;

/**
 * @param {number[]} values
 * @return {number[]} Each value's rank among them, from 1; tied values share their mean rank.
 */
function midranks(values) {
  const order = values.map((value, index) => ({value, index})).sort((x, y) => x.value - y.value);
  const ranks = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j++;
    for (let t = i; t <= j; t++) ranks[order[t].index] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return ranks;
}

/**
 * How likely runs this far apart are when A and B are the same: the Wilcoxon-Mann-Whitney
 * rank-sum test, its p the share of all ways to split the runs into two groups of these sizes
 * whose rank sums lie at least as far from the middle (exact, ties at their mean rank). Unlike
 * the MAD it assumes no single cluster: runs that fall into the same two modes on both builds
 * (a fast and a slow start, by the round) give a large p however the two medians happen to
 * land. Every split up to PERMUTATION_LIMIT of them; past that, as many random ones (seeded, so
 * a report renders the same each time).
 * @param {number[]} a
 * @param {number[]} b
 * @return {number} From 0 to 1; NaN when a side has no run.
 */
export function rankSumP(a, b) {
  const xs = a.filter(Number.isFinite);
  const ys = b.filter(Number.isFinite);
  if (!xs.length || !ys.length) return NaN;
  const n = xs.length + ys.length;
  const k = xs.length;
  const ranks = midranks([...xs, ...ys]);
  const middle = k * (n + 1) / 2;
  let sumA = 0;
  for (let i = 0; i < k; i++) sumA += ranks[i];
  const observed = Math.abs(sumA - middle) - 1e-9;
  let splits = 1;
  for (let i = 0; i < k; i++) splits = splits * (n - i) / (i + 1);
  let atLeast = 0;
  if (splits <= PERMUTATION_LIMIT) {
    const picked = Array.from({length: k}, (_, i) => i);
    for (;;) {
      let sum = 0;
      for (const index of picked) sum += ranks[index];
      if (Math.abs(sum - middle) >= observed) atLeast++;
      let i = k - 1;
      while (i >= 0 && picked[i] === n - k + i) i--;
      if (i < 0) break;
      picked[i]++;
      for (let j = i + 1; j < k; j++) picked[j] = picked[j - 1] + 1;
    }
    return atLeast / splits;
  }
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = ranks.map((_, i) => i);
  for (let s = 0; s < PERMUTATION_LIMIT; s++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let sum = 0;
    for (let i = 0; i < k; i++) sum += ranks[order[i]];
    if (Math.abs(sum - middle) >= observed) atLeast++;
  }
  return (atLeast + 1) / (PERMUTATION_LIMIT + 1);
}

/**
 * Compares one measure of A and B.
 *
 * A difference counts only when it is larger than twice the larger noise (MAD) of the two and
 * than `floor` (a measure's resolution: a timer's tick, one frame), and the rank-sum test puts
 * it below SIGNIFICANCE (runs in the same two modes on both builds; 5 runs a side reach 0.008
 * at best, 3 only 0.1). A verdict from noise is worse than none.
 * @param {number[]} a
 * @param {number[]} b
 * @param {{lowerIsBetter?: boolean, floor?: number}} [how]
 * @return {{a: number, b: number, diff: number, pct: number, noise: number, p: number,
 *   verdict: 'better'|'worse'|'same'|'n/a', runs: [number, number]}}
 *   diff and pct are B against A; verdict is B's.
 */
export function compare(a, b, {lowerIsBetter = true, floor = 0} = {}) {
  const ma = median(a);
  const mb = median(b);
  const runs = /** @type {[number, number]} */ ([a.filter(Number.isFinite).length, b.filter(Number.isFinite).length]);
  if (!Number.isFinite(ma) || !Number.isFinite(mb)) {
    return {a: ma, b: mb, diff: NaN, pct: NaN, noise: NaN, p: NaN, verdict: 'n/a', runs};
  }
  const diff = mb - ma;
  const noise = Math.max(mad(a), mad(b));
  const pct = ma === 0 ? (diff === 0 ? 0 : Infinity * Math.sign(diff)) : diff / Math.abs(ma) * 100;
  const p = diff === 0 ? 1 : rankSumP(a, b);
  let verdict = /** @type {'better'|'worse'|'same'} */ ('same');
  if (Math.abs(diff) > Math.max(2 * noise, floor) && p < SIGNIFICANCE) {
    verdict = (diff < 0) === lowerIsBetter ? 'better' : 'worse';
  }
  return {a: ma, b: mb, diff, pct, noise, p, verdict, runs};
}

/**
 * @param {number} value
 * @return {string}
 */
function show(value) {
  if (!Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 100) return String(Math.round(value));
  return String(Math.round(value * 10) / 10);
}

/**
 * The report's table: one line per scenario and measure.
 * @param {{scenario: string, measure: string, unit: string, result: ReturnType<typeof compare>}[]} rows
 * @param {{A: string, B: string}} labels
 * @return {string} Markdown.
 */
export function renderTable(rows, labels) {
  const lines = [
    `| Scenario | Measure | ${labels.A} (median) | ${labels.B} (median) | B - A | Noise (MAD) | p | Runs | Verdict for ${labels.B} |`,
    '|---|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const {scenario, measure, unit, result} of rows) {
    const pct = Number.isFinite(result.pct) ? ` (${result.pct > 0 ? '+' : ''}${show(result.pct)} %)` : '';
    const p = Number.isFinite(result.p) ? (result.p < 0.001 ? '<0.001' : result.p.toFixed(3)) : '-';
    lines.push(`| ${scenario} | ${measure} | ${show(result.a)} ${unit} | ${show(result.b)} ${unit} | ` +
      `${result.diff > 0 ? '+' : ''}${show(result.diff)}${pct} | ${show(result.noise)} | ${p} | ` +
      `${result.runs[0]}/${result.runs[1]} | ${result.verdict} |`);
  }
  return lines.join('\n');
}

/**
 * The order of the builds in each round: A first in even rounds, B first in odd ones (ABBA),
 * so neither always runs on a warmer browser.
 * @param {number} round
 * @return {['A', 'B'] | ['B', 'A']}
 */
export function roundOrder(round) {
  return round % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
}
