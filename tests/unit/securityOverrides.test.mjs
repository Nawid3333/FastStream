// Tests for tools/security-overrides.mjs ÔÇö the PLAN and VERIFY logic. The workflow
// jobs, the gh/git calls and the install are not part of the module and not tested here.

import {describe, expect, it} from 'vitest';
import {
  applyFloors,
  fromFlat,
  lockVersions,
  npmLockVersions,
  parseRange,
  planBundle,
  planFloors,
  unfloored,
  verifyBundle,
  verifyLock,
} from '../../tools/security-overrides.mjs';

const TODAY = '2026-10-24';

/** name -> Set(version), tersely.
 * @param {Record<string, string[]>} obj */
const versions = (obj) => new Map(Object.entries(obj).map(([name, vs]) => [name, new Set(vs)]));

/** Alerts keyed by number, the shape applyFloors consumes.
 * @param {import('../../tools/security-overrides.mjs').Alert[]} alerts
 * @returns {Map<number, import('../../tools/security-overrides.mjs').Alert>} */
const byNumber = (alerts) => new Map(alerts.map((a) => [a.number, a]));

/** @param {import('../../tools/security-overrides.mjs').VersionMap} map */
const objectify = (map) => Object.fromEntries([...map].map(([name, set]) => [name, [...set].sort()]));

/**
 * @param {number} number
 * @param {string} name
 * @param {string} range vulnerable_version_range
 * @param {string | null} patched first_patched_version.identifier (null = absent)
 * @param {string} [manifest]
 */
const mkAlert = (number, name, range, patched, manifest = 'pnpm-lock.yaml') => ({
  number,
  dependency: {manifest_path: manifest, package: {ecosystem: 'npm', name}, scope: 'development'},
  security_advisory: {
    ghsa_id: `GHSA-test-${number}`,
    severity: 'high',
    summary: `synthetic summary for alert ${number}, deliberately plain text`,
  },
  security_vulnerability: {
    first_patched_version: patched === null ? null : {identifier: patched},
    package: {ecosystem: 'npm', name},
    vulnerable_version_range: range,
  },
  state: 'open',
});

// The real pnpm-workspace.yaml (backticks escaped for the template literal).
const WORKSPACE = `overrides:
  # Dependabot #27/#14/#17/#19/#20/#18/#21, and #73 (serialize-javascript < 7.1.3, XSS through
  # an unescaped </script>, mocha 12.0.3's ^7.1.1): these devDependencies (web-ext's
  # firefox-profile, mocha's reporters) pin older
  # transitive versions than what upstream has since patched. None of these ship
  # in the extension; forcing the patched versions here avoids waiting on those
  # maintainers to bump their own lockfiles.
  adm-zip: ^0.6.1
  serialize-javascript: ^7.1.3
  # Dependabot #24/#25: the original extract-zip is unmaintained (no npm release
  # since 2020, no commits since 2022) and has two unpatched symlink-traversal
  # CVEs with no first_patched_version. electron/extract-zip is Electron's
  # actively maintained fork, published as an explicit "drop-in replacement",
  # and its 1.0.5 changelog fixes exactly this symlink-at-final-path-component
  # class of bug. Same package name everywhere it's required, so no code change.
  extract-zip: npm:@electron-internal/extract-zip@^1.0.5
  # Dependabot #30-#42: webdriver (undici ^6.27.0) and addons-linter's cheerio
  # (undici ^7.19.0) both allow the patched undici (6.28.1, 7.29.1), but pnpm
  # keeps the locked 6.28.0 and 7.29.0 even on \`pnpm update undici\`, and
  # Dependabot's own update ends in update_not_possible. One override per major,
  # so each keeps its own. Dependabot #74-#79 (2026-10-23; two high, denial of service, and an
  # integrity bypass): cheerio (^7.19.0) and webdriver and geckodriver (^8.11.2) allow the fixes,
  # 7.30.1 and 8.12.2.
  undici@6: ^6.28.1
  undici@7: ^7.30.1
  undici@8: ^8.12.2
  # Dependabot #59 (high): basic-ftp <= 6.2.0 parses a directory listing in quadratic time.
  # @puppeteer/browsers -> proxy-agent -> pac-proxy-agent -> get-uri, whose newest release
  # (8.0.1) still asks for ^5.3.1, brings 5.3.1, so the fix (6.2.1) needs this. 6.0.0's one
  # breaking change refuses a separate transfer host (FTP bounce); get-uri's calls (access,
  # lastMod, list, downloadTo, close) are unchanged, and it reaches basic-ftp only for a
  # PAC file at an ftp:// address, which nothing here has.
  basic-ftp: ^6.2.1
  # GHSA-pqg4-j6r4-53mv (critical, published 2026-10-06): shell-quote's quote() lets a line
  # terminator after a \`{ comment }\` token through, fixed in 1.11.0. web-ext -> fx-runner
  # 1.6.0 (its newest) pins exactly 1.10.0. fx-runner calls only parse(), on a binary-args
  # string that nothing here passes; 1.11/1.12 only add parse support for rarer syntax.
  shell-quote: ^1.11.0
  # Dependabot #60, issue #301 (high, GHSA-86w9-cpqp-85rv): node-forge <= 1.4.0 accepts a
  # forged RSA PKCS#1 v1.5 signature, and no release fixes it (2026-10-11: four outside fix
  # PRs, no word from its maintainer since June). It comes only through web-ext ->
  # @devicefarmer/adbkit, which web-ext loads only to run an extension on Firefox for Android
  # (extension-runners/index.js imports firefox-android.js, util/adb.js's only importer,
  # when that is the target). build, lint, sign, the desktop run and util/submit-addon never
  # reach it. Removing adbkit removes node-forge; \`web-ext run -t firefox-android\`, which
  # nothing here does, is what goes with it.
  'web-ext>@devicefarmer/adbkit': '-'
allowBuilds:
  geckodriver: true
  esbuild: true
  # wdio pulls edgedriver in for Edge sessions, which this project does not run; its
  # install script downloads a driver binary that nothing here would use.
  edgedriver: false
  core-js: false
  dtrace-provider: false
  spawn-sync: false
patchedDependencies:
  Coloris@0.25.0: patches/Coloris@0.25.0.patch
  dashjs@5.2.1: patches/dashjs@5.2.1.patch
  gif.js@0.2.0: patches/gif.js@0.2.0.patch
  hls.js@1.7.3: patches/hls.js@1.7.3.patch
  mp4box@2.4.1: patches/mp4box@2.4.1.patch
# pnpm 12 (2026-10-11): with its default (download) it switches to the pinned version by
# itself and records itself in a first pnpm-lock.yaml document (packageManagerDependencies).
# GitHub's dependency graph reads only that first document, so every dependency vanished
# from it, and with them Dependabot's alerts and dependency-review.yml
# (dependabot/dependabot-core#15904, open). CI (pnpm/action-setup) and
# tools/update-local.ps1 install exactly the pinned pnpm, so nothing needs the switch:
# ignore keeps pnpm-lock.yaml one document, byte for byte what pnpm 11 wrote.
pmOnFail: ignore`;

