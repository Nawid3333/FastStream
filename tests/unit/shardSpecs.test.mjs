import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as url from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {parseShard, shardSpecs, splitByWeight, WEIGHTS} from '../e2e/shardSpecs.mjs';

// E2E_SHARD: CI runs each e2e suite in groups of about the same running time, one job a
// group (ci.yml). A spec file in no group would never run; one in two would run twice.

const e2e = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../e2e');
const SUITES = ['specs', 'ext-specs', 'classic-specs'];
const specFiles = (dir) => fs.readdirSync(path.join(e2e, dir), {recursive: true})
    .map((file) => String(file).replaceAll('\\', '/')).filter((file) => file.endsWith('.e2e.mjs'));
let tmp;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, {recursive: true, force: true});
  tmp = undefined;
});

describe('parseShard', () => {
  it('is null without E2E_SHARD', () => {
    expect(parseShard(undefined)).toBeNull();
    expect(parseShard('')).toBeNull();
  });

  it('reads <i>/<n>', () => {
    expect(parseShard('2/3')).toEqual({index: 2, total: 3});
    expect(parseShard('1/1')).toEqual({index: 1, total: 1});
  });

  it.each(['0/3', '4/3', '3', 'a/b', '1/0', ' 1/2', '1/2/3', '-1/2'])('refuses %j', (value) => {
    expect(() => parseShard(value)).toThrow(/E2E_SHARD/);
  });
});

describe('splitByWeight', () => {
  // Names not in weight order, so an order by name would give other groups.
  const weights = {a: 1, b: 9, c: 8, d: 7, e: 10};

  it('puts each file in exactly one group', () => {
    const groups = splitByWeight(Object.keys(weights), 3, (f) => weights[f]);
    expect(groups.flat().sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('gives the next heaviest file to the lightest group', () => {
    // e (10) and b (9) start the groups; c (8) joins b's, the lighter; d (7) joins e's;
    // a (1) meets 17 and 17 and takes the earlier group.
    expect(splitByWeight(Object.keys(weights), 2, (f) => weights[f])).toEqual([
      ['a', 'd', 'e'], // 1 + 7 + 10
      ['b', 'c'], // 9 + 8
    ]);
  });

  it('is the same for the same files in any order', () => {
    const one = splitByWeight(['e', 'c', 'a', 'd', 'b'], 2, (f) => weights[f]);
    const two = splitByWeight(['b', 'a', 'e', 'd', 'c'], 2, (f) => weights[f]);
    expect(one).toEqual(two);
  });

  it('breaks a tie by name', () => {
    expect(splitByWeight(['y', 'x'], 2, () => 5)).toEqual([['x'], ['y']]);
  });
});

describe('shardSpecs', () => {
  it('keeps the suite\'s glob without E2E_SHARD', () => {
    expect(shardSpecs(path.join(e2e, 'specs'), undefined)).toEqual([path.join(e2e, 'specs', '**/*.e2e.mjs')]);
  });

  describe.each(SUITES)('%s', (suite) => {
    const all = specFiles(suite).map((file) => path.join(e2e, suite, file)).sort();

    it.each([2, 3])('runs every spec file once over %i groups', (total) => {
      const groups = Array.from({length: total}, (_, i) => shardSpecs(path.join(e2e, suite), `${i + 1}/${total}`));
      expect(groups.every((group) => group.length > 0)).toBe(true);
      expect(groups.flat().sort()).toEqual(all);
    });

    it('makes groups of about the same time, by the weights', () => {
      // WebdriverIO's --shard, slices of the same number of files, gave 527 s and 402 s on
      // Windows (CI run 37382065299); these stay within a fifth of each other.
      const time = (group) => group.reduce((sum, file) =>
        sum + (WEIGHTS[path.relative(e2e, file).replaceAll('\\', '/')] ?? 20), 0);
      const times = [1, 2, 3].map((i) => time(shardSpecs(path.join(e2e, suite), `${i}/3`)));
      expect(Math.max(...times) / Math.min(...times)).toBeLessThan(1.2);
    });
  });

  it('counts a spec file without a weight as the median', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-'));
    const dir = path.join(tmp, 'suite');
    fs.mkdirSync(dir);
    for (const name of ['heavy', 'light', 'new']) fs.writeFileSync(path.join(dir, `${name}.e2e.mjs`), '');
    fs.writeFileSync(path.join(dir, 'helper.mjs'), '');
    const prefix = path.relative(e2e, dir).replaceAll('\\', '/');
    const weights = {[`${prefix}/heavy.e2e.mjs`]: 100, [`${prefix}/light.e2e.mjs`]: 1, other: 50};
    // Median of 1, 50, 100 is 50: new (50) joins light (1), not heavy (100).
    expect(shardSpecs(dir, '1/2', weights)).toEqual([path.join(dir, 'heavy.e2e.mjs')]);
    expect(shardSpecs(dir, '2/2', weights)).toEqual([path.join(dir, 'light.e2e.mjs'), path.join(dir, 'new.e2e.mjs')]);
  });

  it('refuses more groups than spec files (WebdriverIO fails a run with none)', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-'));
    fs.writeFileSync(path.join(tmp, 'only.e2e.mjs'), '');
    expect(() => shardSpecs(tmp, '2/2', {})).toThrow(/only 1 spec file/);
  });
});

describe('specWeights.json', () => {
  it('names only spec files that exist', () => {
    const existing = new Set(SUITES.flatMap((suite) => specFiles(suite).map((file) => `${suite}/${file}`)));
    expect(Object.keys(WEIGHTS).filter((key) => !existing.has(key))).toEqual([]);
  });

  it('holds seconds', () => {
    expect(Object.values(WEIGHTS).every((s) => Number.isInteger(s) && s > 0)).toBe(true);
  });
});
