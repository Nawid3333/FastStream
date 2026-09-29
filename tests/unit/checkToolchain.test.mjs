import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {latestLtsMajor, newestOfMajor, plan, projectNodeMajor, TITLE_PREFIX} from '../../tools/check-toolchain.mjs';

// The toolchain check opens and closes pull requests on these numbers; a wrong one either
// nags about a Node the project already uses or stays quiet about a new LTS.

describe('latestLtsMajor', () => {
  it('takes the newest major that has an LTS release, ignoring Current', () => {
    const index = [
      {version: 'v26.10.0', lts: false},
      {version: 'v24.21.0', lts: 'Krypton'},
      {version: 'v22.23.3', lts: 'Jod'},
      {version: 'v25.9.0', lts: false},
    ];
    expect(latestLtsMajor(index)).toBe(24);
  });
});

describe('projectNodeMajor', () => {
  it('is the lowest node-version in the workflows and .nvmrc', () => {
    const workflows = ['- uses: actions/setup-node@v7\n  with:\n    node-version: 24\n', 'node-version: "22"\n'];
    expect(projectNodeMajor([...workflows, '26\n'])).toBe(22);
    expect(projectNodeMajor(['node-version: 26', 'v26.10.0\n'])).toBe(26);
  });

  it('is null when nothing names a version', () => {
    expect(projectNodeMajor(['name: CI\n'])).toBeNull();
  });

  it('does not read node-version-file as a version', () => {
    expect(projectNodeMajor(['node-version-file: .nvmrc\n', '22\n'])).toBe(22);
  });
});

