import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {describe, expect, it} from 'vitest';

// A job that calls a workflow of this repository (uses: ./.github/workflows/x.yml) caps
// what the called jobs' token may do. GitHub checks every called job against that cap when
// the run starts, before any if:, and refuses the whole run if one asks for more: no job
// runs, and no one is told. So runner-images.yml's daily run failed at startup from the
// day ci.yml's release hand-off asked for issues: write (#77, 2026-09-30), and actionlint
// passed it. #64 had met the same with actions: write, before it merged.

const dir = path.resolve(import.meta.dirname, '../../.github/workflows');
const load = (file) => yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
const LEVELS = {none: 0, read: 1, write: 2};

/**
 * A permissions value as {scope: level}, with '*' for every scope it leaves out.
 * @param {string|Object} permissions - A workflow's or a job's `permissions:`.
 * @return {Object<string, string>}
 */
function grants(permissions) {
  if (permissions === 'read-all') return {'*': 'read'};
  if (permissions === 'write-all') return {'*': 'write'};
  return {'*': 'none', ...permissions};
}

/**
 * What a job asks for beyond what the call that runs it allows.
 * @param {string|Object} cap - The calling job's permissions.
 * @param {string|Object} request - The called job's permissions.
 * @return {string[]} One "scope: asked (allowed ...)" per scope it asks too much of.
 */
function excess(cap, request) {
  const allowed = grants(cap);
  const asked = grants(request);
  const scopes = new Set([...Object.keys(allowed), ...Object.keys(asked)]);
  return [...scopes].filter((scope) => scope !== '*' || asked['*'] !== 'none')
      .filter((scope) => LEVELS[asked[scope] ?? asked['*']] > LEVELS[allowed[scope] ?? allowed['*']])
      .map((scope) => `${scope}: ${asked[scope] ?? asked['*']} (allowed ${allowed[scope] ?? allowed['*']})`);
}

/**
 * The narrower of two permissions, scope by scope: what reaches the jobs of a workflow that a
 * job asking for `request` calls, when the call that runs that job allows `cap`.
 * @param {string|Object} cap - What reaches the calling job.
 * @param {string|Object} request - The calling job's permissions.
 * @return {Object<string, string>}
 */
function narrower(cap, request) {
  const allowed = grants(cap);
  const asked = grants(request);
  const level = (given, scope) => given[scope] ?? given['*'];
  const scopes = new Set([...Object.keys(allowed), ...Object.keys(asked)]);
  return Object.fromEntries([...scopes].map((scope) => {
    const [a, b] = [level(allowed, scope), level(asked, scope)];
    return [scope, LEVELS[a] <= LEVELS[b] ? a : b];
  }));
}

/**
 * Every job a call of `file` runs that asks for more than reaches it, through the workflows
 * those jobs call in turn: a job that calls another workflow passes on no more than it has
 * itself.
 * @param {Object<string, Object>} workflows - Each workflow file, by name, parsed.
 * @param {string} file - The called workflow.
 * @param {string|Object} cap - What the call allows.
 * @param {string} chain - The calls that led here, for the message.
 * @param {Set<string>} [onChain] - The workflows on the chain; a call back to one ends it.
 * @return {string[]} One "chain -> file job: scope: asked (allowed ...)" per excess.
 */
function refusedJobs(workflows, file, cap, chain, onChain = new Set()) {
  if (onChain.has(file)) return [];
  const called = workflows[file];
  if (!called) return [`${chain} -> ${file}: no such workflow`];
  const next = new Set([...onChain, file]);
  return Object.entries(called.jobs || {}).flatMap(([id, job]) => {
    const here = `${chain} -> ${file} ${id}`;
    const request = job.permissions ?? called.permissions;
    // A job that asks for nothing of its own takes the cap.
    const refused = request === undefined ? [] : excess(cap, request).map((scope) => `${here}: ${scope}`);
    if (typeof job.uses !== 'string' || !job.uses.startsWith('./.github/workflows/')) return refused;
    return [...refused, ...refusedJobs(workflows, path.basename(job.uses),
        request === undefined ? cap : narrower(cap, request), here, next)];
  });
}

