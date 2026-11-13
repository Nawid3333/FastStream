// The A/B benchmark's report, from its numbers: written by the spec (ab.bench.mjs) at the end of
// a run, and again from a run's .json by `node tools/bench-ab.mjs --render <file>` (a report
// made before the verdicts changed reads the same way as a new one). Pure; no browser.
import {compare, renderTable} from './stats.mjs';

/**
 * What each measure is, for the report. floor: below this a difference says nothing (a
 * timeupdate comes about every 250 ms; a frame is 16 ms).
 * @type {Record<string, {label: string, unit: string, floor: number, lowerIsBetter?: boolean}>}
 */
export const MEASURES = {
  client: {label: 'player modules ready', unit: 'ms', floor: 5},
  firstFrame: {label: 'first frame', unit: 'ms', floor: 10},
  playing: {label: 'playing', unit: 'ms', floor: 10},
  seeked: {label: 'seek to 80 s: seeked', unit: 'ms', floor: 10},
  resumed: {label: 'seek to 80 s: playing past it', unit: 'ms', floor: 250},
  playWake: {label: 'wake-ups while playing', unit: '/s', floor: 1},
  playMutations: {label: 'DOM changes while playing', unit: '/s', floor: 1},
  longFrames: {label: 'frames > 50 ms apart while playing', unit: '', floor: 1},
  dropped: {label: 'dropped video frames while playing', unit: '', floor: 1},
  pausedWake: {label: 'wake-ups while paused', unit: '/s', floor: 0.5},
  previewReady: {label: 'seek preview at 120 s shown', unit: 'ms', floor: 10},
  afterPreviewWake: {label: 'wake-ups while paused, after a seek preview', unit: '/s', floor: 0.5},
  endedWake: {label: 'wake-ups once the video has ended', unit: '/s', floor: 0.5},
  idleWake: {label: 'wake-ups, idle player (no video)', unit: '/s', floor: 0.5},
};

/**
 * @typedef {Object} BenchRun
 * @property {{A: string, B: string}} labels
 * @property {{rateMbit: number, ttfbMs: number}} line
 * @property {number} rounds
 * @property {number} warmup
 * @property {Object<string, {A: Object<string, number[]>, B: Object<string, number[]>}>} results
 * @property {string[]} failures
 * @property {string} [at] - When it ran (ISO); the report's heading.
 */

/**
 * @param {BenchRun} run
 * @return {string} Markdown.
 */
export function renderReport(run) {
  const rows = [];
  for (const [scenario, {A, B}] of Object.entries(run.results)) {
    for (const [measure, how] of Object.entries(MEASURES)) {
      if (!A[measure] && !B[measure]) continue;
      rows.push({scenario, measure: how.label, unit: how.unit,
        result: compare(A[measure] || [], B[measure] || [], {floor: how.floor, lowerIsBetter: how.lowerIsBetter ?? true})});
    }
  }
  const {rateMbit, ttfbMs} = run.line;
  const line = rateMbit ? `${rateMbit} Mbit/s shared line, ${ttfbMs} ms to first byte` :
    (ttfbMs ? `no rate limit, ${ttfbMs} ms to first byte` : 'local, no limit');
  return [
    `# A/B benchmark ${run.at || ''}`.trimEnd(),
    '',
    `A = ${run.labels.A}, B = ${run.labels.B}. ${run.rounds} rounds a build (ABBA), ` +
      `${run.warmup} warm-up round thrown away; media: ${line}.`,
    'Verdict: B against A, only where the medians differ by more than twice the larger MAD and ' +
      'the measure\'s floor, and a rank-sum (Mann-Whitney) test gives p < 0.05; "same" otherwise.',
    '',
    renderTable(rows, run.labels),
    '',
    ...(run.failures.length ? ['Failed runs:', '', ...run.failures.map((failure) => `- ${failure}`), ''] : []),
  ].join('\n');
}
