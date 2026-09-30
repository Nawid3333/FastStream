// Lists the spec files that were run again (retried.jsonl, see retriedSpecs.mjs) in the CI
// run's summary, and warns about each one that passed only on its retry.
//
// ci.yml runs this after each job's e2e suites: `node tests/e2e/reportRetried.mjs
// logs/retried.jsonl`. A green run that needed a retry now shows it on the run page and
// in the pull request's checks. A spec that failed its retry too failed the run already;
// it is listed, not warned about again.
//
// No dependencies: it runs after a failed install too.

import fs from 'node:fs';
import * as url from 'node:url';

/**
 * Escapes a workflow command's message, as GitHub's toolkit does.
 * @param {string} text
 * @return {string}
 */
function escapeData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * A table cell: no line breaks, no column separators.
 * @param {*} value
 * @return {string}
 */
function cell(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
}

/**
 * The summary and the warnings for retried.jsonl's lines.
 * @param {string} text - The file's contents; lines that are not JSON are skipped.
 * @return {{summary: string, warnings: string[], skipped: number}} The summary is ''
 *   when no spec file was run again.
 */
export function reportRetried(text) {
  const records = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (record && typeof record.spec === 'string') {
        records.push(record);
        continue;
      }
    } catch (e) {
      // Counted below: a half-written line from a killed worker.
    }
    skipped++;
  }
  if (!records.length) {
    return {summary: '', warnings: [], skipped};
  }
  const rows = records.map((r) =>
    `| ${cell(r.spec)} | ${cell(r.suite)} | ${cell(r.os)} | ${r.passed ? 'passed' : '**failed**'} |`);
  const summary = [
    '### Spec files that failed and were run again',
    '',
    'Each failed once. One that passed on its retry left the run green: a flaky test, or a race.',
    '',
    '| Spec file | Suite | OS | Retry |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
  const warnings = records.filter((r) => r.passed).map((r) =>
    `::warning title=Passed only on its retry::${escapeData(`${r.spec} (${r.suite}, ${r.os}) failed, then passed on its retry`)}`);
  return {summary, warnings, skipped};
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] || 'logs/retried.jsonl';
  if (!fs.existsSync(file)) {
    console.log('No spec file was run again.');
    process.exit(0);
  }
  const {summary, warnings, skipped} = reportRetried(fs.readFileSync(file, 'utf8'));
  if (skipped) {
    console.log(`${skipped} line(s) of ${file} were not a record; skipped.`);
  }
  if (!summary) {
    console.log('No spec file was run again.');
    process.exit(0);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  }
  console.log(summary);
  warnings.forEach((warning) => console.log(warning));
}
