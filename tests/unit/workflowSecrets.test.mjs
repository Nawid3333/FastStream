import fs from 'node:fs';
import path from 'node:path';
// js-yaml 5 has no default export, only named ones; this form reads 4 and 5 alike.
import * as yaml from 'js-yaml';
import {describe, expect, it} from 'vitest';

// The AMO keys and the owner's UPDATE_PRS_TOKEN are secrets of GitHub Environments whose
// deployment branch rules allow only main (and v* tags, for releases): a workflow file on any
// other branch, run with this repository's token (a pull request's), cannot
// read them (#163). A job reads an environment's secrets only when it names that environment,
// so each job that reads one must name its environment; this fails for one that does not.

const dir = path.resolve(import.meta.dirname, '../../.github/workflows');
const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

// Which environment holds each secret (docs/maintenance.md, "Secrets in environments").
const SECRET_ENVIRONMENT = {
  AMO_API_KEY: 'release',
  AMO_API_SECRET: 'release',
  UPDATE_PRS_TOKEN: 'update-prs',
};

/**
 * The secrets a job's text names: secrets.X, secrets['X'] and secrets["X"].
 * @param {Object} job - A job of a workflow, as parsed.
 * @return {string[]}
 */
function secretsOf(job) {
  const text = JSON.stringify(job);
  const names = new Set();
  for (const m of text.matchAll(/secrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*\\?['"]([A-Za-z_][A-Za-z0-9_]*)\\?['"]\s*\])/g)) {
    names.add(m[1] || m[2]);
  }
  return [...names];
}

/**
 * The environment a job names, from `environment: x` or `environment: {name: x}`.
 * @param {Object} job
 * @return {string|undefined}
 */
const environmentOf = (job) => typeof job.environment === 'string' ? job.environment : job.environment?.name;

const jobs = files.flatMap((file) => {
  const workflow = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
  return Object.entries(workflow.jobs || {}).map(([id, job]) => ({where: `${file} ${id}`, job}));
});

describe('secrets kept in environments', () => {
  it('are read only by jobs that name their environment', () => {
    const readers = jobs.filter(({job}) => secretsOf(job).some((s) => s in SECRET_ENVIRONMENT));
    // release.yml, the AMO signing failsafe and update-prs.yml read them today.
    expect(readers.length).toBeGreaterThanOrEqual(3);
    const wrong = readers.flatMap(({where, job}) => secretsOf(job).filter((s) => s in SECRET_ENVIRONMENT)
        .filter((s) => environmentOf(job) !== SECRET_ENVIRONMENT[s])
        .map((s) => `${where} reads ${s} with environment ${environmentOf(job) ?? '(none)'}, not ${SECRET_ENVIRONMENT[s]}`));
    expect(wrong).toEqual([]);
  });

  it('are not handed on whole, where this check could not follow them', () => {
    // `secrets: inherit` passes every secret to a called workflow, toJSON(secrets) prints them all.
    const whole = jobs.filter(({job}) => job.secrets === 'inherit' || /toJSON\(\s*secrets\s*\)/i.test(JSON.stringify(job)))
        .map(({where}) => where);
    expect(whole).toEqual([]);
  });

  it('finds each way a job can name a secret', () => {
    expect(secretsOf({env: {A: '${{ secrets.AMO_API_KEY }}'}})).toEqual(['AMO_API_KEY']);
    expect(secretsOf({steps: [{with: {t: '${{ secrets[\'UPDATE_PRS_TOKEN\'] }}'}}]})).toEqual(['UPDATE_PRS_TOKEN']);
    expect(secretsOf({steps: [{run: 'x', env: {T: '${{ secrets["AMO_API_SECRET"] }}'}}]})).toEqual(['AMO_API_SECRET']);
    expect(environmentOf({environment: 'release'})).toBe('release');
    expect(environmentOf({environment: {name: 'update-prs', deployment: false}})).toBe('update-prs');
  });
});
