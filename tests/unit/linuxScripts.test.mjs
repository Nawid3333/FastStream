import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// tools/linux/setup.sh and verify.sh, which `pnpm run verify:linux` runs in WSL. They change
// a distro, so no test runs them; these check what they are made of. Their pieces were run
// by hand into /tmp (2026-10-03): both images' files came out digest-checked, zizmor passed
// the tree, and Node 26's npm installed the pinned pnpm once libatomic1 was there.

const root = path.resolve(import.meta.dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const commands = (file) => read(file).split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

describe('tools/linux/setup.sh', () => {
  it('installs pnpm without corepack, which Node 25 and later do not ship (#238)', () => {
    const setup = commands('tools/linux/setup.sh');
    expect(setup).not.toMatch(/\bcorepack enable\b/);
    expect(setup).not.toMatch(/for bin in [^;]*\bcorepack\b/);
    expect(setup).toMatch(/jq -r '\.packageManager \/\/ ""' "\$repo\/package\.json"/);
    expect(setup).toContain('/opt/node/bin/npm install --global --prefix /opt/node --ignore-scripts');
    expect(setup).toContain('"pnpm@$pnpm_want"');
  });

  it('installs libatomic1, without which Node 26 does not start', () => {
    expect(commands('tools/linux/setup.sh')).toMatch(/^for pkg in [^;]*\blibatomic1\b/m);
  });

  it('takes zizmor from the image .github/zizmor/Dockerfile pins, as ci.yml does (#239)', () => {
    const setup = commands('tools/linux/setup.sh');
    expect(setup).toContain('"$repo/.github/zizmor/Dockerfile"');
    expect(setup).toMatch(/image_files https:\/\/ghcr\.io\/v2\/zizmorcore\/zizmor "\$token" "\$digest" \/opt\/zizmor usr\/bin\/zizmor/);
    expect(setup).toContain('ln -sf /opt/zizmor/zizmor /usr/local/bin/zizmor');
  });
});

describe('tools/linux/verify.sh', () => {
  it('runs CI\'s workflows job: actionlint, zizmor, then the run: scripts\' tests (#239)', () => {
    const verify = commands('tools/linux/verify.sh');
    const steps = ['actionlint -color', 'zizmor --offline --format plain .github/', 'bash tests/workflows/run.sh'];
    const at = steps.map((step) => verify.indexOf(step));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // CI's own zizmor step, offline on .github/ as here.
    expect(read('.github/workflows/ci.yml')).toMatch(/"\$image" --offline --format github \.github\//);
  });
});