// Two pnpm 12 documents: the first one (packageManagerDependencies bookkeeping, plus a
// snapshots: decoy) must be ignored; the main document carries packages:.
const LOCK = [
  'lockfileVersion: \'9.0\'',
  '',
  'packageManagerDependencies:',
  '  pnpm: 10.12.1',
  '',
  'snapshots:',
  '',
  '  only-in-first-document@1.0.0: {}',
  '',
  '---',
  'lockfileVersion: \'9.0\'',
  '',
  'importers:',
  '',
  '  .:',
  '    devDependencies:',
  '      webdriver:',
  '        specifier: ^1.0.0',
  '        version: 1.1.0(undici@7.29.0)(undici@8.11.2)',
  '',
  'packages:',
  '',
  '  undici@7.29.0:',
  '    resolution: {integrity: sha512-AAA}',
  '',
  '  undici@8.11.2:',
  '    resolution: {integrity: sha512-BBB}',
  '',
  '  \'@babel/code-frame@7.29.7\':',
  '    resolution: {integrity: sha512-CCC}',
  '',
  '  gitpkg@https://example.example/x.tgz:',
  '    resolution: {tarball: https://example.example/x.tgz}',
  '',
  'snapshots:',
  '',
  '  webdriver@1.1.0(undici@7.29.0)(undici@8.11.2):',
  '    dependencies:',
  '      undici: 7.29.0',
  '      undici: 8.11.2',
  '',
  '  \'pkga@1.0.0(pkgb@2.0.0)\': {}',
  '',
  '  undici@7.29.0: {}',
  '',
  '  undici@8.11.2: {}',
].join('\n');

// The two real undici alerts (2026-10-23). state: 'fixed' is routing's business, not
// the planner's ÔÇö planFloors sees already-routed alerts as the workflow hands them over.
const REAL_ALERTS = [
  {
    created_at: '2026-10-23T23:18:21Z',
    dependency: {manifest_path: 'pnpm-lock.yaml', package: {ecosystem: 'npm', name: 'undici'}, scope: 'development'},
    number: 79,
    security_advisory: {
      ghsa_id: 'GHSA-xjj6-f33q-929c',
      severity: 'high',
      summary: 'undici vulnerable to Denial of Service via unhandled error on excessive content-encodings',
    },
    security_vulnerability: {
      first_patched_version: {identifier: '8.12.2'},
      package: {ecosystem: 'npm', name: 'undici'},
      vulnerable_version_range: '>= 8.0.0, < 8.12.2',
    },
    state: 'fixed',
  },
  {
    created_at: '2026-10-23T23:18:21Z',
    dependency: {manifest_path: 'pnpm-lock.yaml', package: {ecosystem: 'npm', name: 'undici'}, scope: 'development'},
    number: 78,
    security_advisory: {
      ghsa_id: 'GHSA-xjj6-f33q-929c',
      severity: 'high',
      summary: 'undici vulnerable to Denial of Service via unhandled error on excessive content-encodings',
    },
    security_vulnerability: {
      first_patched_version: {identifier: '7.30.1'},
      package: {ecosystem: 'npm', name: 'undici'},
      vulnerable_version_range: '>= 7.18.0, < 7.30.1',
    },
    state: 'fixed',
  },
];

