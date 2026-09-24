// Runs the installed-extension suites (pnpm run test:ext) against the GitHub
// self-host build instead of the AMO one. Setting FS_EXT_BUILD inline in a
// package.json script does not work under cmd.exe, and this is not worth a
// cross-env dependency.
import {spawnSync} from 'node:child_process';

const result = spawnSync('pnpm', ['run', 'test:ext'], {
  stdio: 'inherit',
  shell: true,
  env: {...process.env, FS_EXT_BUILD: 'github'},
});
process.exit(result.status ?? 1);
