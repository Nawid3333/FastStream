// Runs the A/B benchmark of the player (tests/e2e/wdio.bench.conf.mjs) on two versions.
//
//   node tools/bench-ab.mjs --a main                 main against this checkout as it is
//   node tools/bench-ab.mjs --a <ref> --b <ref>      two commits
//   node tools/bench-ab.mjs --a-dir <web build> --b-dir <web build>   two builds made before
//
//   --rounds N          runs a build per scenario, besides the warm-up (default 5)
//   --scenarios a,b     mp4, hls, dash, idle (default all four)
//   --rate M --ttfb T   media over one shared M Mbit/s line, T ms to each answer's first byte
//   --where             also lists which places in the player's code woke it up
//   --label-a/--label-b names for the report (default: the ref and its commit)
//   --clean             removes the worktrees and builds made for earlier runs, and stops
//
// A git ref is checked out into a worktree of its own (outside this checkout, under the
// system's temporary folder unless --trees names another) and built there with this
// checkout's node_modules linked in, so both must have the same pnpm-lock.yaml. Its build is
// made once per commit and reused. Without --b, B is this checkout, built afresh.
// The numbers go to logs/bench/ab-<time>.md and .json (method: docs/notes/player.md).
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const {values: args} = parseArgs({options: {
  'a': {type: 'string'}, 'b': {type: 'string'},
  'a-dir': {type: 'string'}, 'b-dir': {type: 'string'},
  'rounds': {type: 'string', default: '5'},
  'scenarios': {type: 'string', default: 'mp4,hls,dash,idle'},
  'rate': {type: 'string', default: '0'},
  'ttfb': {type: 'string', default: '0'},
  'trees': {type: 'string', default: path.join(os.tmpdir(), 'faststream-bench')},
  'clean': {type: 'boolean', default: false},
  'where': {type: 'boolean', default: false},
  'label-a': {type: 'string'}, 'label-b': {type: 'string'},
}});

/**
 * @param {string[]} gitArgs
 * @param {string} [cwd]
 * @return {string}
 */
function git(gitArgs, cwd = root) {
  return execFileSync('git', gitArgs, {cwd, encoding: 'utf8'}).trim();
}

/**
 * The build steps of `pnpm run build:keep`, run with node itself: pnpm in a worktree whose
 * node_modules is a link would install into it.
 * @param {string} dir
 */
function build(dir) {
  for (const step of [['tools/sync-vendor.mjs'], ['localescript.mjs'], ['build.mjs', '--keep']]) {
    const done = spawnSync(process.execPath, step, {cwd: dir, stdio: 'inherit'});
    if (done.status !== 0) throw new Error(`${step.join(' ')} failed in ${dir}`);
  }
}

/**
 * Builds a commit in a worktree of its own, or finds its build from before.
 * @param {string} ref
 * @return {{dir: string, label: string}} Its web build.
 */
function buildRef(ref) {
  const sha = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  const label = `${ref} (${sha.slice(0, 8)})`;
  const lockHere = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  const lockThere = git(['show', `${sha}:pnpm-lock.yaml`]);
  if (lockHere.replace(/\r\n/g, '\n').trim() !== lockThere.replace(/\r\n/g, '\n').trim()) {
    throw new Error(`${label} has another pnpm-lock.yaml than this checkout: build it in a checkout of its own and pass --a-dir/--b-dir`);
  }
  const tree = path.join(args.trees, sha);
  const web = path.join(tree, 'built', 'web');
  const stamp = path.join(tree, '.bench-built');
  // The stamp names the commit its build was made from; a missing one or another commit's
  // means build again.
  let stamped = '';
  try {
    stamped = fs.readFileSync(stamp, 'utf8').trim();
  } catch {
    // never built here
  }
  if (stamped === sha && fs.existsSync(path.join(web, 'player', 'index.html'))) {
    console.log(`${label}: using its build from before (${web})`);
    return {dir: web, label};
  }
  if (!fs.existsSync(tree)) {
    fs.mkdirSync(args.trees, {recursive: true});
    git(['worktree', 'add', '--detach', tree, sha]);
  }
  const modules = path.join(tree, 'node_modules');
  if (!fs.existsSync(modules)) {
    fs.symlinkSync(path.join(root, 'node_modules'), modules, process.platform === 'win32' ? 'junction' : 'dir');
  }
  console.log(`${label}: building in ${tree}`);
  build(tree);
  fs.writeFileSync(stamp, sha + '\n');
  return {dir: web, label};
}

/**
 * @param {'a'|'b'} side
 * @return {{dir: string, label: string}}
 */
function side(side) {
  const dir = args[`${side}-dir`];
  if (dir) return {dir: path.resolve(dir), label: path.resolve(dir)};
  const ref = args[side];
  if (ref) return buildRef(ref);
  if (side === 'a') throw new Error('name A: --a <git ref> or --a-dir <web build>');
  const head = git(['rev-parse', '--short=8', 'HEAD']);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']) ? ', with changes' : '';
  console.log('B: building this checkout');
  build(root);
  return {dir: path.join(root, 'built', 'web'), label: `this checkout (${head}${dirty})`};
}

/**
 * Removes the worktrees of earlier runs: the link to node_modules first, so that removing the
 * tree cannot reach into this checkout's node_modules.
 */
function clean() {
  if (!fs.existsSync(args.trees)) return;
  for (const name of fs.readdirSync(args.trees)) {
    const tree = path.join(args.trees, name);
    const modules = path.join(tree, 'node_modules');
    if (fs.lstatSync(modules, {throwIfNoEntry: false})) fs.unlinkSync(modules);
    git(['worktree', 'remove', '--force', tree]);
    console.log(`removed ${tree}`);
  }
  fs.rmdirSync(args.trees);
}

if (args.clean) {
  clean();
  process.exit(0);
}
const a = side('a');
const b = side('b');
console.log(`A = ${a.label}\nB = ${b.label}`);
const wdio = path.join(root, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js');
const run = spawnSync(process.execPath, [wdio, 'run', path.join(root, 'tests', 'e2e', 'wdio.bench.conf.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    BENCH_A_DIR: a.dir, BENCH_B_DIR: b.dir, BENCH_A_LABEL: args['label-a'] || a.label, BENCH_B_LABEL: args['label-b'] || b.label,
    BENCH_WHERE: args.where ? '1' : '0',
    BENCH_ROUNDS: args.rounds, BENCH_SCENARIOS: args.scenarios,
    BENCH_RATE_MBIT: args.rate, BENCH_TTFB_MS: args.ttfb,
  },
});
process.exit(run.status ?? 1);