// The undici majors present in the real lockfile; 6.28.1 is already floored.
const UNDICI_TREE = versions({undici: ['6.28.1', '7.29.0', '8.11.2']});

/**
 * The lines applyFloors inserted at the end of the overrides block; asserts on the fly
 * that everything before and after the block stayed byte-identical.
 * @param {string} workspace
 * @param {string} out
 * @returns {string[]}
 */
function insertedAddLines(workspace, out) {
  const cut = workspace.indexOf('\nallowBuilds:');
  const head = workspace.slice(0, cut + 1);
  const tail = workspace.slice(cut + 1);
  expect(out.startsWith(head)).toBe(true);
  expect(out.endsWith(tail)).toBe(true);
  // The inserted lines end with a newline before the tail: no empty last line.
  const inserted = out.slice(head.length, out.length - tail.length);
  expect(inserted.endsWith('\n')).toBe(true);
  return inserted.slice(0, -1).split('\n');
}

describe('parseRange', () => {
  it('implements the comparator forms GitHub emits', () => {
    expect(parseRange('< 1.2.3')('1.2.2')).toBe(true);
    expect(parseRange('< 1.2.3')('1.2.3')).toBe(false);
    const both = parseRange('>= 7.18.0, < 7.30.1');
    expect(both('7.17.9')).toBe(false);
    expect(both('7.18.0')).toBe(true);
    expect(both('7.29.9')).toBe(true);
    expect(both('7.30.1')).toBe(false);
    expect(parseRange('<= 0.6.0')('0.6.0')).toBe(true);
    expect(parseRange('<= 0.6.0')('0.6.1')).toBe(false);
    expect(parseRange('= 1.0.0')('1.0.0')).toBe(true);
    expect(parseRange('= 1.0.0')('1.0.1')).toBe(false);
    expect(parseRange('>= 2.0.0')('2.0.0')).toBe(true);
    expect(parseRange('>= 2.0.0')('1.9.9')).toBe(false);
  });

  it('compares numerically, never lexically', () => {
    expect(parseRange('< 0.10.0')('0.9.0')).toBe(true);
    expect(parseRange('>= 9.0.0, < 10.0.0')('9.30.1')).toBe(true);
    expect(parseRange('>= 9.0.0, < 10.0.0')('10.0.0')).toBe(false);
  });

  it('throws on anything but the GitHub forms and on non-x.y.z versions', () => {
    for (const bad of ['1.2.3', '~1.2.3', '*', '> 1.2.x', '>= 1.2.3 || < 2.0.0', '']) {
      expect(() => parseRange(bad)).toThrow();
    }
    // Released x.y.z only: callers must filter lockfile versions before testing.
    expect(() => parseRange('< 1.2.3')('1.2.3-beta.1')).toThrow();
  });
});

describe('lockVersions', () => {
  it('reads only the document that has packages:, unquoting keys and dropping peer suffixes', () => {
    expect(objectify(lockVersions(LOCK))).toEqual({
      '@babel/code-frame': ['7.29.7'],
      'pkga': ['1.0.0'],
      'undici': ['7.29.0', '8.11.2'],
      'webdriver': ['1.1.0'],
    });
    // The first document (packageManagerDependencies + snapshots: decoy) is ignored,
    // and tarball keys never enter the map.
  });

  it('fails loudly when no document carries packages:', () => {
    expect(() => lockVersions('lockfileVersion: \'9.0\'\n')).toThrow();
  });
});

describe('npmLockVersions', () => {
  it('scans all node_modules copies, skipping links and non-dependency entries', () => {
    const lock = {
      name: 'fsaunpack',
      lockfileVersion: 3,
      packages: {
        '': {name: 'fsaunpack', devDependencies: {'basic-ftp': '^6.2.1'}},
        'node_modules/@babel/code-frame': {version: '7.29.7'},
        'node_modules/@puppeteer/browsers': {version: '24.10.0'},
        'node_modules/basic-ftp': {version: '6.2.1'},
        'node_modules/get-uri': {version: '6.0.1', dependencies: {'basic-ftp': '^5.3.1'}},
        'node_modules/get-uri/node_modules/basic-ftp': {version: '5.3.1'},
        'node_modules/webdriver': {link: true, resolved: 'packages/webdriver'},
        'packages/webdriver': {version: '1.1.0'},
      },
    };
    expect(objectify(npmLockVersions(lock))).toEqual({
      '@babel/code-frame': ['7.29.7'],
      '@puppeteer/browsers': ['24.10.0'],
      'basic-ftp': ['5.3.1', '6.2.1'],
      'get-uri': ['6.0.1'],
    });
  });

  it('treats a lockfile without a packages map as an empty tree', () => {
    expect(objectify(npmLockVersions({lockfileVersion: 1}))).toEqual({});
  });
});

