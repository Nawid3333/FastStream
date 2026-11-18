// @ts-check
// web-ext run with a reset dev profile (pre-installed add-ons kept) and a build from scratch.

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
const builtDir = path.join(root, 'built');

/**
 * Deletes the runtime state (cache, storage, session) but keeps extensions/, user.js and the seeded bookmarks.
 * @param {string} profilePath
 */
function resetProfilePreservingAddons(profilePath) {
  if (!fs.existsSync(profilePath)) {
    return;
  }

  const keep = new Set(['extensions', 'user.js', 'bookmarks.html']);

  for (const entry of fs.readdirSync(profilePath)) {
    if (keep.has(entry)) {
      continue;
    }
    fs.rmSync(path.join(profilePath, entry), {recursive: true, force: true});
  }
}

console.log('Resetting dev profile (keeping pre-installed add-ons)...');
resetProfilePreservingAddons(profileDir);

if (fs.existsSync(builtDir)) {
  console.log('Removing old packaged builds...');
  fs.readdirSync(builtDir)
      .filter((f) => f.endsWith('.zip'))
      .forEach((f) => fs.unlinkSync(path.join(builtDir, f)));
}

// rebuild() keeps the unpacked build_* directory: web-ext run reads it.
console.log(`Rebuilding ${target.name} from scratch...\n`);
await rebuild();

if (!fs.existsSync(sourceDir)) {
  console.error(`Source dir missing after rebuild: ${sourceDir}`);
  process.exit(1);
}

console.log('\nLaunching fresh Firefox dev instance with FastStream + uBlock...');
console.log(`Profile: ${profileDir} (reset, add-ons preserved)\n`);

const note = nodeVersionNote();
if (note) console.warn(note + '\n');

// webExtSpawn: a shell and quoting on Windows (pnpm.cmd), the arguments as they are elsewhere.
const {command, args, shell} = webExtSpawn([
  'run',
  '--source-dir', sourceDir,
  '--target', 'firefox-desktop',
  '--firefox-profile', profileDir,
  '--profile-create-if-missing',
  '--arg=-no-remote',
  '--arg=-new-instance',
]);

const webExt = spawn(command, args, {
  cwd: root,
  stdio: 'inherit',
  shell,
  env: {
    ...process.env,
    MOZ_NO_REMOTE: '1',
  },
});

webExt.on('error', (e) => {
  console.error(`Could not start web-ext through pnpm: ${e.message}`);
  process.exit(1);
});
// No code: a signal ended it, which is no success.
webExt.on('exit', (code) => process.exit(code ?? 1));
