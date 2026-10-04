import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import config, {SHARDS, modulesOf} from '../../stryker.config.mjs';

// The weekly mutation run's modules are in shards, each run by a job of its own
// (mutation-tests.yml), because all of them in one job were past its 240 minutes (#253).
// A module no shard lists is never mutated; a shard the workflow does not run is never
// reported; a module with no unit test can only "survive".

const root = path.resolve(import.meta.dirname, '../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/mutation-tests.yml'), 'utf8');

describe('stryker.config.mjs: the shards', () => {
  it('mutates every shard\'s modules when no shard is picked, as a local run does', () => {
    expect(config.mutate).toEqual(modulesOf(process.env.STRYKER_SHARD));
    expect(modulesOf(undefined)).toEqual(Object.values(SHARDS).flat());
    expect(modulesOf('')).toHaveLength(modulesOf(undefined).length);
  });

  it('runs one shard\'s modules, and refuses a shard it does not have', () => {
    expect(modulesOf('network')).toEqual(SHARDS.network);
    expect(() => modulesOf('everything')).toThrow(/STRYKER_SHARD is everything/);
  });

  it('lists each module once, each a file of the repository', () => {
    const all = modulesOf(undefined);
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((file) => !fs.existsSync(path.join(root, file)))).toEqual([]);
  });

  it('lists only modules a unit test imports', () => {
    const tests = fs.readdirSync(path.join(root, 'tests/unit'), {recursive: true})
        .filter((file) => file.endsWith('.mjs'))
        .map((file) => fs.readFileSync(path.join(root, 'tests/unit', file), 'utf8')).join('\n');
    const untested = modulesOf(undefined).filter((file) => !tests.includes(path.basename(file)));
    expect(untested).toEqual([]);
  });

  it('has the workflow run, and report, exactly these shards', () => {
    const names = Object.keys(SHARDS);
    expect(workflow).toContain(`shard: [${names.join(', ')}]`);
    expect(workflow).toContain(`for shard in ${names.join(' ')}; do`);
    expect(workflow).toContain('STRYKER_SHARD: ${{ matrix.shard }}');
  });
});
