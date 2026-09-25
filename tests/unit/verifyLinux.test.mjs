import {describe, expect, it} from 'vitest';
import {ubuntuReleases} from '../../tools/verify-linux.mjs';

// verify:linux picks its WSL distros from GitHub's runner image table. A wrong pick tests
// locally on a release CI does not run on, and a push that passed here fails there.

const row = (name, arch, labels) => `| ${name}<br>![Endpoint Badge](https://img.shields.io/x) | ${arch} | ${labels} | [x] |`;
const table = (...rows) => [
  '| Image | Architecture | YAML Label | Included Software |',
  '| --------------------|--------------|---------------------|------------------|',
  ...rows,
].join('\n');

// The table as it stood on 2026-09-25, Ubuntu rows only.
const september2026 = [
  row('Ubuntu 26.04', 'x64', '`ubuntu-26.04`'),
  row('Ubuntu 26.04 Arm64', 'arm64', '`ubuntu-26.04-arm`'),
  row('Ubuntu 24.04', 'x64', '`ubuntu-latest` or `ubuntu-24.04`'),
  row('Ubuntu 24.04 Arm64', 'arm64', '`ubuntu-24.04-arm`'),
  row('Ubuntu 22.04', 'x64', '`ubuntu-22.04`'),
  row('Ubuntu Slim', 'x64', '`ubuntu-slim`'),
];

describe('ubuntuReleases', () => {
  it('takes the release behind ubuntu-latest and the newest one', () => {
    expect(ubuntuReleases(table(...september2026))).toEqual({latest: '24.04', newest: '26.04'});
  });

  it('gives one release once ubuntu-latest has moved to the newest', () => {
    const moved = table(
        row('Ubuntu 26.04', 'x64', '`ubuntu-latest` or `ubuntu-26.04`'),
        row('Ubuntu 24.04', 'x64', '`ubuntu-24.04`'),
    );
    expect(ubuntuReleases(moved)).toEqual({latest: '26.04', newest: '26.04'});
  });

  it('leaves out a beta or preview image, as runner-images.yml does', () => {
    const beta = table(
        row('Ubuntu 28.04 [![beta](https://img.shields.io/badge/beta-0969DA)](https://github.com/x)', 'x64', '`ubuntu-28.04`'),
        ...september2026,
    );
    expect(ubuntuReleases(beta).newest).toBe('26.04');
  });

  it('refuses a table without an ubuntu-latest row, rather than guess', () => {
    expect(() => ubuntuReleases(table(row('Ubuntu 24.04', 'x64', '`ubuntu-24.04`')))).toThrow(/ubuntu-latest/);
  });
});
