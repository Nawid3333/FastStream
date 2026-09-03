#!/usr/bin/env node
// Launcher for a *fresh* `web-ext run`:
//  1. resets the persistent dev profile's mutable state while keeping
//     pre-installed extensions like uBlock Origin,
//  2. rebuilds the Firefox libre target from scratch,
//  3. launches a new Firefox instance with the clean extension.
//
// Use this when you need to verify that a change is not masked by profile
// state or cached data from previous runs, but still want uBlock Origin
// and the dev prefs from tools/setup-dev-profile.mjs.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {rebuild} from './rebuild.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'build_firefox_libre');
const profileDir = path.join(root, '.dev-profile');
const builtDir = path.join(root, 'built');

/**
 * Resets a Firefox profile without removing pre-installed extensions or
 * user.js prefs. Deletes the entries that accumulate runtime state
 * (cache, storage, session, etc.) so the next run starts clean, but keeps
 * extensions/, user.js and the seeded bookmarks intact.
 *
 * @param {string} profilePath the profile directory to reset
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

// Reset the profile while keeping uBlock Origin and other preinstalled add-ons.
console.log('Resetting dev profile (keeping pre-installed add-ons)...');
resetProfilePreservingAddons(profileDir);

// Remove any packaged zips from previous builds.
if (fs.existsSync(builtDir)) {
  console.log('Removing old packaged builds...');
  fs.readdirSync(builtDir)
      .filter((f) => f.endsWith('.zip'))
      .forEach((f) => fs.unlinkSync(path.join(builtDir, f)));
}

// Rebuild the extension. rebuild() keeps the unpacked build_* directories
// so web-ext run has a source-dir to read; the profile is still fresh.
console.log('Rebuilding Firefox libre target from scratch...\n');
await rebuild();

if (!fs.existsSync(sourceDir)) {
  console.error(`Source dir missing after rebuild: ${sourceDir}`);
  process.exit(1);
}

console.log('\nLaunching fresh Firefox dev instance with FastStream + uBlock...');
console.log(`Profile: ${profileDir} (reset, add-ons preserved)\n`);

const isCmd = process.platform === 'win32';
const quote = (s) => (s.includes(' ') ? `"${s}"` : s);
const webExtArgs = [
  'pnpm', 'exec', 'web-ext', 'run',
  '--source-dir', quote(sourceDir),
  '--target', 'firefox-desktop',
  '--firefox-profile', quote(profileDir),
  '--profile-create-if-missing',
  // Do not keep profile changes between runs for the fresh launcher.
  // This is redundant with the delete above, but protects against
  // accidental state leakage if the profile survives for any reason.
  '--arg=-no-remote',
  '--arg=-new-instance',
];

const webExtCmd = webExtArgs.join(' ');

const webExt = spawn(webExtCmd, [], {
  cwd: root,
  stdio: 'inherit',
  shell: isCmd,
  env: {
    ...process.env,
    MOZ_NO_REMOTE: '1',
  },
});

webExt.on('exit', (code) => process.exit(code ?? 0));
