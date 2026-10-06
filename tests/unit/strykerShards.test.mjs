import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import config, {AREAS, COMMAND_AREAS, PARTS, SHARDS, modulesOf, runnerOf, splitArea} from '../../stryker.config.mjs';

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
    expect(modulesOf('network-1')).toEqual(SHARDS['network-1']);
    // An area's name is no shard: its modules are in its parts.
    expect(() => modulesOf('network')).toThrow(/STRYKER_SHARD is network/);
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

  it('cuts each area into its parts, each module in one, none empty', () => {
    // One job an area ran out of its 240 minutes at 51-74% on CI, and no report came (#349).
    for (const [area, modules] of Object.entries(AREAS)) {
      const parts = Object.keys(SHARDS).filter((name) => name.startsWith(area + '-'));
      expect(parts).toHaveLength(PARTS[area]);
      expect(parts.flatMap((name) => SHARDS[name]).sort()).toEqual([...modules].sort());
      expect(parts.filter((name) => SHARDS[name].length === 0)).toEqual([]);
    }
  });

  it('makes parts of about the same size, the same ones each time', () => {
    const sizes = splitArea(AREAS.core, PARTS.core)
        .map((group) => group.reduce((sum, file) => sum + fs.statSync(path.join(root, file)).size, 0));
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(1.25);
    expect(splitArea(AREAS.core, PARTS.core)).toEqual(splitArea(AREAS.core, PARTS.core));
  });

  it('reports a shard that ran out of its time: it ends cancelled, not failed', () => {
    expect(workflow).toContain('needs.mutation.result == \'cancelled\'');
    expect(workflow).toContain('timeout-minutes: 350');
  });

  it('has the workflow run, and report, exactly these shards', () => {
    const names = Object.keys(SHARDS);
    expect(workflow).toContain(`shard: [${names.join(', ')}]`);
    expect(workflow).toContain(`for shard in ${names.join(' ')}; do`);
    expect(workflow).toContain('STRYKER_SHARD: ${{ matrix.shard }}');
  });
});

// The vitest runner switches a mutant on inside the test worker; the mpv host's message loop
// runs only in the host process its tests start, so the host keeps the command runner,
// which hands the mutant to that process. Compared mutant by mutant on CI (2026-10-06), the
// host was the one module the vitest runner left untested where the command runner caught.
describe('stryker.config.mjs: the test runner a shard gets', () => {
  it('runs the mpv host, alone, with the command runner and the whole suite a mutant', () => {
    expect(COMMAND_AREAS).toEqual(['host']);
    expect(AREAS.host).toEqual(['native-host/faststream-mpv-host.mjs']);
    expect(Object.values(AREAS).flat().filter((m) => m === 'native-host/faststream-mpv-host.mjs')).toHaveLength(1);
    const host = runnerOf('host-1');
    expect(host.testRunner).toBe('command');
    expect(host.coverageAnalysis).toBe('off');
    expect(host.commandRunner.command).toContain('vitest.mjs run');
  });

  it('runs every other shard, and a run of everything, with the vitest runner and per-test coverage', () => {
    for (const shard of [...Object.keys(SHARDS).filter((name) => !name.startsWith('host-')), undefined, '']) {
      const runner = runnerOf(shard);
      expect(runner.testRunner, String(shard)).toBe('vitest');
      expect(runner.coverageAnalysis).toBe('perTest');
      // Without it Stryker finds no runner under pnpm's layout.
      expect(runner.plugins).toEqual(['@stryker-mutator/vitest-runner']);
    }
    expect(config.testRunner).toBe(runnerOf(process.env.STRYKER_SHARD).testRunner);
  });
});