// A Node update is a pull request that changes .nvmrc alone, because the toolchain
// workflow's token may not push a workflow file. One setup-node that names its own
// version would keep the old Node after that pull request merged, and the check would
// still see the old major and never close it.
describe('every workflow takes Node from .nvmrc', () => {
  const dir = new URL('../../.github/workflows/', import.meta.url);
  const files = fs.readdirSync(dir).filter((file) => /\.ya?ml$/.test(file));

  it('names no version of its own', () => {
    for (const file of files) {
      const text = fs.readFileSync(new URL(file, dir), 'utf8');
      expect(text, file).not.toMatch(/^\s*node-version:/m);
    }
  });

  it('points every setup-node at .nvmrc', () => {
    let steps = 0;
    for (const file of files) {
      const text = fs.readFileSync(new URL(file, dir), 'utf8');
      // Each setup-node step, up to the next step, however its uses: line is written; and
      // every mention of the action is one of them.
      const found = [...text.matchAll(/uses:\s*['"]?actions\/setup-node@[^\n]*\n((?:(?!\s*- )[^\n]*\n)*)/g)];
      expect(found.length, `${file}: setup-node steps read`).toBe(text.match(/actions\/setup-node@/g)?.length ?? 0);
      for (const match of found) {
        steps++;
        expect(match[1], `${file}: a setup-node step`).toMatch(/^\s*node-version-file:\s*['"]?\.nvmrc['"]?\s*$/m);
      }
    }
    expect(steps).toBeGreaterThanOrEqual(9);
  });

  it('.nvmrc names a bare major', () => {
    expect(fs.readFileSync(new URL('../../.nvmrc', import.meta.url), 'utf8')).toMatch(/^\d+\n?$/);
  });
});

describe('newestOfMajor', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-09-29T12:00:00Z');
  const doc = {
    versions: {
      '11.26.0': {}, '11.27.1': {}, '11.28.0': {}, '11.29.0': {}, '11.30.0-rc.1': {},
      '11.27.2': {deprecated: 'broken'}, '12.6.0': {},
    },
    time: {
      '11.26.0': new Date(now - 30 * day).toISOString(),
      '11.27.1': new Date(now - 20 * day).toISOString(),
      '11.27.2': new Date(now - 19 * day).toISOString(),
      '11.28.0': new Date(now - 6 * day).toISOString(),
      '11.29.0': new Date(now - 2 * day).toISOString(),
      '11.30.0-rc.1': new Date(now - 10 * day).toISOString(),
      '12.6.0': new Date(now - 40 * day).toISOString(),
    },
  };

  it('takes the newest stable release of the major that is old enough', () => {
    expect(newestOfMajor(doc, 11, now, 5)).toBe('11.28.0');
    expect(newestOfMajor(doc, 11, now, 1)).toBe('11.29.0');
    expect(newestOfMajor(doc, 12, now, 5)).toBe('12.6.0');
  });

  it('compares versions as numbers, and skips deprecated ones and prereleases', () => {
    expect(newestOfMajor({versions: {'11.9.0': {}, '11.10.0': {}}, time: {'11.9.0': '2026-01-01', '11.10.0': '2026-01-02'}},
        11, now, 5)).toBe('11.10.0');
    expect(newestOfMajor(doc, 11, now - 18 * day, 1)).toBe('11.27.1');
  });

  it('is null when no release qualifies', () => {
    expect(newestOfMajor(doc, 13, now, 5)).toBeNull();
    expect(newestOfMajor(doc, 11, now, 60)).toBeNull();
  });
});

describe('plan', () => {
  const t = (rest) => `${TITLE_PREFIX}${rest}`;
  const node = (current, latest) => ({name: 'Node.js', current, latest, behind: Number(latest) > Number(current)});
  const pnpm = (current, latest, behind = latest !== current) => ({name: 'pnpm', current, latest, behind});

  it('raises what is behind and was never raised, and nothing else', () => {
    const updates = [node('22', '26'), pnpm('11.22.0', '11.28.0'), pnpm('11.22.0', '12.6.0', false)];
    const {raise, close} = plan(updates, [], new Set([t('Node.js 24')]));
    expect(raise.map((update) => update.title)).toEqual([t('Node.js 26'), t('pnpm 11.28.0')]);
    expect(close).toEqual([]);
  });

  it('never raises a title used before: closing one by hand skips it for good', () => {
    const updates = [node('22', '24'), pnpm('11.22.0', '11.28.0')];
    const {raise} = plan(updates, [], new Set([t('Node.js 24'), t('pnpm 11.28.0')]));
    expect(raise).toEqual([]);
  });

  it('closes an open one the project has caught up with', () => {
    const updates = [node('26', '26'), pnpm('11.28.0', '11.28.0')];
    const {close} = plan(updates, [{number: 11, title: t('Node.js 24')}, {number: 70, title: t('pnpm 11.28.0')}], new Set());
    expect(close.map((item) => item.number)).toEqual([11, 70]);
    expect(close[0].comment).toContain('now uses Node.js 26');
  });

  it('raises nothing when closing only, and a newer one that is not open replaces nothing', () => {
    const updates = [node('22', '26'), pnpm('11.22.0', '11.29.0')];
    const open = [{number: 11, title: t('Node.js 24')}, {number: 70, title: t('pnpm 11.28.0')}];
    const {raise, close} = plan(updates, open, new Set(open.map((item) => item.title)), {raising: false});
    expect(raise).toEqual([]);
    expect(close).toEqual([]);
    // An open newer one still replaces, and catching up still closes.
    const both = [...open, {number: 71, title: t('pnpm 11.29.0')}];
    expect(plan(updates, both, new Set(), {raising: false}).close.map((item) => item.number)).toEqual([70]);
    expect(plan([pnpm('11.28.0', '11.28.0')], open, new Set(), {raising: false}).close.map((item) => item.number)).toEqual([70]);
  });

  it('closes an open one a newer one on its track replaces, once that is raised or open', () => {
    const updates = [node('22', '26'), pnpm('11.22.0', '11.29.0')];
    const open = [{number: 11, title: t('Node.js 24')}, {number: 70, title: t('pnpm 11.28.0')}];
    const {raise, close} = plan(updates, open, new Set(open.map((item) => item.title)));
    expect(raise.map((update) => update.title)).toEqual([t('Node.js 26'), t('pnpm 11.29.0')]);
    expect(close.map((item) => item.number)).toEqual([11, 70]);
    expect(close[1].comment).toContain('pnpm 11.29.0');
  });

  it('keeps an open one whose replacement was skipped by hand', () => {
    const updates = [pnpm('11.22.0', '11.29.0')];
    const open = [{number: 70, title: t('pnpm 11.28.0')}];
    const {raise, close} = plan(updates, open, new Set([t('pnpm 11.28.0'), t('pnpm 11.29.0')]));
    expect(raise).toEqual([]);
    expect(close).toEqual([]);
  });

  it('keeps pnpm\'s two tracks apart', () => {
    // An open pnpm 12 pull request is not replaced by a newer 11.x, nor the other way round.
    const updates = [pnpm('11.22.0', '11.29.0'), pnpm('11.22.0', '12.6.0')];
    const open = [{number: 71, title: t('pnpm 12.6.0')}, {number: 70, title: t('pnpm 11.28.0')}];
    const {close} = plan(updates, open, new Set(open.map((item) => item.title)));
    expect(close.map((item) => item.number)).toEqual([70]);
    const newer = plan([pnpm('11.22.0', '11.28.0'), pnpm('11.22.0', '12.7.0')], open, new Set(open.map((item) => item.title)));
    expect(newer.close.map((item) => item.number)).toEqual([71]);
  });

  it('leaves alone a tool it no longer checks, and one still current', () => {
    const updates = [node('22', '22'), pnpm('11.22.0', '11.22.0')];
    const open = [{number: 5, title: t('Yarn 4.0.0')}, {number: 72, title: t('pnpm 11.28.0')}];
    expect(plan(updates, open, new Set()).close).toEqual([]);
  });
});
