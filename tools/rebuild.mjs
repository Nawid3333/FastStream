// Shared rebuild step for the dev launchers.
//
// This exists because the launchers must run the *same* steps as
// `pnpm run build:keep`, and it is easy for them to drift out of sync. They
// did: both launchers ran localescript.mjs and build.mjs directly but skipped
// tools/sync-vendor.mjs. That was harmless while hls.mjs, hls.worker.js and
// dash.mjs were tracked in git, but they are generated now, so a build
// without the sync step silently produces an extension with no HLS or DASH
// support - build.mjs simply copies whatever is on disk and reports success,
// and the failure only shows up as a module-load error at playback time.
//
// Keep this list in step with the "build:keep" script in package.json.

import {spawn} from 'node:child_process';
import path from 'node:path';
import * as url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');

/**
 * Picks which build target a launcher should run.
 *
 * Defaults to firefox-github, the daily driver. Pass `dist` to launch
 * firefox-amo instead - that is the AMO submission build, which is spliced
 * with NO_YOUTUBE and so has no YouTube support, no yt.mjs/googlevideo.mjs
 * and no userScripts permission. Testing playback against it is the only way
 * to confirm that removing YouTube did not disturb the other players.
 *
 * @param {string[]} [argv] arguments to read, defaults to process.argv
 * @return {{name: string, dir: string}} the target's name and build directory
 */
export function resolveTarget(argv = process.argv.slice(2)) {
  const wantsAmo = argv.some((a) => a === 'amo' || a === '--amo');
  const name = wantsAmo ? 'firefox-amo' : 'firefox-github';
  return {name, dir: path.join(root, `build_${name.replace('-', '_')}`)};
}

/**
 * Runs a Node script from the project root and resolves when it exits 0.
 *
 * @param {string} script path to the script, relative to the project root
 * @param {string[]} [args] extra arguments
 * @return {Promise<void>}
 */
function run(script, args = []) {
  const child = spawn(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with ${code}`));
    });
  });
}

/**
 * Rebuilds every target, keeping the unpacked build_* directories that
 * `web-ext run` needs as a source dir.
 *
 * @return {Promise<void>}
 */
export async function rebuild() {
  // Regenerate vendored libraries from node_modules + patches/ first, or the
  // build ships without them.
  await run('tools/sync-vendor.mjs');
  await run('localescript.mjs');
  await run('build.mjs', ['--keep']);
}
