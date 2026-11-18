// @ts-check
// A smoke set of the installed-extension suite against the GitHub build: it adds only the update checker.
// Not FS_EXT_BUILD inline in a package.json script: that does not work under cmd.exe.
import {spawnSync} from 'node:child_process';

export const GithubSmokeSpecs = [
  'tests/e2e/ext-specs/extension.e2e.mjs',
  'tests/e2e/ext-specs/keybinds-storage.e2e.mjs',
  'tests/e2e/ext-specs/save-flow.e2e.mjs',
];

// One command line: pnpm.cmd needs the shell, and Node deprecates (DEP0190) separate arguments with one.
const command = ['pnpm', 'exec', 'wdio', 'run', 'tests/e2e/wdio.extension.conf.mjs',
  ...GithubSmokeSpecs.flatMap((spec) => ['--spec', spec])];
if (command.some((part) => !/^[\w./:-]+$/.test(part))) throw new Error(`not a plain argument: ${command.join(' ')}`);
const result = spawnSync(command.join(' '), {
  stdio: 'inherit',
  shell: true,
  env: {...process.env, FS_EXT_BUILD: 'github'},
});
process.exit(result.status ?? 1);
