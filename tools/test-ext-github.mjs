// @ts-check
// Runs a smoke set of the installed-extension suite against the GitHub self-host build
// instead of the AMO one. The two builds share every line of the background, the content
// scripts and the player; the GitHub build adds only the options page's update checker
// (NO_UPDATE_CHECKER splices it out of the AMO build) and the contextualIdentities
// permission. The whole suite (33 specs, five CI jobs, about 35 runner-minutes) ran a second
// time on it, testing the same code twice (his request, 2026-10-13: a leaner suite).
// What the smoke set covers: the build loads and plays at its moz-extension:// origin
// (extension), its options page, update checker included, opens and keeps what it saves
// (keybinds-storage), and a download, which reads the tab's container (save-flow).
// Setting FS_EXT_BUILD inline in a package.json script does not work under cmd.exe, and
// this is not worth a cross-env dependency.
import {spawnSync} from 'node:child_process';

export const GithubSmokeSpecs = [
  'tests/e2e/ext-specs/extension.e2e.mjs',
  'tests/e2e/ext-specs/keybinds-storage.e2e.mjs',
  'tests/e2e/ext-specs/save-flow.e2e.mjs',
];

const result = spawnSync('pnpm', ['exec', 'wdio', 'run', 'tests/e2e/wdio.extension.conf.mjs',
  ...GithubSmokeSpecs.flatMap((spec) => ['--spec', spec])], {
  stdio: 'inherit',
  shell: true,
  env: {...process.env, FS_EXT_BUILD: 'github'},
});
process.exit(result.status ?? 1);
