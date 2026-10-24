import {createHash} from 'node:crypto';
import fs from 'node:fs';
// js-yaml 5 has no default export, only named ones; this form reads 4 and 5 alike.
import * as yaml from 'js-yaml';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  aboveHold, addonVersion, applyAddon, applyPlayers, getJson, holdProblem, latestLtsMajor, MAJOR_HOLDS, MIN_AGE_DAYS,
  newestAddon, newestOfMajor, pinCandidates, plan, PLAYER_LIBRARIES, playerState, playerTargets, projectNodeMajor, relation,
  TITLE_PREFIX, UBLOCK,
} from '../../tools/check-toolchain.mjs';
import {ADDONS} from '../../tools/setup-dev-profile.mjs';

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

// A tool pinned in a form Dependabot does not update stays on its version, and nobody
// hears of it: the actionlint image (a docker:// line in ci.yml) did until it moved to
// .github/actionlint/Dockerfile, and the composite actions' pins would have without
// their own directory in .github/dependabot.yml.
describe('every pinned tool is one Dependabot updates', () => {
  const root = new URL('../../', import.meta.url);
  const read = (path) => fs.readFileSync(new URL(path, root), 'utf8');
  const workflows = fs.readdirSync(new URL('.github/workflows/', root))
      .filter((file) => /\.ya?ml$/.test(file)).map((file) => `.github/workflows/${file}`);
  const actions = fs.readdirSync(new URL('.github/actions/', root), {withFileTypes: true})
      .filter((entry) => entry.isDirectory()).map((entry) => `.github/actions/${entry.name}/action.yml`);
  const dependabot = read('.github/dependabot.yml');
  // One ecosystem's entry, up to the next one.
  const entry = (ecosystem) => dependabot.split(/^ {2}- package-ecosystem: /m)
      .find((part) => part.startsWith(`'${ecosystem}'`)) ?? '';

  it('pins every action to a commit, with its version beside it', () => {
    let pins = 0;
    for (const file of [...workflows, ...actions]) {
      for (const [, ref] of read(file).matchAll(/^ *(?:- )?uses: *(.*)$/gm)) {
        if (ref.startsWith('./')) continue; // this repository's own action or workflow
        pins++;
        expect(ref, file).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/);
      }
    }
    expect(pins).toBeGreaterThanOrEqual(40);
  });

  it('runs no docker:// image, and no job container or service image', () => {
    // Dependabot updates none of these in a workflow.
    for (const file of [...workflows, ...actions]) {
      expect(read(file), file).not.toMatch(/^ *(?:- )?uses: *['"]?docker:/m);
      expect(read(file), file).not.toMatch(/^ +(?:container|services):/m);
    }
  });

  it('names the shipped libraries the way update-prs.yml reads them', () => {
    // update-prs.yml tells a shipped library's major by the patterns of the
    // shipped-minor-and-patch group: awk takes the first patterns: line after the group's
    // key and the quoted names on it. Another layout (a block list, globs) would leave it
    // with none, and every shipped major would wait as if it were tooling.
    const lines = read('.github/dependabot.yml').split('\n');
    const at = lines.findIndex((line) => /^\s*shipped-minor-and-patch:\s*$/.test(line));
    expect(at).toBeGreaterThan(-1);
    const patterns = lines.slice(at + 1).find((line) => /^\s*patterns:/.test(line));
    expect(patterns).toMatch(/^\s+patterns: \['[^'*]+'(, '[^'*]+')*\]$/);
    const pkg = JSON.parse(read('package.json'));
    const deps = {...pkg.dependencies, ...pkg.devDependencies};
    for (const [, name] of patterns.matchAll(/'([^']+)'/g)) expect(deps, name).toHaveProperty([name]);
  });

  it('calls an actionlint or zizmor image update ready only when it changes nothing but their Dockerfiles', () => {
    // CI runs every workflow file through the new image, and update-prs.yml calls the pull
    // request ready to merge once that is green and is all it changes.
    const gate = read('.github/workflows/update-prs.yml');
    expect(gate).toMatch(/^ +dependabot\/docker\/\*\) kind=docker ;;$/m);
    expect(gate).toContain('select(. != ".github/actionlint/Dockerfile" and . != ".github/zizmor/Dockerfile")');
  });

  it('has Dependabot watch the workflows and every composite action', () => {
    const github = entry('github-actions');
    expect(github).toMatch(/^ +- '\/'$/m);
    expect(github).toMatch(/^ +- '\/\.github\/actions\/\*'$/m);
    expect(actions.length).toBeGreaterThan(0);
    for (const file of actions) expect(fs.existsSync(new URL(file, root)), file).toBe(true);
  });

  it('pins the actionlint image by tag and digest where Dependabot updates it', () => {
    const from = read('.github/actionlint/Dockerfile').split('\n').filter((line) => /^FROM\b/i.test(line));
    expect(from).toEqual([expect.stringMatching(/^FROM rhysd\/actionlint:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/)]);
    expect(entry('docker')).toMatch(/^ +- '\/\.github\/actionlint'$/m);
    // Both readers of the pin read it from there.
    expect(read('.github/workflows/ci.yml')).toContain('sed -n \'s/^FROM //p\' .github/actionlint/Dockerfile');
    expect(read('tools/linux/setup.sh')).toContain('"$repo/.github/actionlint/Dockerfile"');
  });

  it('pins the zizmor image by tag and digest where Dependabot updates it', () => {
    const from = read('.github/zizmor/Dockerfile').split('\n').filter((line) => /^FROM\b/i.test(line));
    expect(from).toEqual([expect.stringMatching(/^FROM ghcr\.io\/zizmorcore\/zizmor:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/)]);
    expect(entry('docker')).toMatch(/^ +- '\/\.github\/zizmor'$/m);
    expect(read('.github/workflows/ci.yml')).toContain('sed -n \'s/^FROM //p\' .github/zizmor/Dockerfile');
  });
});

