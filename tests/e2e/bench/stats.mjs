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

/**
 * Compares one measure of A and B.
 *
 * A difference counts only when it is larger than twice the larger noise (MAD) of the two and
 * than `floor` (a measure's resolution: a timer's tick, one frame): 5 runs a side cannot tell
 * less, and a verdict from noise is worse than none.
 * @param {number[]} a
 * @param {number[]} b
 * @param {{lowerIsBetter?: boolean, floor?: number}} [how]
 * @return {{a: number, b: number, diff: number, pct: number, noise: number,
 *   verdict: 'better'|'worse'|'same'|'n/a', runs: [number, number]}}
 *   diff and pct are B against A; verdict is B's.
 */
export function compare(a, b, {lowerIsBetter = true, floor = 0} = {}) {
  const ma = median(a);
  const mb = median(b);
  const runs = /** @type {[number, number]} */ ([a.filter(Number.isFinite).length, b.filter(Number.isFinite).length]);
  if (!Number.isFinite(ma) || !Number.isFinite(mb)) {
    return {a: ma, b: mb, diff: NaN, pct: NaN, noise: NaN, verdict: 'n/a', runs};
  }
  const diff = mb - ma;
  const noise = Math.max(mad(a), mad(b));
  const pct = ma === 0 ? (diff === 0 ? 0 : Infinity * Math.sign(diff)) : diff / Math.abs(ma) * 100;
  let verdict = /** @type {'better'|'worse'|'same'} */ ('same');
  if (Math.abs(diff) > Math.max(2 * noise, floor)) {
    verdict = (diff < 0) === lowerIsBetter ? 'better' : 'worse';
  }
  return {a: ma, b: mb, diff, pct, noise, verdict, runs};
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
    `| Scenario | Measure | ${labels.A} (median) | ${labels.B} (median) | B - A | Noise (MAD) | Runs | Verdict for ${labels.B} |`,
    '|---|---|---:|---:|---:|---:|---:|---|',
  ];
  for (const {scenario, measure, unit, result} of rows) {
    const pct = Number.isFinite(result.pct) ? ` (${result.pct > 0 ? '+' : ''}${show(result.pct)} %)` : '';
    lines.push(`| ${scenario} | ${measure} | ${show(result.a)} ${unit} | ${show(result.b)} ${unit} | ` +
      `${result.diff > 0 ? '+' : ''}${show(result.diff)}${pct} | ${show(result.noise)} | ` +
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
