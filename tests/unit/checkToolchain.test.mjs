import fs from 'node:fs';
// js-yaml 5 has no default export, only named ones; this form reads 4 and 5 alike.
import * as yaml from 'js-yaml';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  addonVersion, applyAddon, getJson, latestLtsMajor, MIN_AGE_DAYS, newestAddon, newestOfMajor, plan, projectNodeMajor,
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