describe('planFloors', () => {
  it('declines an alert whose floor main has already, while the lockfile is still vulnerable', () => {
    // The existing floors already ask for the patched versions, yet the tree holds vulnerable
    // ones: the override does not take as written, and the same floor again would not either.
    const plan = planFloors(REAL_ALERTS, UNDICI_TREE, WORKSPACE, TODAY);
    expect(plan.floors).toEqual([]);
    expect(plan.declined.map((d) => d.alert)).toEqual([79, 78]);
    expect(plan.declined[0].reason).toContain('the override \'undici@8: ^8.12.2\' on main asks for the fix already');
  });

  it('raises both undici floors when the advisories move ahead, touching only their lines', () => {
    const al79 = JSON.parse(JSON.stringify(REAL_ALERTS[0]));
    const al78 = JSON.parse(JSON.stringify(REAL_ALERTS[1]));
    al79.security_vulnerability.first_patched_version = {identifier: '8.12.3'};
    al78.security_vulnerability.first_patched_version = {identifier: '7.30.2'};
    const alerts = [al79, al78];
    const plan = planFloors(alerts, UNDICI_TREE, WORKSPACE, TODAY);
    expect(plan.declined).toEqual([]);
    expect(plan.floors).toEqual([
      {name: 'undici', selector: 'undici@8', floor: '^8.12.3', alerts: [79], action: 'raise', from: '^8.12.2'},
      {name: 'undici', selector: 'undici@7', floor: '^7.30.2', alerts: [78], action: 'raise', from: '^7.30.1'},
    ]);
    const out = applyFloors(WORKSPACE, plan.floors, byNumber(alerts), TODAY);
    // Byte-for-byte: only the two value lines changed, and a dated stamp sits above each.
    const expected = WORKSPACE
        .replace('  undici@7: ^7.30.1\n', '  # 2026-10-24: raised to ^7.30.2 (Dependabot #78)\n  undici@7: ^7.30.2\n')
        .replace('  undici@8: ^8.12.2\n', '  # 2026-10-24: raised to ^8.12.3 (Dependabot #79)\n  undici@8: ^8.12.3\n');
    expect(out).toBe(expected);
  });

  it('adds a new package with the wrapped mechanical comment at the end of the block', () => {
    const al86 = {
      number: 86,
      dependency: {manifest_path: 'pnpm-lock.yaml', package: {ecosystem: 'npm', name: 'minimist'}, scope: 'dependencies'},
      security_advisory: {
        ghsa_id: 'GHSA-xxxx-xxxx-xxxx',
        severity: 'high',
        summary:
          'minimist vulnerable to Prototype Pollution through the handling of the args object, which lets an attacker silently overwrite Object.prototype and can escalate to remote code execution in processes that build CLI parsers from untrusted input',
      },
      security_vulnerability: {
        first_patched_version: {identifier: '1.2.8'},
        package: {ecosystem: 'npm', name: 'minimist'},
        vulnerable_version_range: '<= 1.2.7',
      },
      state: 'open',
    };
    const plan = planFloors([al86], versions({minimist: ['1.2.7']}), WORKSPACE, TODAY);
    expect(plan.declined).toEqual([]);
    expect(plan.floors).toEqual([{name: 'minimist', selector: 'minimist', floor: '^1.2.8', alerts: [86], action: 'add'}]);

    const out = applyFloors(WORKSPACE, plan.floors, byNumber([al86]), TODAY);
    const inserted = insertedAddLines(WORKSPACE, out); // proves the head/tail bytes survived
    const entry = inserted[inserted.length - 1];
    const comments = inserted.slice(0, -1);
    expect(entry).toBe('  minimist: ^1.2.8');
    expect(comments.length).toBeGreaterThanOrEqual(2);
    for (const line of comments) {
      expect(line.startsWith('  # ')).toBe(true);
      expect(line.length).toBeLessThanOrEqual(100);
    }
    expect(comments[0].startsWith('  # Dependabot #86 (2026-10-24, high): minimist <= 1.2.7: minimist')).toBe(true);
    expect(comments[comments.length - 1].endsWith('Floor added by security-alerts.yml.')).toBe(true);
    // Wrapping moves only over single spaces, so re-joining reconstructs the fact line.
    expect(comments.map((l) => l.slice(4)).join(' ')).toBe(
        `Dependabot #86 (2026-10-24, high): minimist <= 1.2.7: ${al86.security_advisory.summary}. Floor added by security-alerts.yml.`,
    );
  });

  it('adds a major-scoped entry when the tree holds several majors', () => {
    const al94 = mkAlert(94, 'undici', '>= 9.0.0, < 9.1.0', '9.1.0');
    const plan = planFloors([al94], versions({undici: ['6.28.1', '9.0.0']}), WORKSPACE, TODAY);
    expect(plan.floors).toEqual([{name: 'undici', selector: 'undici@9', floor: '^9.1.0', alerts: [94], action: 'add'}]);
    const inserted = insertedAddLines(WORKSPACE, applyFloors(WORKSPACE, plan.floors, byNumber([al94]), TODAY));
    expect(inserted[0].startsWith('  # Dependabot #94 (2026-10-24, high): undici >= 9.0.0, < 9.1.0: ')).toBe(true);
    expect(inserted[inserted.length - 1]).toBe('  undici@9: ^9.1.0');
  });

  it('declines a cross-major fix', () => {
    const plan = planFloors([mkAlert(87, 'undici', '>= 7.18.0, < 7.30.1', '8.12.2')], versions({undici: ['7.29.0']}), WORKSPACE, TODAY);
    expect(plan.floors).toEqual([]);
    expect(plan.declined).toEqual([{alert: 87, reason: 'the fix is a new major (7 -> 8): a person decides'}]);
  });

  it('declines when there is no first patched version or a non-x.y.z one', () => {
    const plan = planFloors(
        [mkAlert(24, 'extract-zip', '>= 0.7.0, < 0.8.0', null), mkAlert(25, 'extract-zip', '>= 0.7.0, < 0.8.0', '0.8.1-rc.2')],
        versions({'extract-zip': []}),
        WORKSPACE,
        TODAY,
    );
    expect(plan.floors).toEqual([]);
    expect(plan.declined).toEqual([
      {alert: 24, reason: 'no first patched version'},
      {alert: 25, reason: 'patched version is not x.y.z'},
    ]);
  });

  it('declines a stale alert (no vulnerable version left in the lockfile)', () => {
    const plan = planFloors([mkAlert(88, 'left-pad', '< 1.3.2', '1.3.2')], versions({'left-pad': ['1.3.2']}), WORKSPACE, TODAY);
    expect(plan.floors).toEqual([]);
    expect(plan.declined).toEqual([{alert: 88, reason: 'stale: no vulnerable version in the lockfile'}]);
  });

  it('declines when the existing override is an npm alias value', () => {
    const plan = planFloors([mkAlert(89, 'extract-zip', '<= 1.0.5', '1.0.6')], versions({'extract-zip': ['1.0.5']}), WORKSPACE, TODAY);
    expect(plan.floors).toEqual([]);
    expect(plan.declined).toEqual([
      {alert: 89, reason: 'existing override \'extract-zip\' is not a plain ^x.y.z: \'npm:@electron-internal/extract-zip@^1.0.5\''},
    ]);
  });

  it('declines a package keyed in patchedDependencies', () => {
    const plan = planFloors([mkAlert(90, 'hls.js', '>= 1.5.0, < 1.8.0', '1.8.0')], versions({'hls.js': ['1.7.3']}), WORKSPACE, TODAY);
    expect(plan.floors).toEqual([]);
    expect(plan.declined).toEqual([{alert: 90, reason: 'package \'hls.js\' is keyed in patchedDependencies: human decision'}]);
  });

  it('raises a selectorless existing entry for a single-major tree', () => {
    const al59 = mkAlert(59, 'basic-ftp', '<= 6.2.1', '6.3.0');
    const plan = planFloors([al59], versions({'basic-ftp': ['6.2.1']}), WORKSPACE, TODAY);
    expect(plan.declined).toEqual([]);
    expect(plan.floors).toEqual([
      {name: 'basic-ftp', selector: 'basic-ftp', floor: '^6.3.0', alerts: [59], action: 'raise', from: '^6.2.1'},
    ]);
    // Byte-for-byte: only the basic-ftp value changed, with the dated stamp above it.
    const out = applyFloors(WORKSPACE, plan.floors, byNumber([]), TODAY);
    expect(out).toBe(WORKSPACE.replace('  basic-ftp: ^6.2.1\n', '  # 2026-10-24: raised to ^6.3.0 (Dependabot #59)\n  basic-ftp: ^6.3.0\n'));
  });

  it('raises in place a key that sends another major\'s requests into the alert\'s major', () => {
    // encoding-sniffer@0: ^1.0.2 is how the tree came to hold 1.0.2 (cheerio asks for ^0.2.1):
    // a plain encoding-sniffer key beside it would compete with it.
    const ws = WORKSPACE.replace('  basic-ftp: ^6.2.1\n', '  basic-ftp: ^6.2.1\n  encoding-sniffer@0: ^1.0.2\n');
    const alert = mkAlert(91, 'encoding-sniffer', '< 1.0.3', '1.0.3');
    const plan = planFloors([alert], versions({'encoding-sniffer': ['1.0.2']}), ws, TODAY);
    expect(plan.declined).toEqual([]);
    expect(plan.floors).toEqual([
      {name: 'encoding-sniffer', selector: 'encoding-sniffer@0', floor: '^1.0.3', alerts: [91], action: 'raise', from: '^1.0.2'},
    ]);
    const out = applyFloors(ws, plan.floors, byNumber([alert]), TODAY);
    expect(out).toBe(ws.replace('  encoding-sniffer@0: ^1.0.2\n',
        '  # 2026-10-24: raised to ^1.0.3 (Dependabot #91)\n  encoding-sniffer@0: ^1.0.3\n'));
  });

  it('declines when such a key and a plain one both reach the alert\'s major', () => {
    const ws = WORKSPACE.replace('  basic-ftp: ^6.2.1\n', '  basic-ftp: ^6.2.1\n  encoding-sniffer@0: ^1.0.2\n  encoding-sniffer: ^1.0.2\n');
    const plan = planFloors([mkAlert(92, 'encoding-sniffer', '< 1.0.3', '1.0.3')], versions({'encoding-sniffer': ['1.0.2']}), ws, TODAY);
    expect(plan.floors).toEqual([]);
    expect(plan.declined).toEqual([
      {alert: 92, reason: 'existing overrides \'encoding-sniffer@0: ^1.0.2\' and \'encoding-sniffer\' both reach major 1'},
    ]);
  });

  it('groups two alerts on the same package and major into one max floor', () => {
    const al91 = mkAlert(91, 'minimist', '>= 1.1.0, < 1.2.8', '1.2.8');
    const al92 = mkAlert(92, 'minimist', '< 1.2.9', '1.2.9');
    const plan = planFloors([al91, al92], versions({minimist: ['1.2.5']}), WORKSPACE, TODAY);
    expect(plan.declined).toEqual([]);
    expect(plan.floors).toEqual([{name: 'minimist', selector: 'minimist', floor: '^1.2.9', alerts: [91, 92], action: 'add'}]);
    const inserted = insertedAddLines(WORKSPACE, applyFloors(WORKSPACE, plan.floors, byNumber([al91, al92]), TODAY));
    expect(inserted[inserted.length - 1]).toBe('  minimist: ^1.2.9');
    const comments = inserted.slice(0, -1);
    expect(comments.some((l) => l.startsWith('  # Dependabot #91 (2026-10-24, high): minimist >= 1.1.0, < 1.2.8: '))).toBe(true);
    expect(comments.some((l) => l.startsWith('  # Dependabot #92 (2026-10-24, high): minimist < 1.2.9: '))).toBe(true);
    for (const line of comments) {
      expect(line.startsWith('  # ')).toBe(true);
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  it('declines npm-route manifests in this (pnpm) planner', () => {
    const plan = planFloors(
        [mkAlert(95, 'basic-ftp', '<= 6.2.9', '6.2.10', 'fsaunpack/package-lock.json')],
        versions({'basic-ftp': ['6.2.0']}),
        WORKSPACE,
        TODAY,
    );
    expect(plan.floors).toEqual([]);
    expect(plan.declined).toEqual([{alert: 95, reason: 'unsupported manifest_path: fsaunpack/package-lock.json'}]);
  });

  it('fails loudly when pnpm-workspace.yaml has no overrides block', () => {
    expect(() => planFloors([], versions({}), 'allowBuilds:\n  esbuild: true\n', TODAY)).toThrow();
  });
});

describe('applyFloors', () => {
  it('throws when the overrides block is missing', () => {
    expect(() => applyFloors('allowBuilds:\n  esbuild: true\n', [], new Map(), TODAY)).toThrow();
  });

  it('throws on an entry line it cannot read', () => {
    expect(() => applyFloors('overrides:\n  adm-zip ^0.6.1\nallowBuilds:\n', [], new Map(), TODAY)).toThrow();
  });
});

describe('verifyLock', () => {
  it('flags survivors and unmet floors when a floor never applied', () => {
    const problems = verifyLock(
        REAL_ALERTS,
        versions({undici: ['7.29.0', '8.11.2']}),
        versions({undici: ['7.29.0', '8.11.2']}),
        [
          {name: 'undici', selector: 'undici@7', floor: '^7.30.1', alerts: [78], action: 'none'},
          {name: 'undici', selector: 'undici@8', floor: '^8.12.2', alerts: [79], action: 'none'},
        ],
    );
    expect(problems).toEqual([
      'alert #79: undici@8.11.2 is still inside \'>= 8.0.0, < 8.12.2\'',
      'alert #78: undici@7.29.0 is still inside \'>= 7.18.0, < 7.30.1\'',
      'floor \'undici@7: ^7.30.1\' is not met by undici@7.29.0',
      'floor \'undici@8: ^8.12.2\' is not met by undici@8.11.2',
    ]);
  });

  it('passes a properly floored and clean tree', () => {
    const tree = versions({undici: ['7.30.1', '8.12.2']});
    expect(
        verifyLock(REAL_ALERTS, tree, tree, [
          {name: 'undici', selector: 'undici@7', floor: '^7.30.1', alerts: [78], action: 'none'},
          {name: 'undici', selector: 'undici@8', floor: '^8.12.2', alerts: [79], action: 'none'},
        ]),
    ).toEqual([]);
  });

  it('flags an unmet floor even when the alert range is already clear', () => {
    const tree = versions({undici: ['8.12.1']});
    expect(
        verifyLock([], tree, tree, [{name: 'undici', selector: 'undici@8', floor: '^8.12.2', alerts: [], action: 'add'}]),
    ).toEqual(['floor \'undici@8: ^8.12.2\' is not met by undici@8.12.1']);
  });

  it('uses npm caret semantics for 0.x floors', () => {
    const floors = [{name: 'adm-zip', selector: 'adm-zip', floor: '^0.6.1', alerts: [], action: 'add'}];
    expect(verifyLock([], versions({'adm-zip': ['0.6.2']}), versions({'adm-zip': ['0.6.2']}), floors)).toEqual([]);
    // ^0.6.1 caps at 0.7.0, so 0.7.0 violates the floor.
    expect(verifyLock([], versions({'adm-zip': ['0.7.0']}), versions({'adm-zip': ['0.7.0']}), floors)).toEqual([
      'floor \'adm-zip: ^0.6.1\' is not met by adm-zip@0.7.0',
    ]);
  });

  it('reads a key that sends major 0\'s requests to 1.x by the major its value names', () => {
    const floors = [{name: 'encoding-sniffer', selector: 'encoding-sniffer@0', floor: '^1.0.3', alerts: [], action: 'raise'}];
    // The move from 1.0.2 is the floor's own, not churn; and 1.0.2 left in place does not meet it.
    expect(verifyLock([], versions({'encoding-sniffer': ['1.0.2']}), versions({'encoding-sniffer': ['1.0.3']}), floors)).toEqual([]);
    expect(verifyLock([], versions({'encoding-sniffer': ['1.0.2']}), versions({'encoding-sniffer': ['1.0.2']}), floors)).toEqual([
      'floor \'encoding-sniffer@0: ^1.0.3\' is not met by encoding-sniffer@1.0.2',
    ]);
  });

  it('flags lockfile churn outside the floors, not churn inside them', () => {
    const problems = verifyLock(
        [REAL_ALERTS[1]],
        versions({undici: ['7.29.0'], foo: ['1.0.0']}),
        versions({undici: ['7.30.1'], foo: ['1.0.1']}),
        [{name: 'undici', selector: 'undici@7', floor: '^7.30.1', alerts: [78], action: 'add'}],
    );
    expect(problems).toEqual(['the lockfile changed more than the floors: foo 1.0.0 -> 1.0.1']);
  });

  it('fails closed on a prerelease of an alerted package: the range says nothing about it', () => {
    const tree = versions({x: ['1.2.3-beta.1']});
    expect(verifyLock([mkAlert(96, 'x', '< 1.2.3', '1.2.3')], tree, tree, [])).toEqual([
      'alert #96: x@1.2.3-beta.1 is not a plain release, and cannot be checked against \'< 1.2.3\'']);
  });

  // From a review of this module: each fails without its fix.
  it('lists a grouped alert once even with two vulnerable copies in the major', () => {
    const al = mkAlert(92, 'minimist', '< 1.2.9', '1.2.9');
    const plan = planFloors([al], versions({minimist: ['1.2.5', '1.2.8']}), WORKSPACE, TODAY);
    expect(plan.floors).toEqual([{name: 'minimist', selector: 'minimist', floor: '^1.2.9', alerts: [92], action: 'add'}]);
    const out = applyFloors(WORKSPACE, plan.floors, byNumber([al]), TODAY);
    expect(insertedAddLines(WORKSPACE, out).filter((l) => l.startsWith('  # Dependabot #92 ('))).toHaveLength(1);
  });

  it('flags drift in a major of a floored package that no floor covers', () => {
    const old = versions({undici: ['6.28.1', '7.29.0', '8.11.2']});
    const neu = versions({undici: ['7.30.1', '8.12.2', '9.0.0']});
    const floors = [{name: 'undici', selector: 'undici@7', floor: '^7.30.1', alerts: [], action: 'none'},
      {name: 'undici', selector: 'undici@8', floor: '^8.12.2', alerts: [], action: 'none'}];
    expect(verifyLock([], old, neu, floors)).toEqual(['the lockfile changed more than the floors: undici 6.28.1 -> 9.0.0']);
  });

  it('skips an alias version in an npm lockfile instead of failing on it', () => {
    const lock = (v) => ({packages: {'node_modules/my-foo': {version: v}}});
    expect(npmLockVersions(lock('npm:foo@1.0.0')).size).toBe(0);
    expect(verifyLock([], npmLockVersions(lock('npm:foo@1.0.0')), npmLockVersions(lock('npm:foo@1.0.1')), [])).toEqual([]);
  });

  it('declines a package a parent-scoped override already governs', () => {
    const ws = 'overrides:\n  \'web-ext>pkg\': ^1.0.0\nallowBuilds:\n';
    const plan = planFloors([mkAlert(4, 'pkg', '< 1.1.0', '1.1.0')], versions({pkg: ['1.0.0']}), ws, TODAY);
    expect(plan.floors).toEqual([]);
    expect(plan.declined[0].reason).toContain('\'web-ext>pkg\'');
  });

  it('refuses an overrides block with a key twice', () => {
    const ws = 'overrides:\n  foo: ^1.0.0\n  foo: ^1.0.2\nallowBuilds:\n';
    expect(() => planFloors([mkAlert(1, 'foo', '< 1.1.0', '1.1.0')], versions({foo: ['1.0.0']}), ws, TODAY)).toThrow(/twice/);
  });

  it('keeps a raised line\'s quotes and CRLF', () => {
    const ws = 'overrides:\r\n  foo: \'^1.0.0\'\r\nallowBuilds:\r\n';
    const out = applyFloors(ws, [{name: 'foo', selector: 'foo', floor: '^1.0.1', alerts: [1], action: 'raise', from: '^1.0.0'}], new Map(), TODAY);
    expect(out).toBe(`overrides:\r\n  # ${TODAY}: raised to ^1.0.1 (Dependabot #1)\r\n  foo: '^1.0.1'\r\nallowBuilds:\r\n`);
  });

  it('writes nothing that is not a floor', () => {
    const bad = {name: 'foo', selector: 'foo', floor: '^1.0.0\n  injected: true', alerts: [1], action: 'raise', from: '^0.9.0'};
    expect(() => applyFloors('overrides:\n  foo: ^0.9.0\nallowBuilds:\n', [bad], new Map(), TODAY)).toThrow(/not a floor/);
  });
});

describe('the workflow steps: planBundle, verifyBundle, unfloored', () => {
  // An alert as security-alerts.yml's fetch_alerts flattens it.
  const flat = (number, name, range, patched) => ({number, created_at: '2026-10-20T00:00:00Z', package: name,
    manifest: 'pnpm-lock.yaml', severity: 'high', summary: `summary ${number}`, range, patched});
  const lock = (undici7, other = 'left-pad@1.3.0') => [
    'lockfileVersion: \'9.0\'', '', 'packages:', '', `  undici@${undici7}:`, '    resolution: {integrity: sha512-A}', '',
    `  ${other}:`, '    resolution: {integrity: sha512-B}', '', 'snapshots:', '', `  undici@${undici7}: {}`, '', `  ${other}: {}`, '',
  ].join('\n');
  const ws = 'overrides:\n  undici: ^7.29.0\nallowBuilds:\n  esbuild: true\n';

  it('reads a flattened alert as the REST shape', () => {
    expect(fromFlat(flat(9, 'x', '< 1.0.1', '1.0.1'))).toEqual({
      number: 9,
      dependency: {manifest_path: 'pnpm-lock.yaml', package: {name: 'x'}},
      security_advisory: {ghsa_id: '', severity: 'high', summary: 'summary 9'},
      security_vulnerability: {vulnerable_version_range: '< 1.0.1', first_patched_version: {identifier: '1.0.1'}},
    });
    expect(fromFlat(flat(9, 'x', '< 1.0.1', null)).security_vulnerability.first_patched_version).toBeNull();
  });

  it('plans: the floors, the alerts taken, the declines, the edited file and the versions before', () => {
    const alerts = [flat(78, 'undici', '>= 7.0.0, < 7.30.1', '7.30.1'), flat(80, 'left-pad', '< 2.0.0', null)];
    const {plan, routing, workspace} = planBundle({alerts, lockText: lock('7.29.1'), workspaceText: ws, today: TODAY, baseSha: 'abc'});
    expect(routing.handled).toEqual([78]);
    expect(routing.declined).toEqual([{alert: 80, reason: 'no first patched version'}]);
    expect(plan.floors).toEqual([{name: 'undici', selector: 'undici', floor: '^7.30.1', alerts: [78], action: 'raise', from: '^7.29.0'}]);
    expect(plan.versions).toEqual({undici: ['7.29.1']});
    expect(plan.base_sha).toBe('abc');
    expect(workspace).toBe(`overrides:\n  # ${TODAY}: raised to ^7.30.1 (Dependabot #78)\n  undici: ^7.30.1\nallowBuilds:\n  esbuild: true\n`);
  });

  it('plans nothing to write when no floor is taken', () => {
    const {routing, workspace} = planBundle({alerts: [flat(80, 'left-pad', '< 2.0.0', null)], lockText: lock('7.29.1'),
      workspaceText: ws, today: TODAY, baseSha: 'abc'});
    expect(routing.handled).toEqual([]);
    expect(workspace).toBeNull();
  });

  it('verifies a lockfile that fixes the alerts taken, and names one that does not', () => {
    const alerts = [flat(78, 'undici', '>= 7.0.0, < 7.30.1', '7.30.1')];
    const {plan} = planBundle({alerts, lockText: lock('7.29.1'), workspaceText: ws, today: TODAY, baseSha: 'abc'});
    expect(verifyBundle(plan, lock('7.30.2'))).toEqual({ok: true, problems: []});
    const bad = verifyBundle(plan, lock('7.29.1'));
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]).toBe('alert #78: undici@7.29.1 is still inside \'>= 7.0.0, < 7.30.1\'');
  });

  it('compares everything but the floored packages', () => {
    expect(unfloored(lock('7.29.1'), ['undici'])).toBe(unfloored(lock('7.30.2'), ['undici']));
    expect(unfloored(lock('7.29.1'), ['undici'])).not.toBe(unfloored(lock('7.30.2', 'left-pad@1.3.1'), ['undici']));
    expect(unfloored(lock('7.29.1'), ['undici'])).toBe('left-pad@1.3.0');
  });
});