// The owner's call of 2026-10-20: a release waits 3 days before it is proposed, wherever the
// update comes from. Dependabot's cooldown, update-prs.yml's lockfile check, the toolchain's
// MIN_AGE_DAYS and zizmor's audit name the same number, or one of them lets a younger release
// through. (zizmor flags a cooldown shorter than its setting, not an entry without one:
// checked with zizmor 1.30.1.)
describe('one release wait everywhere', () => {
  const root = new URL('../../', import.meta.url);
  const read = (path) => fs.readFileSync(new URL(path, root), 'utf8');

  it('is 3 days', () => {
    expect(MIN_AGE_DAYS).toBe(3);
  });

  it('in every entry of .github/dependabot.yml', () => {
    const {updates} = yaml.load(read('.github/dependabot.yml'));
    expect(updates.length).toBeGreaterThanOrEqual(4);
    for (const update of updates) {
      const name = `${update['package-ecosystem']} ${update.directory ?? update.directories}`;
      expect(update.cooldown, name).toEqual({'default-days': MIN_AGE_DAYS});
    }
  });

  it('in zizmor\'s audit of it', () => {
    expect(yaml.load(read('.github/zizmor.yml')).rules['dependabot-cooldown']).toEqual({config: {days: MIN_AGE_DAYS}});
  });

  it('in update-prs.yml\'s lockfile check, and when it decides again', () => {
    const gate = read('.github/workflows/update-prs.yml');
    expect(gate).toContain(`cutoff=$(date -u -d '${MIN_AGE_DAYS} days ago' +%s)`);
    expect(gate).toContain(`recheck=$((newest + ${MIN_AGE_DAYS} * 24 * 60 * 60))`);
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

  // A pnpm release is tried once it is MIN_AGE_DAYS (3) old: 11.29.0 is 2 days old.
  it('waits MIN_AGE_DAYS by default', () => {
    expect(newestOfMajor(doc, 11, now)).toBe('11.28.0');
    expect(newestOfMajor(doc, 11, now + day)).toBe('11.29.0');
  });

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

  it('gives uBlock Origin one track: a newer release replaces an open one, catching up closes it', () => {
    const ublock = (current, latest) => ({name: 'uBlock Origin', current, latest, behind: latest !== current});
    const open = [{number: 80, title: t('uBlock Origin 1.75.1')}];
    const file = {url: 'https://addons.mozilla.org/firefox/downloads/file/1/ublock_origin-1.76.0.xpi', sha256: 'a'.repeat(64)};
    const {raise, close} = plan([{...ublock('1.75.0', '1.76.0'), file}], open, new Set([open[0].title]));
    expect(raise.map((update) => update.title)).toEqual([t('uBlock Origin 1.76.0')]);
    // The recipe takes the file from the raised entry.
    expect(raise[0].file).toEqual(file);
    expect(close).toEqual([{number: 80, comment: 'Superseded by uBlock Origin 1.76.0, which has its own pull request.'}]);
    expect(plan([ublock('1.75.1', '1.75.1')], open, new Set()).close[0].comment).toBe('The project now uses uBlock Origin 1.75.1. Closing.');
    // Its next major is no second track, as pnpm's is: 2.0.0 replaces an open 1.x.
    expect(plan([ublock('1.75.0', '2.0.0')], open, new Set([open[0].title])).close.map((item) => item.number)).toEqual([80]);
  });
});

describe('uBlock Origin on AMO', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-10-24T12:00:00Z');
  const hash = (c) => `sha256:${c.repeat(64)}`;
  const release = (version, daysOld, file = {}) => ({version, channel: 'listed', file: {
    created: new Date(now - daysOld * day).toISOString(), status: 'public', hash: hash('a'),
    url: `https://addons.mozilla.org/firefox/downloads/file/${version.replace(/\D/g, '')}/ublock_origin-${version}.xpi`, ...file}});

  it('takes the newest public listed release that is MIN_AGE_DAYS old, with its file and SHA-256', () => {
    const page = {results: [release('1.77.0', 1), release('1.76.0', 4), release('1.75.0', 30)]};
    expect(newestAddon(page, now)).toEqual({version: '1.76.0', sha256: 'a'.repeat(64),
      url: 'https://addons.mozilla.org/firefox/downloads/file/1760/ublock_origin-1.76.0.xpi'});
    expect(newestAddon(page, now + 2 * day).version).toBe('1.77.0');
    expect(MIN_AGE_DAYS).toBe(3);
  });

  it('compares versions as numbers, whatever order AMO lists them in', () => {
    expect(newestAddon({results: [release('1.9.0', 10), release('1.10.0', 9)]}, now).version).toBe('1.10.0');
  });

  it('skips what is not a public listed release with a plain AMO download', () => {
    const bad = [
      {...release('1.80.0', 10), channel: 'unlisted'},
      release('1.81.0', 10, {status: 'disabled'}),
      release('1.82.0b3', 10),
      release('1.83.0', 10, {hash: 'sha1:abc'}),
      release('1.84.0', 10, {url: 'https://example.com/ublock_origin-1.84.0.xpi'}),
      release('1.85.0', 10, {url: 'https://addons.mozilla.org/firefox/downloads/file/1/x%27.xpi'}),
      release('1.86.0', 10, {created: undefined}),
    ];
    expect(newestAddon({results: [...bad, release('1.75.0', 30)]}, now).version).toBe('1.75.0');
    expect(newestAddon({results: bad}, now)).toBeNull();
    expect(newestAddon({}, now)).toBeNull();
  });
});

describe('uBlock Origin in tools/setup-dev-profile.mjs', () => {
  const text = fs.readFileSync('tools/setup-dev-profile.mjs', 'utf8');
  const next = {version: '1.76.0', url: 'https://addons.mozilla.org/firefox/downloads/file/5100000/ublock_origin-1.76.0.xpi',
    sha256: 'b'.repeat(64)};

  it('reads the version the profile installs', () => {
    expect(addonVersion(text, UBLOCK.id)).toBe(ADDONS.find((addon) => addon.id === UBLOCK.id)?.version);
  });

  it('replaces its version, url and sha256, and nothing else', () => {
    const {text: written, was} = applyAddon(text, UBLOCK.id, next);
    expect(was).toBe(addonVersion(text, UBLOCK.id));
    expect(addonVersion(written, UBLOCK.id)).toBe('1.76.0');
    const changed = (a, b) => a.split('\n').filter((line, i) => line !== b.split('\n')[i]);
    expect(written.split('\n')).toHaveLength(text.split('\n').length);
    expect(changed(written, text)).toEqual([
      '    version: \'1.76.0\',',
      `    url: '${next.url}',`,
      `    sha256: '${'b'.repeat(64)}',`,
    ]);
  });

  it('finds the entry by its id wherever it is, and touches no other add-on', () => {
    const other = `  {\n    id: 'other@example.com',\n    version: '2.0.0',\n    url: 'https://example.com/o.xpi',\n    sha256: '${'c'.repeat(64)}',\n  },\n`;
    const two = text.replace('export const ADDONS = [\n', `export const ADDONS = [\n${other}`);
    const {text: written} = applyAddon(two, UBLOCK.id, next);
    expect(written).toContain(other);
    expect(addonVersion(written, 'other@example.com')).toBe('2.0.0');
  });

  it('refuses an entry it cannot find once, and a release that is not plainly one', () => {
    expect(() => applyAddon(text, 'nobody@example.com', next)).toThrow(/nowhere/);
    const entry = /\n {2}\{\n[^]*?\n {2}\},\n/.exec(text)?.[0] || '';
    expect(entry).toContain(UBLOCK.id);
    expect(() => applyAddon(text.replace(entry, entry + entry.slice(1)), UBLOCK.id, next)).toThrow(/more than once/);
    expect(() => applyAddon(text, UBLOCK.id, {...next, version: '1.76.0\''})).toThrow(/not a release/);
    expect(() => applyAddon(text, UBLOCK.id, {...next, url: 'https://evil.example/x.xpi'})).toThrow(/not a release/);
    expect(() => applyAddon(text, UBLOCK.id, {...next, sha256: 'B'.repeat(64)})).toThrow(/not a release/);
  });

  it('is not misled by a brace or the id in a comment', () => {
    // A `}` in a comment inside the entry, and the id named in a comment above the array.
    const commented = text
        .replace(`    id: '${UBLOCK.id}',\n`, `    id: '${UBLOCK.id}',\n    // moved on from } the old pin\n`)
        .replace('export const ADDONS = [\n', `// was: id: '${UBLOCK.id}', {\nexport const ADDONS = [\n`);
    const {text: written, was} = applyAddon(commented, UBLOCK.id, next);
    expect(was).toBe(addonVersion(text, UBLOCK.id));
    expect(written).toContain('    // moved on from } the old pin\n');
    expect(written).toContain(`// was: id: '${UBLOCK.id}', {\n`);
    expect(addonVersion(written, UBLOCK.id)).toBe('1.76.0');
  });

  it('refuses an entry written another way, rather than guess', () => {
    expect(() => applyAddon(text.replace(/version: '([^']*)'/, 'version: "$1"'), UBLOCK.id, next)).toThrow(/0 version lines/);
  });
});

describe('getJson', () => {
  const answer = (status, body = '{"ok": true}') => new Response(body, {status});
  const wait = vi.fn(async () => {});
  afterEach(() => {
    vi.unstubAllGlobals();
    wait.mockClear();
  });

  it('asks again after no answer, a 5xx, a 429 or an answer that is not JSON', async () => {
    const fetch = vi.fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(answer(503))
        .mockResolvedValueOnce(answer(200, '{"ok": tr'));
    vi.stubGlobal('fetch', fetch);
    await expect(getJson('https://example.com/a', {wait})).rejects.toThrow(/JSON/);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[5000], [10000]]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(answer(429)).mockResolvedValueOnce(answer(200)));
    await expect(getJson('https://example.com/a', {wait})).resolves.toEqual({ok: true});
  });

  it('does not ask again after a 404, and names the URL and status', async () => {
    const fetch = vi.fn().mockResolvedValue(answer(404));
    vi.stubGlobal('fetch', fetch);
    await expect(getJson('https://example.com/b', {wait})).rejects.toThrow('https://example.com/b: HTTP 404');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after three tries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(502)));
    await expect(getJson('https://example.com/c', {wait})).rejects.toThrow('https://example.com/c: HTTP 502');
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('asks with a time limit', async () => {
    const fetch = vi.fn().mockResolvedValue(answer(200));
    vi.stubGlobal('fetch', fetch);
    await getJson('https://example.com/d', {wait});
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

// The player libraries the live suite plays: the set the rolling pull request offers.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-01T00:00:00.000Z');

/**
 * Registry doc with terse entries; `age` is days published before `atNow`
 * (default 30 clears every MIN_AGE_DAYS check; 1 day never does).
 * @typedef {{ dependencies?: Record<string, string>, peerDependencies?: Record<string, string>, deprecated?: boolean | string }} DocVersion
 * @typedef {{ versions: Record<string, DocVersion>, time: Record<string, string> }} Doc
 * @param {number} atNow
 * @param {Record<string, { age?: number, deprecated?: boolean, deps?: Record<string, string>, peer?: Record<string, string> }>} entries
 * @return {Doc}
 */
function docOf(atNow, entries) {
  /** @type {Doc} */
  const doc = {versions: {}, time: {}};
  for (const [version, entry] of Object.entries(entries)) {
    /** @type {DocVersion} */
    const record = {};
    if (entry.deps) record.dependencies = entry.deps;
    if (entry.peer) record.peerDependencies = entry.peer;
    if (entry.deprecated) record.deprecated = 'unmaintained';
    doc.versions[version] = record;
    doc.time[version] = new Date(atNow - (entry.age ?? 30) * DAY_MS).toISOString();
  }
  return doc;
}

describe('relation', () => {
  // version, range, verdict ÔÇö one row per listed form and verdict
  /** @type {[string, string, string][]} */
  const cases = [
    // exact, '=', 'v'
    ['1.2.3', '1.2.3', 'in'],
    ['1.2.2', '1.2.3', 'below'],
    ['1.2.4', '1.2.3', 'above'],
    ['1.2.3', '=1.2.3', 'in'],
    ['1.3.0', '=1.2.3', 'above'],
    ['1.2.3', 'v1.2.3', 'in'],
    ['1.2.3', '=v1.2.3', 'in'],
    // caret, full
    ['1.5.0', '^1.2.3', 'in'],
    ['1.2.2', '^1.2.3', 'below'],
    ['2.0.0', '^1.2.3', 'above'],
    ['0.3.6', '^0.3.5', 'in'],
    ['0.3.4', '^0.3.5', 'below'],
    ['0.4.0', '^0.3.5', 'above'],
    ['0.0.4', '^0.0.4', 'in'],
    ['0.0.5', '^0.0.4', 'above'],
    ['0.0.3', '^0.0.4', 'below'],
    // caret, short
    ['1.9.0', '^1.2', 'in'],
    ['1.0.0', '^1.2', 'below'],
    ['1.5.0', '^1', 'in'],
    ['2.0.0', '^1', 'above'],
    ['0.3.9', '^0.3', 'in'],
    ['0.4.0', '^0.3', 'above'],
    // tilde
    ['1.2.9', '~1.2.3', 'in'],
    ['1.2.2', '~1.2.3', 'below'],
    ['1.3.0', '~1.2.3', 'above'],
    ['1.2.0', '~1.2', 'in'],
    ['1.1.0', '~1.2', 'below'],
    ['1.3.0', '~1.2', 'above'],
    ['1.5.0', '~1', 'in'],
    ['2.0.0', '~1', 'above'],
    // comparators
    ['1.2.3', '>=1.2.3', 'in'],
    ['1.2.2', '>=1.2.3', 'below'],
    ['1.2.4', '>1.2.3', 'in'],
    ['1.2.3', '>1.2.3', 'below'],
    ['1.9.9', '<2.0.0', 'in'],
    ['2.0.0', '<2.0.0', 'above'],
    ['2.0.0', '<=2.0.0', 'in'],
    ['2.0.1', '<=2.0.0', 'above'],
    // space-separated AND
    ['1.5.0', '>=1.2.3 <2.0.0', 'in'],
    ['1.2.2', '>=1.2.3 <2.0.0', 'below'],
    ['2.0.0', '>=1.2.3 <2.0.0', 'above'],
    ['1.5.0', '>1.2.3 <=2.0.0', 'in'],
    ['1.5.0', '>=1.0.0 latest', 'unknown'],
    // x, wildcard, bare partial
    ['1.5.0', '1.x', 'in'],
    ['2.0.0', '1.x', 'above'],
    ['0.9.9', '1.x', 'below'],
    ['1.2.5', '1.2.x', 'in'],
    ['1.1.9', '1.2.x', 'below'],
    ['1.3.0', '1.2.x', 'above'],
    ['1.5.0', '1', 'in'],
    ['2.0.0', '1', 'above'],
    ['0.9.0', '1', 'below'],
    ['0.0.1', '*', 'in'],
    ['7.7.7', '', 'in'],
    // '||' alternatives
    ['1.2.3', '1.2.3 || 3.4.5', 'in'],
    ['3.4.5', '1.2.3 || 3.4.5', 'in'],
    ['3.9.0', '1.2.3 || 3.4.5', 'above'],
    ['1.0.0', '1.2.3 || 3.4.5', 'below'],
    ['2.0.0', '1.2.3 || 3.4.5', 'unknown'],
    ['1.5.0', '^1.2.0 || ^2.0.0', 'in'],
    ['2.5.0', '^1.2.0 || ^2.0.0', 'in'],
    ['3.0.0', '^1.2.0 || ^2.0.0', 'above'],
    ['4.0.0', '>=1.2.3 <2.0.0 || >=3.0.0', 'in'],
    ['2.5.0', '>=1.2.3 <2.0.0 || >=3.0.0', 'unknown'],
    // unreadable
    ['1.0.0', 'latest', 'unknown'],
    ['1.0.0', 'workspace:*', 'unknown'],
    ['1.0.0', 'npm:x@^1.0.0', 'unknown'],
    ['1.0.0', 'https://example.com/x.tgz', 'unknown'],
    ['1.0.0', 'git+ssh://example.com/x.git', 'unknown'],
    ['1.0.0', '1.2.3 - 1.4.0', 'unknown'],
    ['1.0.0', '>=latest', 'unknown'],
    ['1.0.0-rc.0', '<2.0.0', 'unknown'],
    // A partial bound stands for all it names, as npm reads it: >1.2 is >=1.3.0, <=1.2 is <1.3.0.
    ['1.2.5', '>1.2', 'below'],
    ['1.3.0', '>1.2', 'in'],
    ['1.9.9', '>1', 'below'],
    ['2.0.0', '>1', 'in'],
    ['0.4.5', '>0.4', 'below'],
    ['1.2.9', '<=1.2', 'in'],
    ['1.3.0', '<=1.2', 'above'],
    ['1.5.0', '<=1', 'in'],
    ['2.0.0', '<=1', 'above'],
    ['1.2.0', '>=1.2', 'in'],
    ['1.1.9', '>=1.2', 'below'],
    ['1.1.9', '<1.2', 'in'],
    ['1.2.0', '<1.2', 'above'],
    // Mixed sides in one AND: above wins, as the code reads it.
    ['1.9.0', '1.2.x >=2.0.0', 'above'],
    // ^0, a caret that cannot be read, numbers of more than one digit, a v on a bound.
    ['0.9.9', '^0', 'in'],
    ['1.0.0', '^0', 'above'],
    ['1.0.0', '^latest', 'unknown'],
    ['1.0.0', '~workspace:*', 'unknown'],
    ['15.0.0', '^12.0.0', 'above'],
    ['12.10.0', '^12.9.0', 'in'],
    ['1.0.0', '>=10.0.0', 'below'],
    ['1.5.0', '^v1.2.3', 'in'],
    ['1.2.2', '>=v1.2.3', 'below'],
  ];
  it.each(cases)('%s vs %s is %s', (version, range, verdict) => {
    expect(relation(version, range)).toBe(verdict);
  });
});

describe('pinCandidates, more', () => {
  it('lists the candidates newest first, as numbers', () => {
    const doc = docOf(NOW, {'1.4.0': {}, '1.5.0': {}, '1.10.0': {}, '1.6.0': {}});
    expect(pinCandidates(doc, '1.4.0', NOW)).toEqual(['1.10.0', '1.6.0', '1.5.0', '1.4.0']);
  });

  it('takes a release exactly MIN_AGE_DAYS old, and a younger one with a shorter wait', () => {
    const doc = docOf(NOW, {'1.4.0': {}, '1.4.1': {age: MIN_AGE_DAYS}, '1.4.2': {age: 1}});
    expect(pinCandidates(doc, '1.4.0', NOW)).toEqual(['1.4.1', '1.4.0']);
    expect(pinCandidates(doc, '1.4.0', NOW, 1)).toEqual(['1.4.2', '1.4.1', '1.4.0']);
  });
});

describe('playerTargets, more', () => {
  it('ignores a range on a package outside the set', () => {
    const docs = {plyr: docOf(NOW, {'3.8.5': {}, '3.9.0': {deps: {lodash: '^4.17.0'}}})};
    expect(playerTargets({plyr: '3.8.5'}, docs, {}, NOW).target).toEqual({plyr: '3.9.0'});
  });

  it('steps down the library that is too new, not the one that declares the range', () => {
    const docs = {
      a: docOf(NOW, {'1.0.0': {peer: {b: '1.0.0'}}, '1.1.0': {peer: {b: '1.0.0'}}}),
      b: docOf(NOW, {'1.0.0': {}, '1.1.0': {}}),
    };
    const set = playerTargets({a: '1.0.0', b: '1.0.0'}, docs, {}, NOW);
    expect(set.target).toEqual({a: '1.1.0', b: '1.0.0'});
    expect(set.held).toEqual([{name: 'b', version: '1.0.0', newest: '1.1.0'}]);
  });

  it('steps down the library that needs a newer one, not the one it needs', () => {
    const docs = {
      a: docOf(NOW, {'1.0.0': {}, '1.2.0': {deps: {b: '>=2.0.0'}}}),
      b: docOf(NOW, {'1.0.0': {}, '1.9.0': {}}),
    };
    const set = playerTargets({a: '1.0.0', b: '1.0.0'}, docs, {}, NOW);
    expect(set.target).toEqual({a: '1.0.0', b: '1.9.0'});
    expect(set.held).toEqual([{name: 'a', version: '1.0.0', newest: '1.2.0'}]);
  });

  it('reads a peer range over a dependency range on the same package', () => {
    const docs = {
      'xgplayer': docOf(NOW, {'3.0.26': {}, '3.0.27': {}}),
      'xgplayer-hls': docOf(NOW, {'3.0.26': {}, '3.0.27': {deps: {xgplayer: '3.0.26'}, peer: {xgplayer: '^3.0.26'}}}),
    };
    expect(playerTargets({'xgplayer': '3.0.26', 'xgplayer-hls': '3.0.26'}, docs, {}, NOW).target)
        .toEqual({'xgplayer': '3.0.27', 'xgplayer-hls': '3.0.27'});
  });

  it('passes its wait on', () => {
    const docs = {plyr: docOf(NOW, {'3.8.5': {}, '3.8.6': {age: 1}})};
    expect(playerTargets({plyr: '3.8.5'}, docs, {}, NOW).target).toEqual({plyr: '3.8.5'});
    expect(playerTargets({plyr: '3.8.5'}, docs, {}, NOW, 1).target).toEqual({plyr: '3.8.6'});
  });

  it('keeps a name such as __proto__ a name, never a prototype', () => {
    // JSON.parse makes "__proto__" an own key, as a file or the registry could.
    const pins = JSON.parse('{"__proto__": "1.0.0"}');
    const docs = JSON.parse(`{"__proto__": ${JSON.stringify(docOf(NOW, {'1.0.0': {}, '1.0.1': {}}))}}`);
    const set = playerTargets(pins, docs, {}, NOW);
    expect(Object.keys(set.target)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(set.target, '__proto__')?.value).toBe('1.0.1');
    expect(set.changes).toEqual([{name: '__proto__', from: '1.0.0', to: '1.0.1'}]);
  });
});

describe('pinCandidates', () => {
  it('keeps plain, non-deprecated, aged versions above the pin, a new major too, newest first, pin last', () => {
    const doc = docOf(NOW, {
      '1.2.0': {age: 30}, // below the pin
      '1.4.0': {age: 30}, // the pin itself
      '1.5.0': {age: 30},
      '1.6.0': {age: 30, deprecated: true},
      '1.7.0-rc.0': {age: 30}, // prerelease: compareVersions cannot be trusted on it
      '1.8.0': {age: 1}, // too young
      '2.0.0': {age: 30}, // a new major: taken
      '3.0.0-beta.1': {age: 30}, // a prerelease of the next one: not
    });
    expect(pinCandidates(doc, '1.4.0', NOW)).toEqual(['2.0.0', '1.5.0', '1.4.0']);
  });

  it('stops below a hold\u2019s bound, and at the pin when nothing below it is newer', () => {
    const doc = docOf(NOW, {'1.4.0': {}, '1.5.0': {}, '1.9.9': {}, '2.0.0': {}, '2.1.0': {}});
    expect(pinCandidates(doc, '1.4.0', NOW, MIN_AGE_DAYS, '2.0.0')).toEqual(['1.9.9', '1.5.0', '1.4.0']);
    expect(pinCandidates(doc, '1.4.0', NOW, MIN_AGE_DAYS, '1.5.0')).toEqual(['1.4.0']);
  });

  it('takes the next 0.y and 0.0.z lines as it takes a major', () => {
    const zero = docOf(NOW, {'0.2.9': {}, '0.3.5': {}, '0.3.6': {}, '0.3.6-beta.1': {}, '0.3.7': {age: 1}, '0.4.0': {}});
    expect(pinCandidates(zero, '0.3.5', NOW)).toEqual(['0.4.0', '0.3.6', '0.3.5']);
    const zeroZero = docOf(NOW, {'0.0.3': {}, '0.0.4': {}, '0.0.5': {}, '0.0.6': {age: 1}, '0.1.0': {}});
    expect(pinCandidates(zeroZero, '0.0.4', NOW)).toEqual(['0.1.0', '0.0.5', '0.0.4']);
  });

  it('always offers the pin as the floor, even when it is deprecated or too young', () => {
    const deprecated = docOf(NOW, {'2.1.0': {age: 30, deprecated: true}});
    expect(pinCandidates(deprecated, '2.1.0', NOW)).toEqual(['2.1.0']);
    const young = docOf(NOW, {'3.0.0': {age: 1}});
    expect(pinCandidates(young, '3.0.0', NOW)).toEqual(['3.0.0']);
  });
});

describe('aboveHold', () => {
  it('returns the newest eligible release at or above the bound', () => {
    const doc = docOf(NOW, {
      '1.9.9': {age: 30}, // below the bound
      '2.0.0-rc.0': {age: 30}, // prerelease
      '2.0.0': {age: 30}, // the bound itself counts as above it
      '2.1.0': {age: 30},
      '2.5.0': {age: 1}, // too young
      '3.0.0': {age: 30, deprecated: true},
    });
    expect(aboveHold(doc, '2.0.0', NOW)).toBe('2.1.0');
    expect(aboveHold(doc, '2.1.0', NOW)).toBe('2.1.0');
  });

  it('returns null when nothing eligible sits at or above the bound', () => {
    const only = docOf(NOW, {'1.2.3': {age: 30}, '2.0.0': {age: 1}});
    expect(aboveHold(only, '2.0.0', NOW)).toBeNull();
  });
});

describe('holdProblem', () => {
  const hold = {below: '9.0.0', staleAfterDays: 365, reason: 'why'};

  it('has none while the held line still gets releases', () => {
    const doc = docOf(NOW, {'8.24.1': {age: 400}, '8.24.2': {age: 364}, '10.0.0': {age: 30}});
    expect(holdProblem('video.js', hold, '8.24.1', doc, NOW)).toBeNull();
  });

  it('names a held line whose newest release is older than staleAfterDays, deprecated ones not counted', () => {
    const doc = docOf(NOW, {'8.24.1': {age: 366}, '8.25.0': {age: 10, deprecated: true}, '10.0.0': {age: 30}});
    expect(holdProblem('video.js', hold, '8.24.1', doc, NOW)).toMatch(/video\.js below 9\.0\.0 has had no release for over 365 days \(newest 8\.24\.1, .*why/);
  });

  it('names a hold on a library the file does not pin, and one the pin has passed', () => {
    const doc = docOf(NOW, {'9.1.0': {}});
    expect(holdProblem('video.js', hold, undefined, null, NOW)).toMatch(/does not pin: drop the hold/);
    expect(holdProblem('video.js', hold, '9.1.0', doc, NOW)).toMatch(/pinned at 9\.1\.0, not below its hold's 9\.0\.0/);
  });

  it('names a held line with no release at all', () => {
    expect(holdProblem('video.js', hold, '8.0.0', {versions: {}, time: {}}, NOW)).toMatch(/newest none/);
  });
});

describe('MAJOR_HOLDS', () => {
  it('holds only libraries the live suite pins, each below its bound, with a reason and a wait', () => {
    const pins = JSON.parse(fs.readFileSync(PLAYER_LIBRARIES, 'utf8'));
    for (const [name, hold] of MAJOR_HOLDS) {
      expect(Object.hasOwn(pins, name)).toBe(true);
      expect(hold.below).toMatch(/^\d+\.\d+\.\d+$/);
      expect(Number(pins[name].split('.')[0])).toBeLessThan(Number(hold.below.split('.')[0]));
      expect(hold.reason.length).toBeGreaterThan(20);
      expect(hold.staleAfterDays).toBeGreaterThan(0);
    }
  });
});

describe('playerState', () => {
  it('hashes the sorted name@version lines to 12 hex characters', () => {
    const expected = createHash('sha256').update('a@1.0.0\nb@2.0.0').digest('hex').slice(0, 12);
    expect(playerState({b: '2.0.0', a: '1.0.0'})).toBe(expected);
    expect(playerState({b: '2.0.0', a: '1.0.0'})).toMatch(/^[0-9a-f]{12}$/);
  });

  it('changes when the offered set changes', () => {
    expect(playerState({a: '1.0.0', b: '2.0.0'})).not.toBe(playerState({a: '1.0.1', b: '2.0.0'}));
  });
});

describe('playerTargets', () => {
  it('leaves everything alone when no candidate is eligible', () => {
    const pins = {'video.js': '8.24.1'};
    const docs = {
      'video.js': docOf(NOW, {
        '8.24.1': {age: 40},
        '8.24.2': {age: 40, deprecated: true},
        '8.25.0': {age: 1},
        '9.0.0': {age: 1},
      }),
    };
    const plan = playerTargets(pins, docs, {}, NOW, MIN_AGE_DAYS, new Map());
    expect(plan.target).toEqual({'video.js': '8.24.1'});
    expect(plan.changes).toEqual([]);
    expect(plan.newMajors).toEqual([]);
    expect(plan.kept).toEqual([]);
    expect(plan.unresolved).toEqual([]);
    expect(plan.holdProblems).toEqual([]);
  });

  it('moves independent packages to their newest candidates, in pins order, a new major too', () => {
    const pins = {plyr: '3.8.5', dplayer: '1.27.1', mediaelement: '7.1.0', vidstack: '0.3.5'};
    const docs = {
      plyr: docOf(NOW, {'3.8.5': {age: 40}, '3.9.0': {age: 40}, '4.0.0': {age: 1}}),
      dplayer: docOf(NOW, {'1.27.1': {age: 40}, '1.27.2': {age: 5}}),
      mediaelement: docOf(NOW, {'7.1.0': {age: 40}, '7.2.0': {age: 1}, '8.0.0': {age: 40}}),
      vidstack: docOf(NOW, {'0.3.5': {age: 40}, '0.4.0': {age: 40}}),
    };
    const plan = playerTargets(pins, docs, {}, NOW);
    expect(Object.keys(plan.target)).toEqual(Object.keys(pins)); // keeps the pins\u2019 key order
    expect(plan.target).toEqual({plyr: '3.9.0', dplayer: '1.27.2', mediaelement: '8.0.0', vidstack: '0.4.0'});
    expect(plan.changes).toEqual([
      {name: 'plyr', from: '3.8.5', to: '3.9.0'},
      {name: 'dplayer', from: '1.27.1', to: '1.27.2'},
      {name: 'mediaelement', from: '7.1.0', to: '8.0.0'},
      {name: 'vidstack', from: '0.3.5', to: '0.4.0'},
    ]);
    // The ones that leave the pin's caret range: 0.3 to 0.4 is a new major for npm too.
    expect(plan.newMajors).toEqual([
      {name: 'mediaelement', from: '7.1.0', to: '8.0.0'},
      {name: 'vidstack', from: '0.3.5', to: '0.4.0'},
    ]);
    expect(plan.unresolved).toEqual([]);
  });

  it('keeps a held library below its bound, and says what it keeps out and why', () => {
    const pins = {'video.js': '8.24.1', 'plyr': '3.8.5'};
    const docs = {
      'video.js': docOf(NOW, {'8.24.1': {age: 40}, '8.24.2': {age: 20}, '10.1.0': {age: 20}, '10.2.0': {age: 1}}),
      'plyr': docOf(NOW, {'3.8.5': {age: 40}, '4.0.0': {age: 20}}),
    };
    const holds = new Map([['video.js', {below: '9.0.0', staleAfterDays: 365, reason: 'its 10 is no player'}]]);
    const plan = playerTargets(pins, docs, {}, NOW, MIN_AGE_DAYS, holds);
    expect(plan.target).toEqual({'video.js': '8.24.2', 'plyr': '4.0.0'});
    expect(plan.newMajors).toEqual([{name: 'plyr', from: '3.8.5', to: '4.0.0'}]);
    expect(plan.kept).toEqual([{name: 'video.js', version: '8.24.2', latest: '10.1.0', below: '9.0.0', reason: 'its 10 is no player'}]);
    expect(plan.held).toEqual([]);
    expect(plan.holdProblems).toEqual([]);
  });

  it('reports a hold to look at again, and a hold the pin has passed holds nothing', () => {
    const pins = {'video.js': '9.1.0'};
    const docs = {'video.js': docOf(NOW, {'9.1.0': {age: 40}, '10.0.0': {age: 20}})};
    const holds = new Map([
      ['video.js', {below: '9.0.0', staleAfterDays: 365, reason: 'r'}],
      ['plyr', {below: '4.0.0', staleAfterDays: 365, reason: 'r'}],
    ]);
    const plan = playerTargets(pins, docs, {}, NOW, MIN_AGE_DAYS, holds);
    expect(plan.target).toEqual({'video.js': '10.0.0'});
    expect(plan.kept).toEqual([]);
    expect(plan.holdProblems).toEqual([
      expect.stringMatching(/video\.js is pinned at 9\.1\.0, not below its hold's 9\.0\.0/),
      expect.stringMatching(/holds plyr, which .* does not pin/),
    ]);
  });

  it('keeps both xgplayer packages at 3.0.26 when the peer is exact and hls lags behind', () => {
    const pins = {'xgplayer': '3.0.26', 'xgplayer-hls': '3.0.26'};
    const docs = {
      'xgplayer': docOf(NOW, {
        '3.0.26': {age: 40},
        '3.0.27': {age: 4}, // eligible on its own, but the exact peer pulls it back down
        '4.0.0': {age: 40}, // a new major, pulled down the same way
      }),
      'xgplayer-hls': docOf(NOW, {
        '3.0.26': {age: 40, peer: {xgplayer: '3.0.26'}},
        '3.0.27': {age: 1}, // below MIN_AGE_DAYS, so hls stays on its floor
      }),
    };
    const plan = playerTargets(pins, docs, {}, NOW);
    expect(plan.target).toEqual({'xgplayer': '3.0.26', 'xgplayer-hls': '3.0.26'});
    expect(plan.changes).toEqual([]);
    expect(plan.newMajors).toEqual([]);
    expect(plan.held).toEqual([{name: 'xgplayer', version: '3.0.26', newest: '4.0.0'}]);
    expect(plan.unresolved).toEqual([]);
  });

  it('moves both xgplayer packages when both releases are old enough and the peer range allows it', () => {
    const pins = {'xgplayer': '3.0.26', 'xgplayer-hls': '3.0.26'};
    const docs = {
      'xgplayer': docOf(NOW, {'3.0.26': {age: 40}, '3.0.27': {age: 10}}),
      'xgplayer-hls': docOf(NOW, {
        '3.0.26': {age: 40, peer: {xgplayer: '3.0.26'}}, // holds either way, so nothing is blocked
        '3.0.27': {age: 10, peer: {xgplayer: '3.0.27'}},
      }),
    };
    const plan = playerTargets(pins, docs, {}, NOW);
    expect(plan.target).toEqual({'xgplayer': '3.0.27', 'xgplayer-hls': '3.0.27'});
    expect(plan.changes).toEqual([
      {name: 'xgplayer', from: '3.0.26', to: '3.0.27'},
      {name: 'xgplayer-hls', from: '3.0.26', to: '3.0.27'},
    ]);
    expect(plan.unresolved).toEqual([]);
  });

  it('keeps hls-video-element on its pin while its custom-media-element need is too young', () => {
    const pins = {'hls-video-element': '1.5.11', 'custom-media-element': '1.4.6', 'media-tracks': '0.3.5'};
    const fixed = {'hls.js': '1.6.5'};
    const docs = {
      'hls-video-element': docOf(NOW, {
        '1.5.11': {age: 40, deps: {'custom-media-element': '^1.4.6', 'media-tracks': '^0.3.5', 'hls.js': '^1.6.5'}},
        '1.5.12': {age: 40, deps: {'custom-media-element': '^1.4.7', 'media-tracks': '^0.3.5', 'hls.js': '^1.6.5'}},
      }),
      'custom-media-element': docOf(NOW, {'1.4.6': {age: 40}, '1.4.7': {age: 1}}), // 1.4.7 too young
      'media-tracks': docOf(NOW, {'0.3.5': {age: 40}, '0.3.9': {age: 40}}), // 0.y caret move is free
    };
    const plan = playerTargets(pins, docs, fixed, NOW);
    expect(plan.target).toEqual({
      'hls-video-element': '1.5.11', // stepped back: its need cannot be met yet
      'custom-media-element': '1.4.6',
      'media-tracks': '0.3.9',
    });
    expect(plan.changes).toEqual([{name: 'media-tracks', from: '0.3.5', to: '0.3.9'}]);
    expect(plan.held).toEqual([{name: 'hls-video-element', version: '1.5.11', newest: '1.5.12'}]);
    expect(plan.unresolved).toEqual([]);
  });

  it('moves hls-video-element and custom-media-element together once the need is old enough', () => {
    const pins = {'hls-video-element': '1.5.11', 'custom-media-element': '1.4.6'};
    const fixed = {'hls.js': '1.6.5'};
    const docs = {
      'hls-video-element': docOf(NOW, {
        '1.5.11': {age: 40, deps: {'custom-media-element': '^1.4.6', 'hls.js': '^1.6.5'}},
        '1.5.12': {age: 40, deps: {'custom-media-element': '^1.4.7', 'hls.js': '^1.6.5'}},
      }),
      'custom-media-element': docOf(NOW, {'1.4.6': {age: 40}, '1.4.7': {age: 4}}), // 4 days clears the gate
    };
    const plan = playerTargets(pins, docs, fixed, NOW);
    expect(plan.target).toEqual({'hls-video-element': '1.5.12', 'custom-media-element': '1.4.7'});
    expect(plan.changes).toEqual([
      {name: 'hls-video-element', from: '1.5.11', to: '1.5.12'},
      {name: 'custom-media-element', from: '1.4.6', to: '1.4.7'},
    ]);
    expect(plan.unresolved).toEqual([]);
  });

  it('keeps the dependent on its pin when the fixed package does not meet its declared range', () => {
    const pins = {'hls-video-element': '1.5.11'};
    const fixed = {'hls.js': '1.5.0'}; // the repo pins an older hls.js than 1.5.12 needs
    const docs = {
      'hls-video-element': docOf(NOW, {
        '1.5.11': {age: 40, deps: {'hls.js': '^1.5.0'}}, // met by the fixed version
        '1.5.12': {age: 40, deps: {'hls.js': '^1.6.5'}}, // not met: the dependent steps back down
      }),
    };
    const plan = playerTargets(pins, docs, fixed, NOW);
    expect(plan.target).toEqual({'hls-video-element': '1.5.11'});
    expect(plan.changes).toEqual([]);
    expect(plan.unresolved).toEqual([]);
  });

  it('steps a dependent back down instead of taking an update with unreadable needs', () => {
    const pins = {'hls-video-element': '1.5.11'};
    const fixed = {'hls.js': '1.6.5'};
    const docs = {
      'hls-video-element': docOf(NOW, {
        '1.5.11': {age: 40, deps: {'hls.js': '^1.6.5'}},
        '1.5.12': {age: 40, deps: {'hls.js': 'workspace:^'}}, // unreadable: refuse to take it blind
      }),
    };
    const plan = playerTargets(pins, docs, fixed, NOW);
    expect(plan.target).toEqual({'hls-video-element': '1.5.11'});
    expect(plan.unresolved).toEqual([]); // unreadable needs that we stepped away from are not a conflict
  });

  it('ignores unreadable needs that already hold on main', () => {
    const pins = {'xgplayer': '3.0.26', 'xgplayer-hls': '3.0.26'};
    const docs = {
      'xgplayer': docOf(NOW, {'3.0.26': {age: 40}}),
      'xgplayer-hls': docOf(NOW, {'3.0.26': {age: 40, peer: {xgplayer: 'workspace:*'}}}),
    };
    const plan = playerTargets(pins, docs, {}, NOW);
    expect(plan.target).toEqual(pins);
    expect(plan.changes).toEqual([]);
    expect(plan.unresolved).toEqual([]); // 'unknown' on main is the status quo, not a report
  });

  it('reports a conflict that already exists on main and moves nothing below its pin', () => {
    const pins = {'hls-video-element': '1.5.11', 'custom-media-element': '1.4.6'};
    const fixed = {'hls.js': '1.6.5'};
    const docs = {
      'hls-video-element': docOf(NOW, {
        // every published version declares the same unmet need: nowhere to step to, ever
        '1.5.11': {age: 40, deps: {'custom-media-element': '^1.4.7', 'hls.js': '^1.6.5'}},
        '1.5.12': {age: 40, deps: {'custom-media-element': '^1.4.7', 'hls.js': '^1.6.5'}},
      }),
      'custom-media-element': docOf(NOW, {'1.4.6': {age: 40}, '1.4.7': {age: 1}}),
    };
    const plan = playerTargets(pins, docs, fixed, NOW);
    expect(plan.target).toEqual({'hls-video-element': '1.5.11', 'custom-media-element': '1.4.6'});
    expect(plan.changes).toEqual([]);
    expect(plan.unresolved).toEqual([
      {name: 'hls-video-element', version: '1.5.11', needs: 'custom-media-element', range: '^1.4.7'},
    ]);
  });

  it('reports an above-range conflict against a fixed package already present on main', () => {
    const pins = {'xgplayer-hls': '3.0.26'};
    const fixed = {xgplayer: '3.1.0'}; // the repo pins a newer xgplayer than the exact peer allows
    const docs = {
      'xgplayer-hls': docOf(NOW, {'3.0.26': {age: 40, peer: {xgplayer: '3.0.26'}}}),
    };
    const plan = playerTargets(pins, docs, fixed, NOW);
    expect(plan.target).toEqual({'xgplayer-hls': '3.0.26'});
    expect(plan.changes).toEqual([]);
    expect(plan.unresolved).toEqual([
      {name: 'xgplayer-hls', version: '3.0.26', needs: 'xgplayer', range: '3.0.26'},
    ]);
  });

  it('terminates on a cycle of exact peers', () => {
    const pins = {'xgplayer': '3.0.26', 'xgplayer-hls': '3.0.26'};
    const docs = {
      'xgplayer': docOf(NOW, {
        '3.0.26': {age: 40, peer: {'xgplayer-hls': '3.0.26'}},
        '3.0.27': {age: 10, peer: {'xgplayer-hls': '3.0.26'}},
      }),
      'xgplayer-hls': docOf(NOW, {
        '3.0.26': {age: 40, peer: {xgplayer: '3.0.26'}},
        '3.0.27': {age: 10, peer: {xgplayer: '3.0.26'}},
      }),
    };
    const plan = playerTargets(pins, docs, {}, NOW); // both peers drag each other back to the pins
    expect(plan.target).toEqual({'xgplayer': '3.0.26', 'xgplayer-hls': '3.0.26'});
    expect(plan.changes).toEqual([]);
    expect(plan.unresolved).toEqual([]);
  });

  it('throws when a pin has no registry doc', () => {
    expect(() => playerTargets({'video.js': '8.24.1'}, {}, {}, NOW)).toThrow(/video\.js/);
  });

  it('throws when the pin version is missing from its doc', () => {
    const docs = {'video.js': docOf(NOW, {'8.25.0': {age: 40}})};
    expect(() => playerTargets({'video.js': '8.24.1'}, docs, {}, NOW)).toThrow(/8\.24\.1/);
  });
});

describe('applyPlayers', () => {
  const text = '{\n  "a": "1.0.0",\n  "@s/b": "0.3.5"\n}\n';

  it('writes the set in the file\'s order and format', () => {
    expect(applyPlayers(text, {'a': '1.2.0', '@s/b': '0.3.6'})).toBe('{\n  "a": "1.2.0",\n  "@s/b": "0.3.6"\n}\n');
  });

  it('refuses a library going back, one it does not name or lacks, and what is not x.y.z', () => {
    expect(() => applyPlayers(text, {'a': '0.9.0', '@s/b': '0.3.5'})).toThrow(/a would go back from 1\.0\.0 to 0\.9\.0/);
    expect(() => applyPlayers(text, {'a': '1.0.0'})).toThrow(/names a, not a, @s\/b/);
    expect(() => applyPlayers(text, {'@s/b': '0.3.5', 'a': '1.0.0'})).toThrow(/names/);
    expect(() => applyPlayers(text, {'a': '1.1.0-rc.1', '@s/b': '0.3.5'})).toThrow(/not x\.y\.z/);
  });
});

describe('tests/e2e/live-specs/player-libraries.json', () => {
  const pins = JSON.parse(fs.readFileSync(PLAYER_LIBRARIES, 'utf8'));
  const spec = fs.readFileSync('tests/e2e/live-specs/players.e2e.mjs', 'utf8');

  it('pins plain versions, in the format the recipe writes', () => {
    for (const version of Object.values(pins)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(applyPlayers(fs.readFileSync(PLAYER_LIBRARIES, 'utf8'), pins)).toBe(fs.readFileSync(PLAYER_LIBRARIES, 'utf8'));
  });

  it('names every package the pages load from /npm/, and nothing they do not', () => {
    // The pages' quoted paths only: the spec's comments name /npm/ paths too.
    const loaded = new Set([...spec.matchAll(/["']\/npm\/((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)\//g)].map((match) => match[1]));
    loaded.delete('hls.js'); // the repository's own pin, served next to them
    expect([...loaded].sort()).toEqual(Object.keys(pins).sort());
  });
});
