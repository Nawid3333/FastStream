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

describe('calls to this repository\'s workflows', () => {
  const calls = fs.readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)).flatMap((file) => {
    const workflow = load(file);
    return Object.entries(workflow.jobs || {})
        .filter(([, job]) => typeof job.uses === 'string' && job.uses.startsWith('./.github/workflows/'))
        .map(([id, job]) => ({file, id, cap: job.permissions ?? workflow.permissions, uses: job.uses}));
  });

  it('are there (runner-images.yml calls ci.yml)', () => {
    expect(calls.map(({file, id, uses}) => `${file} ${id} ${uses}`)).toEqual(expect.arrayContaining([
      'runner-images.yml latest ./.github/workflows/ci.yml',
      'runner-images.yml next ./.github/workflows/ci.yml',
    ]));
  });

  // One level deep: no called workflow calls another. If one did, its own calls would be
  // capped by what reaches it, not by what it declares.
  it('give every called job what it asks for', () => {
    const refused = calls.flatMap(({file, id, cap, uses}) => {
      if (cap === undefined) return [`${file} ${id}: no permissions, so the repository default caps it`];
      const called = load(path.basename(uses));
      return Object.entries(called.jobs).flatMap(([calledId, job]) => {
        const request = job.permissions ?? called.permissions;
        // A job that asks for nothing of its own takes the cap.
        if (request === undefined) return [];
        return excess(cap, request).map((scope) => `${file} ${id} -> ${path.basename(uses)} ${calledId}: ${scope}`);
      });
    });
    expect(refused).toEqual([]);
  });
});
