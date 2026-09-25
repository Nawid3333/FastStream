import {describe, expect, it} from 'vitest';
import {latestLtsMajor, projectNodeMajor} from '../../tools/check-toolchain.mjs';

// The toolchain check opens and closes issues on these two numbers; a wrong one either
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
});
