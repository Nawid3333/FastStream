#!/usr/bin/env node
// Launcher for `web-ext run` that:
//  1. rebuilds the Firefox libre target,
//  2. uses an absolute path for the dev profile,
//  3. forces a separate Firefox instance so it never interferes with the
//     user's normal default-browser workflow in other workspaces.
//
// web-ext's --firefox-profile flag treats a bare name as a Profile Manager
// name, which caused a profile picker dialog. Using an absolute path plus
// MOZ_NO_REMOTE=1 avoids that and avoids handing off to an existing Firefox.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'build_firefox_libre');
const profileDir = path.join(root, '.dev-profile');

if (!fs.existsSync(sourceDir)) {
  console.error(`Source dir missing: ${sourceDir}\nRun: pnpm run build:keep`);
  process.exit(1);
}

// Build scripts are plain Node modules, so we can invoke them directly
// without needing pnpm in PATH for the rebuild step.
console.log('Rebuilding Firefox libre target...\n');
const build = spawn(process.execPath, [
  path.join(root, 'localescript.mjs'),
], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});

await new Promise((resolve, reject) => {
  build.on('error', reject);
  build.on('exit', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`localescript exited with ${code}`));
  });
});

const build2 = spawn(process.execPath, [
  path.join(root, 'build.mjs'),
  '--keep',
], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});

await new Promise((resolve, reject) => {
  build2.on('error', reject);
  build2.on('exit', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`build.mjs exited with ${code}`));
  });
});

console.log('\nLaunching Firefox dev instance with FastStream + uBlock...');
console.log(`Profile: ${profileDir}\n`);

// On Windows, .cmd files (pnpm.cmd) must be spawned with shell:true.
// Paths with spaces must be quoted when using shell mode.
const isCmd = process.platform === 'win32';
const quote = (s) => s.includes(' ') ? `"${s}"` : s;
const webExtArgs = [
  'pnpm', 'exec', 'web-ext', 'run',
  '--source-dir', quote(sourceDir),
  '--target', 'firefox-desktop',
  '--firefox-profile', quote(profileDir),
  '--profile-create-if-missing',
  '--keep-profile-changes',
  // Additional Firefox arguments: no-remote so it cannot hand off to the
  // user's main Firefox, and a blank first-run page to avoid default-browser
  // prompts. These combine with the user.js prefs for defense in depth.
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
    // Force a separate Firefox process; prevents hand-off to the user's
    // already-running default browser, which previously caused ECONNREFUSED
    // on the RDP port and profile-picker dialogs.
    MOZ_NO_REMOTE: '1',
  },
});

webExt.on('exit', (code) => process.exit(code ?? 0));
