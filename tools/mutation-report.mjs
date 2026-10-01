// Turns Stryker's report (reports/mutation/mutation.json) into what mutation-tests.yml
// shows: a table per file for the run's summary, and the body of the week's issue, which
// lists the mutants the unit tests did not catch.
//
//   node tools/mutation-report.mjs <mutation.json> summary
//   node tools/mutation-report.mjs <mutation.json> issue <owner> <run url>
//   node tools/mutation-report.mjs <mutation.json> count
//
// "Not caught" is Survived (the tests ran and passed) and NoCoverage (no test reached it).
// Killed and Timeout count as caught, as Stryker counts them.

import fs from 'node:fs';
import * as url from 'node:url';

const CAUGHT = new Set(['Killed', 'Timeout']);
const MISSED = new Set(['Survived', 'NoCoverage']);
const LISTED = 100;

/**
 * Each file's mutants, by status.
 * @param {Object} report - Stryker's mutation-testing report.
 * @return {Array<{file: string, total: number, caught: number, missed: number, score: number}>}
 *   Sorted by file; score is caught in percent of the mutants that ran, one decimal.
 */
export function perFile(report) {
  return Object.entries(report.files || {}).sort(([a], [b]) => a.localeCompare(b)).map(([file, {mutants}]) => {
    const caught = mutants.filter((m) => CAUGHT.has(m.status)).length;
    const missed = mutants.filter((m) => MISSED.has(m.status)).length;
    const ran = caught + missed;
    return {file, total: mutants.length, caught, missed, score: ran ? Math.round(caught * 1000 / ran) / 10 : 100};
  });
}

/**
 * Text from a report, safe in a table cell or inline code: one line, no pipe, no backtick.
 * @param {*} value
 * @return {string}
 */
function cell(value) {
  return String(value ?? '').replace(/\s+/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\'');
}

/**
 * The run summary: one row per file and a total.
 * @param {Object} report
 * @return {string} Markdown.
 */
export function summary(report) {
  const rows = perFile(report);
  const total = rows.reduce((t, r) => ({total: t.total + r.total, caught: t.caught + r.caught, missed: t.missed + r.missed}),
      {total: 0, caught: 0, missed: 0});
  const ran = total.caught + total.missed;
  return [
    '### Mutation testing',
    '',
    'Caught: the unit tests failed with the change (or timed out). Not caught: they passed, or none reached it.',
    '',
    '| File | Mutants | Caught | Not caught | Score |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${cell(r.file)} | ${r.total} | ${r.caught} | ${r.missed} | ${r.score}% |`),
    `| **All** | ${total.total} | ${total.caught} | ${total.missed} | ${ran ? Math.round(total.caught * 1000 / ran) / 10 : 100}% |`,
    '',
  ].join('\n');
}

/**
 * The mutants not caught, by file and line.
 * @param {Object} report
 * @return {Array<{file: string, line: number, status: string, mutator: string, replacement: string}>}
 */
export function missed(report) {
  const out = [];
  for (const [file, {mutants}] of Object.entries(report.files || {})) {
    for (const m of mutants) {
      if (MISSED.has(m.status)) {
        out.push({file, line: m.location?.start?.line ?? 0, status: m.status, mutator: m.mutatorName, replacement: m.replacement ?? ''});
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * The week's issue: what was not caught, the first LISTED of it by file.
 * @param {Object} report
 * @param {string} owner - Who to @mention.
 * @param {string} runUrl - The run, whose artifact has the full report.
 * @return {string} Markdown.
 */
export function issueBody(report, owner, runUrl) {
  const list = missed(report);
  const shown = list.slice(0, LISTED);
  const lines = [
    `@${owner} The unit tests did not catch ${list.length} of this week's mutants: changes to the code they still passed, or that no test reached. Each is a place where a fix could ship without a test that fails without it.`,
    '',
    `Run: ${runUrl} (its mutation-reports artifact has the full report, kept 30 days).`,
    '',
    summary(report),
    `### Not caught${list.length > LISTED ? ` (the first ${LISTED} of ${list.length})` : ''}`,
  ];
  let file = null;
  for (const m of shown) {
    if (m.file !== file) {
      file = m.file;
      lines.push('', `**${cell(file)}**`, '');
    }
    lines.push(`- line ${m.line}: ${m.status === 'NoCoverage' ? 'no test reaches it' : 'survived'} - ${cell(m.mutator)}: \`${cell(m.replacement) || '(removed)'}\``);
  }
  lines.push('', 'Next week\'s issue replaces this one; a week with every mutant caught closes it.', '');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  const [file, what, owner, runUrl] = process.argv.slice(2);
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (what === 'summary') {
    process.stdout.write(summary(report));
  } else if (what === 'issue') {
    process.stdout.write(issueBody(report, owner, runUrl));
  } else if (what === 'count') {
    process.stdout.write(String(missed(report).length) + '\n');
  } else {
    console.error('usage: mutation-report.mjs <mutation.json> summary|issue <owner> <run url>|count');
    process.exit(2);
  }
}