describe('excess', () => {
  it('names a scope the called job asks for and the call does not give', () => {
    expect(excess({contents: 'read', actions: 'write'}, {actions: 'write', issues: 'write'}))
        .toEqual(['issues: write (allowed none)']);
  });

  it('names a write where the call gives only read', () => {
    expect(excess({contents: 'read'}, {contents: 'write'})).toEqual(['contents: write (allowed read)']);
  });

  it('takes a read where the call gives write, and a job that asks for nothing', () => {
    expect(excess({contents: 'write'}, {contents: 'read'})).toEqual([]);
    expect(excess({contents: 'read'}, {})).toEqual([]);
  });

  it('reads read-all and write-all', () => {
    expect(excess('read-all', {issues: 'read'})).toEqual([]);
    expect(excess('read-all', {issues: 'write'})).toEqual(['issues: write (allowed read)']);
    expect(excess({contents: 'read'}, 'read-all')).toEqual(['*: read (allowed none)']);
    expect(excess('write-all', 'write-all')).toEqual([]);
  });
});

// A called workflow that calls another: what reaches its jobs is the narrowest on the chain.
describe('refusedJobs', () => {
  const leaf = {jobs: {report: {permissions: {contents: 'read', issues: 'write'}}}};

  it('checks a job two calls down against every call on the way', () => {
    const workflows = {'middle.yml': {jobs: {call: {uses: './.github/workflows/leaf.yml',
      permissions: {contents: 'read', issues: 'read'}}}}, 'leaf.yml': leaf};
    expect(refusedJobs(workflows, 'middle.yml', {contents: 'read', issues: 'write'}, 'top.yml job'))
        .toEqual(['top.yml job -> middle.yml call -> leaf.yml report: issues: write (allowed read)']);
  });

  it('passes the cap on through a calling job that names nothing of its own', () => {
    const workflows = {'middle.yml': {jobs: {call: {uses: './.github/workflows/leaf.yml'}}}, 'leaf.yml': leaf};
    expect(refusedJobs(workflows, 'middle.yml', {contents: 'read', issues: 'write'}, 'top.yml job')).toEqual([]);
    expect(refusedJobs(workflows, 'middle.yml', {contents: 'read'}, 'top.yml job'))
        .toEqual(['top.yml job -> middle.yml call -> leaf.yml report: issues: write (allowed none)']);
  });

  it('names the calling job that asks for more itself', () => {
    const workflows = {'middle.yml': {jobs: {call: {uses: './.github/workflows/leaf.yml',
      permissions: {contents: 'read', issues: 'write'}}}}, 'leaf.yml': leaf};
    expect(refusedJobs(workflows, 'middle.yml', {contents: 'read'}, 'top.yml job')).toEqual([
      'top.yml job -> middle.yml call: issues: write (allowed none)',
      'top.yml job -> middle.yml call -> leaf.yml report: issues: write (allowed none)',
    ]);
  });

  it('ends at a call back to a workflow on the chain, and names a missing one', () => {
    const workflows = {
      'a.yml': {jobs: {call: {uses: './.github/workflows/b.yml'}}},
      'b.yml': {jobs: {back: {uses: './.github/workflows/a.yml'}, gone: {uses: './.github/workflows/c.yml'}}},
    };
    expect(refusedJobs(workflows, 'a.yml', 'read-all', 'top.yml job'))
        .toEqual(['top.yml job -> a.yml call -> b.yml gone -> c.yml: no such workflow']);
  });
});

describe('calls to this repository\'s workflows', () => {
  const workflows = Object.fromEntries(fs.readdirSync(dir).filter((file) => /\.ya?ml$/.test(file))
      .map((file) => [file, load(file)]));
  const calls = Object.entries(workflows).flatMap(([file, workflow]) => Object.entries(workflow.jobs || {})
      .filter(([, job]) => typeof job.uses === 'string' && job.uses.startsWith('./.github/workflows/'))
      .map(([id, job]) => ({file, id, cap: job.permissions ?? workflow.permissions, uses: job.uses})));

  it('are there (runner-images.yml calls ci.yml)', () => {
    expect(calls.map(({file, id, uses}) => `${file} ${id} ${uses}`)).toEqual(expect.arrayContaining([
      'runner-images.yml latest ./.github/workflows/ci.yml',
      'runner-images.yml next ./.github/workflows/ci.yml',
    ]));
  });

  // Every job each call runs, and the jobs of any workflow those call in turn.
  it('give every called job what it asks for', () => {
    const refused = calls.flatMap(({file, id, cap, uses}) => {
      if (cap === undefined) return [`${file} ${id}: no permissions, so the repository default caps it`];
      return refusedJobs(workflows, path.basename(uses), cap, `${file} ${id}`);
    });
    expect(refused).toEqual([]);
  });
});
