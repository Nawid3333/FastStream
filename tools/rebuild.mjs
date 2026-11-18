// @ts-check
// Shared rebuild step for the dev launchers, and how they start web-ext (webExtSpawn).
// The launchers run the same steps as build:keep: a build without sync-vendor has no HLS or DASH.
// Keep this list in step with the "build:keep" script in package.json.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');

/**
 * firefox-github by default; amo (or --amo) for the AMO submission build.
 * @param {string[]} [argv]
 * @return {{name: string, dir: string}}
 */
export function resolveTarget(argv = process.argv.slice(2)) {
  const wantsAmo = argv.some((a) => a === 'amo' || a === '--amo');
  const name = wantsAmo ? 'firefox-amo' : 'firefox-github';
  return {name, dir: path.join(root, `build_${name.replace('-', '_')}`)};
}

/**
 * Windows runs pnpm through its .cmd shim: a shell, and one quoted string. Elsewhere it is spawned directly.
 * @param {string[]} args
 * @param {string} [platform]
 * @return {{command: string, args: string[], shell: boolean}}
 */
export function webExtSpawn(args, platform = process.platform) {
  const pnpmArgs = ['exec', 'web-ext', ...args];
  if (platform === 'win32') {
    // cmd.exe reads the line again: a path with & | < > ^ ( ) or % is quoted too.
    /** @type {(s: string) => string} */
    const quote = (s) => /[\s"&|<>^()%!]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    return {command: ['pnpm', ...pnpmArgs].map(quote).join(' '), args: [], shell: true};
  }
  return {command: 'pnpm', args: pnpmArgs, shell: false};
}

/**
 * What to tell someone who starts web-ext on a newer Node than .nvmrc: its Firefox connection failed on Node 27.
 * @param {string} [running]
 * @param {string} [wanted]
 * @return {?string} Null on the project's Node or an older one.
 */
export function nodeVersionNote(running = process.versions.node, wanted = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8')) {
  const major = (/** @type {string} */ version) => Number(/\d+/.exec(version)?.[0]);
  if (!(major(running) > major(wanted))) return null;
  return `This is Node ${running}; the project is made for Node ${major(wanted)} (.nvmrc). ` +
    `If web-ext cannot connect to Firefox (ECONNREFUSED), start it with Node ${major(wanted)}.`;
}

/**
 * @param {string} script
 * @param {string[]} [args]
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
 * Rebuilds every target, keeping the unpacked build_* directories web-ext run needs.
 * @return {Promise<void>}
 */
export async function rebuild() {
  // Vendored libraries first, or the build ships without them.
  await run('tools/sync-vendor.mjs');
  await run('localescript.mjs');
  await run('build.mjs', ['--keep']);
}
