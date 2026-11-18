// @ts-check
// web-ext run on a fresh build of the Firefox libre target, in the dev profile, as a Firefox of its own.
// The profile by absolute path, and MOZ_NO_REMOTE=1: a bare name opens the Profile Manager.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {nodeVersionNote, rebuild, resolveTarget, webExtSpawn} from './rebuild.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');
const target = resolveTarget();
const sourceDir = target.dir;
const profileDir = path.join(root, '.dev-profile');

console.log(`Rebuilding ${target.name}...\n`);
await rebuild();

// Checked after the rebuild: on a fresh clone the build creates it.
if (!fs.existsSync(sourceDir)) {
  console.error(`Source dir missing after rebuild: ${sourceDir}`);
  process.exit(1);
}

console.log('\nLaunching Firefox dev instance with FastStream + uBlock...');
console.log(`Profile: ${profileDir}\n`);

const note = nodeVersionNote();
if (note) console.warn(note + '\n');

// webExtSpawn: a shell and quoting on Windows (pnpm.cmd), the arguments as they are elsewhere.
const {command, args, shell} = webExtSpawn([
  'run',
  '--source-dir', sourceDir,
  '--target', 'firefox-desktop',
  '--firefox-profile', profileDir,
  '--profile-create-if-missing',
  '--keep-profile-changes',
  '--arg=-no-remote',
  '--arg=-new-instance',
]);

const webExt = spawn(command, args, {
  cwd: root,
  stdio: 'inherit',
  shell,
  env: {
    ...process.env,
    // A separate Firefox process: no hand-off to the user's running browser.
    MOZ_NO_REMOTE: '1',
  },
});

webExt.on('error', (e) => {
  console.error(`Could not start web-ext through pnpm: ${e.message}`);
  process.exit(1);
});
// No code: a signal ended it, which is no success.
webExt.on('exit', (code) => process.exit(code ?? 1));
