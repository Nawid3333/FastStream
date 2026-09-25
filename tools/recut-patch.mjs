#!/usr/bin/env node
// Re-cuts a library's pnpm patch onto a newer release of that library.
//
//   node tools/recut-patch.mjs <package> <new-version>          report only
//   node tools/recut-patch.mjs <package> <new-version> --apply  and take it
//
// What it does, per file the current patch touches:
//   base   = the release the patch is cut against, from npm
//   ours   = that release with the patch applied (what ships today)
//   theirs = the new release, from npm
// and a three-way merge of ours onto theirs. A webpack bundle (dash.js) is merged
// module by module, keyed by each module's source path, so an upstream change to one
// module never conflicts with FastStream's change to another. A file whose name carries
// a content hash (mp4box's rolldown chunks) is matched to the new release's renamed one.
// Stray CR characters in the new release (dash.js ships 428) are kept, so the patch
// holds only real changes.
//
// Then it checks each merged JavaScript file: it must parse, and ESLint's no-undef and
// no-unused-vars must report no name that the stock new release does not. A clean
// merge is not a correct one: on the dash.js 5.2.1 upgrade two came out clean and threw
// at run time (a helper upstream deleted, a webpack import upstream renumbered), and
// this is the check that caught both.
//
// Exit status: 0 merged and checked, 1 usage or setup error, 2 conflicts or a failed
// check (the report says where; the merged files, conflict markers and all, are in the
// output directory), 3 the release is too new for pnpm's minimumReleaseAge - try again
// later.
//
// --apply (only after a clean run) bumps package.json, swaps the patchedDependencies
// entry, installs, commits the patch through `pnpm patch` / `pnpm patch-commit`, renames
// hashed chunk names in tools/sync-vendor.mjs, and regenerates the vendored files. It
// does not run the tests: `pnpm run verify` is the next step, and it is what proves
// playback (docs/updating-patched-libraries.md).
//
// Replaying a past upgrade, to check this tool against one done by hand:
//   --from <version> --patch <file>   start from that release and patch instead of the
//                                     current patchedDependencies entry
// After conflicts: resolve them in <out>/merged, then run the same command with
//   --out <dir> --resume [--apply]    the resolved files go through the same checks
// Other options: --out <dir> (default: a fresh directory under the OS temp dir),
// --map <old-path>=<new-path> (when a renamed file is not found on its own), --json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as url from 'node:url';
import {spawnSync} from 'node:child_process';

import {patchedDependencies} from './check-patched-updates.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = process.env.RECUT_ROOT ? path.resolve(process.env.RECUT_ROOT) : path.resolve(__dirname, '..');

// --- arguments -------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {map: new Map(), apply: false, json: false};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--resume') opts.resume = true;
    else if (a === '--from') opts.from = argv[++i];
    else if (a === '--patch') opts.patch = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--map') {
      const [from, to] = (argv[++i] || '').split('=');
      if (!from || !to) usage('--map takes <old-path>=<new-path>');
      opts.map.set(from, to);
    } else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else rest.push(a);
  }
  if (rest.length !== 2) usage('expected <package> <new-version>');
  [opts.pkg, opts.to] = rest;
  if ((opts.from === undefined) !== (opts.patch === undefined)) usage('--from and --patch go together');
  if (opts.apply && opts.from) usage('--apply takes the current patch, not --from/--patch');
  if (opts.resume && !opts.out) usage('--resume needs the --out directory of the run it resumes');
  return opts;
}

function usage(msg) {
  console.error(`recut-patch: ${msg}\n` +
    'usage: node tools/recut-patch.mjs <package> <new-version> [--apply] [--out <dir> [--resume]]\n' +
    '       [--map <old-path>=<new-path>] [--from <version> --patch <file>] [--json]');
  process.exit(1);
}

// --- helpers -----------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  const base = {encoding: 'utf8', maxBuffer: 1 << 30, ...opts};
  // npm and pnpm are .cmd shims on Windows, which Node only starts through a shell - and
  // a shell does not quote arguments, so they are quoted here (paths have spaces).
  const r = process.platform === 'win32' && (cmd === 'npm' || cmd === 'pnpm') ?
    spawnSync([cmd, ...args].map((a) => /[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a).join(' '), {...base, shell: true}) :
    spawnSync(cmd, args, base);
  if (r.error) throw r.error;
  return r;
}

function must(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '');

/** The current patch for a package, from pnpm-workspace.yaml's patchedDependencies. */
function currentPatch(pkg) {
  const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  const entry = patchedDependencies(yaml).find(({name}) => name === pkg);
  if (!entry) throw new Error(`${pkg} has no entry in patchedDependencies`);
  const key = `${pkg}@${entry.version}`;
  const line = yaml.split('\n').find((l) => /^\s/.test(l) && l.replace(/['"]/g, '').trim().startsWith(key + ':'));
  const patch = line.slice(line.indexOf(':', line.indexOf(key) + key.length) + 1).trim();
  return {version: entry.version, patch, line};
}

/**
 * package.json's git spec for a library installed from GitHub (Coloris:
 * `github:mdbassit/Coloris#v0.25.0`), pointed at another version's tag; undefined for a
 * library from the npm registry.
 */
function gitSpec(pkg, version) {
  const pj = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const spec = (pj.dependencies || {})[pkg] || (pj.devDependencies || {})[pkg] || '';
  const m = /^((?:github:|git\+|git:)[^#]+#v?)[^#]+$/.exec(spec);
  return m ? m[1] + version : undefined;
}

/** Downloads and unpacks a release from npm (or GitHub); returns the package directory. */
async function fetchRelease(pkg, version, dir) {
  fs.mkdirSync(dir, {recursive: true});
  const git = gitSpec(pkg, version);
  if (git) {
    // GitHub's archive of the tag. Not `npm pack <git spec>`: npm may be set not to fetch
    // git dependencies (allow-git), and this needs no git at all.
    const m = /^github:([^/#]+)\/([^#]+)#(.+)$/.exec(git);
    if (!m) throw new Error(`${pkg}: only github: git specs are supported (${git})`);
    const res = await fetch(`https://codeload.github.com/${m[1]}/${m[2]}/tar.gz/refs/tags/${m[3]}`);
    if (!res.ok) throw new Error(`${pkg}: GitHub has no tag ${m[3]} (${res.status})`);
    fs.writeFileSync(path.join(dir, 'release.tgz'), Buffer.from(await res.arrayBuffer()));
    const pkgDir = path.join(dir, 'package');
    fs.mkdirSync(pkgDir, {recursive: true});
    // Relative paths: GNU tar reads "C:" in an absolute Windows path as a remote host.
    must('tar', ['-xzf', 'release.tgz', '--strip-components=1', '-C', 'package'], {cwd: dir});
    return pkgDir;
  }
  const spec = `${pkg}@${version}`;
  const out = must('npm', ['pack', spec, '--pack-destination', dir, '--json', '--ignore-scripts'], {cwd: dir});
  // npm 10 prints an array, npm 11 an object keyed by package name.
  const json = JSON.parse(out);
  const packed = Array.isArray(json) ? json[0] : Object.values(json)[0];
  if (!packed || packed.version !== version) throw new Error(`npm pack ${spec} returned ${packed && packed.id}`);
  const file = packed.filename.replace(/^@[^/]+\//, '').replace(/\//g, '-');
  const tarball = fs.readdirSync(dir).find((f) => f.endsWith('.tgz') && (f === file || f.endsWith(file)));
  if (!tarball) throw new Error(`npm pack ${pkg}@${version}: no tarball in ${dir}`);
  must('tar', ['-xzf', tarball], {cwd: dir});
  const pkgDir = path.join(dir, 'package');
  if (!fs.existsSync(pkgDir)) throw new Error(`${tarball} has no package/ directory`);
  return pkgDir;
}

function copyDir(from, to) {
  fs.cpSync(from, to, {recursive: true});
}

/**
 * Applies one file's hunks of a unified diff, the way pnpm does. `git apply` is stricter
 * than pnpm about one thing pnpm's own patches do: dropping a file's last line when it
 * has no final newline, without the "\ No newline at end of file" marker.
 */
function applyHunks(original, hunks, label) {
  const hadEol = original.endsWith('\n');
  const lines = original.split('\n');
  if (hadEol) lines.pop();
  const same = (a, b) => a === b || a.replace(/\r$/, '') === b.replace(/\r$/, '');
  const out = [];
  let pos = 0;
  let eol = hadEol;
  for (const h of hunks) {
    const old = h.lines.filter((l) => l.op !== '+').map((l) => l.text);
    const want = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    const fits = (at) => at >= pos && at + old.length <= lines.length && old.every((l, i) => same(lines[at + i], l));
    let at = -1;
    for (let d = 0; d <= lines.length && at < 0; d++) {
      if (fits(want + d)) at = want + d;
      else if (d && fits(want - d)) at = want - d;
      if (want + d > lines.length && want - d < pos) break;
    }
    if (at < 0) throw new Error(`${label}: hunk @@ -${h.oldStart},${h.oldCount} does not apply`);
    out.push(...lines.slice(pos, at));
    // Context lines come from the file, so a CR the patch text lost is kept.
    let k = at;
    for (const l of h.lines) {
      if (l.op === ' ') out.push(lines[k++]);
      else if (l.op === '-') k++;
      else out.push(l.text);
    }
    pos = at + old.length;
    // At the end of the file a marker decides; without one pnpm keeps the original's.
    if (pos === lines.length) eol = h.newNoEol ? false : h.oldNoEol ? true : hadEol;
  }
  out.push(...lines.slice(pos));
  return out.join('\n') + (eol && out.length ? '\n' : '');
}

/** Splits a unified diff into {file, hunks} per file. */
function parseDiff(patchText) {
  const files = [];
  let file;
  let hunk;
  let last;
  for (const line of patchText.split('\n')) {
    const d = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (d) {
      if (d[1] !== d[2]) throw new Error(`the patch renames ${d[1]} to ${d[2]}; not supported`);
      files.push(file = {file: d[1], hunks: []});
      hunk = undefined;
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      file.hunks.push(hunk = {oldStart: +h[1], oldCount: h[2] === undefined ? 1 : +h[2], lines: []});
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('\\')) {
      if (last === '+' || last === ' ') hunk.newNoEol = true;
      if (last === '-' || last === ' ') hunk.oldNoEol = true;
      continue;
    }
    const op = line[0];
    if (op === ' ' || op === '-' || op === '+') {
      hunk.lines.push({op, text: line.slice(1)});
      last = op;
    } else if (line === '') {
      // The patch file's own final newline, or a blank context line some tools write bare.
      continue;
    }
  }
  return files;
}

/** Paths a unified diff touches (a/ side). */
function patchedFiles(patchText) {
  return [...patchText.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((m) => {
    if (m[1] !== m[2]) throw new Error(`the patch renames ${m[1]} to ${m[2]}; not supported`);
    return m[1];
  });
}

/** Finds a file's counterpart in the new release when a content hash renamed it. */
function renamedCounterpart(rel, theirsDir) {
  const dir = path.dirname(rel);
  const m = /^(.*?)-[A-Za-z0-9_-]{6,}(\.[a-z]+)$/.exec(path.basename(rel));
  if (!m || !fs.existsSync(path.join(theirsDir, dir))) return {candidates: []};
  const candidates = fs.readdirSync(path.join(theirsDir, dir))
      .filter((f) => f.startsWith(m[1] + '-') && f.endsWith(m[2]) && !f.endsWith('.map'))
      .map((f) => path.posix.join(dir.split(path.sep).join('/'), f));
  return {candidates, match: candidates.length === 1 ? candidates[0] : undefined};
}

// --- three-way merges ----------------------------------------------------------------

function mergeText(ours, base, theirs, label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-merge-'));
  try {
    for (const [n, v] of [['ours', ours], ['base', base], ['theirs', theirs]]) fs.writeFileSync(path.join(tmp, n), v);
    const r = run('git', ['merge-file', '-p', '--diff3', '-L', `ours (FastStream)`, '-L', `base`, '-L', `theirs (new release)`,
      path.join(tmp, 'ours'), path.join(tmp, 'base'), path.join(tmp, 'theirs')]);
    if (r.status < 0 || r.status > 127) throw new Error(`git merge-file failed on ${label}: ${r.stderr}`);
    return {text: r.stdout, conflicts: r.status};
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
}

/**
 * Splits a webpack debug bundle into its runtime head, modules keyed by source path,
 * and runtime tail. Returns null for anything that is not one.
 */
function splitWebpack(text) {
  const lines = text.split('\n');
  const starts = [];
  lines.forEach((l, i) => {
    const m = /^\/\*\*\*\/ "(.+)":$/.exec(l);
    if (m) starts.push([i, m[1]]);
  });
  if (starts.length < 2) return null;
  const last = starts.at(-1)[0];
  const end = lines.findIndex((l, i) => i > last && /^\/\*{6}\/ \t?\}\);?$/.test(l));
  if (end < 0) return null;
  const modules = new Map();
  starts.forEach(([i, p], k) => {
    const j = k + 1 < starts.length ? starts[k + 1][0] : end;
    if (modules.has(p)) throw new Error('duplicate webpack module ' + p);
    modules.set(p, lines.slice(i, j).join('\n'));
  });
  return {head: lines.slice(0, starts[0][0]).join('\n'), modules, order: starts.map(([, p]) => p),
    tail: lines.slice(end).join('\n')};
}

function mergeWebpack(b, o, t, label) {
  const report = {theirs: 0, ours: 0, same: 0, merged: [], conflicts: [], removedUpstream: []};
  const part = (name, bv, ov, tv) => {
    if (ov === bv) return tv;
    if (tv === bv || ov === tv) return ov;
    const m = mergeText(ov + '\n', bv + '\n', tv + '\n', `${label} ${name}`);
    (m.conflicts ? report.conflicts : report.merged).push(m.conflicts ? `${name} (${m.conflicts})` : name);
    return m.text.replace(/\n$/, '');
  };
  const out = [];
  const head = part('<webpack head>', b.head, o.head, t.head);
  for (const p of t.order) {
    const bv = b.modules.get(p); const ov = o.modules.get(p); const tv = t.modules.get(p);
    if (ov === undefined || ov === bv) {
      out.push(tv); report.theirs++; continue;
    }
    if (bv === undefined) {
      out.push(part(p, '', ov, tv)); continue;
    } // both added it
    if (tv === bv) {
      out.push(ov); report.ours++; continue;
    }
    if (ov === tv) {
      out.push(ov); report.same++; continue;
    }
    out.push(part(p, bv, ov, tv));
  }
  // Modules FastStream added (not in base), and ones it changed that upstream removed.
  for (const p of o.order) {
    if (t.modules.has(p)) continue;
    const bv = b.modules.get(p); const ov = o.modules.get(p);
    if (bv === undefined) {
      out.push(ov); report.merged.push(`${p} (FastStream's own module, kept)`);
    } else if (ov !== bv) {
      report.removedUpstream.push(p); report.conflicts.push(`${p} (FastStream changed it; the new release no longer has it)`);
    }
  }
  const tail = part('<webpack tail>', b.tail, o.tail, t.tail);
  const text = head + '\n' + out.join('\n') + '\n' + tail;
  return {text, conflicts: report.conflicts.length, report};
}

/**
 * Applies the line changes between norm(raw) and target onto raw, so every untouched
 * line keeps its bytes - stray CRs included - and the patch holds only real changes.
 */
function spliceOnto(raw, target) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-splice-'));
  try {
    fs.writeFileSync(path.join(tmp, 'a'), norm(raw));
    fs.writeFileSync(path.join(tmp, 'b'), target);
    const r = run('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '-U0', '--no-color', 'a', 'b'], {cwd: tmp});
    const rawLines = raw.split('\n');
    const targetLines = target.split('\n');
    const hunks = [...r.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
      os: +m[1], oc: m[2] === undefined ? 1 : +m[2], ns: +m[3], nc: m[4] === undefined ? 1 : +m[4],
    }));
    for (const h of hunks.reverse()) {
      const at = h.oc === 0 ? h.os : h.os - 1;
      const repl = h.nc === 0 ? [] : targetLines.slice(h.ns - 1, h.ns - 1 + h.nc);
      rawLines.splice(at, h.oc, ...repl);
    }
    let out = rawLines.join('\n');
    if (target.endsWith('\n') && !out.endsWith('\n')) out += '\n';
    if (!target.endsWith('\n') && out.endsWith('\n') && !raw.endsWith('\n')) out = out.replace(/\n$/, '');
    if (norm(out) !== target) throw new Error('splicing the merge back onto the release did not reproduce it');
    return out;
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
}

// --- checks ------------------------------------------------------------------------

/**
 * Parses the merged file, and reports any undefined or unused name it has that neither
 * the stock new release has nor the current patch already brought in (those were
 * reviewed when that patch was cut: dash.js's _getL3DBootstrapTracks, whose only caller
 * FastStream removed, is one).
 */
async function checkJavaScript(merged, stock, label, oldBase, oldOurs) {
  const problems = [];
  const acorn = await import('acorn');
  let sourceType = 'module';
  const parse = (text, type) => acorn.parse(text, {ecmaVersion: 'latest', sourceType: type, allowHashBang: true});
  try {
    parse(stock, 'module');
  } catch {
    sourceType = 'script';
  }
  try {
    parse(merged, sourceType);
  } catch (e) {
    return [`${label}: does not parse (${e.message})`];
  }

  const {ESLint} = await import('eslint');
  const globals = (await import('globals')).default;
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ['**/*'],
      languageOptions: {ecmaVersion: 'latest', sourceType, globals: {...globals.browser, ...globals.worker, ...globals.es2021}},
      linterOptions: {noInlineConfig: true, reportUnusedDisableDirectives: 'off'},
      rules: {'no-undef': 'error', 'no-unused-vars': ['error', {args: 'none', caughtErrors: 'none', vars: 'local'}]},
    }],
  });
  const names = async (text) => {
    const [r] = await eslint.lintText(text, {filePath: path.join(root, '__recut-check__.mjs')});
    const counts = new Map();
    for (const m of r.messages.filter((x) => x.ruleId)) {
      const key = `${m.ruleId}: ${m.message}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  };
  const [a, b, oldB, oldO] = await Promise.all([names(stock), names(merged), names(oldBase), names(oldOurs)]);
  for (const [key, n] of b) {
    const before = (a.get(key) || 0) + Math.max(0, (oldO.get(key) || 0) - (oldB.get(key) || 0));
    if (n > before) problems.push(`${label}: ${key}${n - before > 1 ? ` (x${n - before})` : ''}`);
  }
  return problems;
}

// --- main --------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cur = opts.from ? {version: opts.from, patch: opts.patch} : currentPatch(opts.pkg);
  const patchPath = path.resolve(root, cur.patch);
  const patchText = fs.readFileSync(patchPath, 'utf8');
  cur.text = patchText; // --apply puts it back if the install fails
  const files = patchedFiles(patchText);
  if (cur.version === opts.to && !opts.from) {
    console.log(`${opts.pkg} is already patched at ${opts.to}.`);
    return 0;
  }

  const work = opts.out ? path.resolve(opts.out) :
    fs.mkdtempSync(path.join(os.tmpdir(), `recut-${opts.pkg.replace(/[^\w.-]+/g, '_')}-${opts.to}-`));
  if (!opts.resume) fs.rmSync(path.join(work, 'merged'), {recursive: true, force: true});
  const log = (s) => opts.json || console.log(s);
  log(`${opts.pkg}: re-cutting ${path.relative(root, patchPath)} (${cur.version}) onto ${opts.to}\n  working in ${work}`);

  const baseDir = await fetchRelease(opts.pkg, cur.version, path.join(work, 'base'));
  const theirsDir = await fetchRelease(opts.pkg, opts.to, path.join(work, 'theirs'));
  const oursDir = path.join(work, 'ours');
  fs.rmSync(oursDir, {recursive: true, force: true});
  copyDir(baseDir, oursDir);
  for (const {file, hunks} of parseDiff(patchText)) {
    const f = path.join(oursDir, file);
    fs.writeFileSync(f, applyHunks(fs.readFileSync(f, 'utf8'), hunks, file));
  }
  // What pnpm installed is what ships. For the current patch it must be exactly what the
  // hunks above produced, or this tool would be merging something else.
  const installed = path.join(root, 'node_modules', opts.pkg);
  const installedVersion = fs.existsSync(path.join(installed, 'package.json')) &&
    JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version;
  if (installedVersion === cur.version) {
    for (const rel of files) {
      if (!fs.readFileSync(path.join(installed, rel)).equals(fs.readFileSync(path.join(oursDir, rel)))) {
        throw new Error(`${rel}: applying ${cur.patch} to ${opts.pkg} ${cur.version} does not give the installed file - run pnpm install`);
      }
    }
  }

  const result = {package: opts.pkg, from: cur.version, to: opts.to, work, files: [], problems: [], renamed: []};
  for (const rel of files) {
    const base = fs.readFileSync(path.join(baseDir, rel), 'utf8');
    const ours = fs.readFileSync(path.join(oursDir, rel), 'utf8');
    let target = opts.map.get(rel) || rel;
    if (!fs.existsSync(path.join(theirsDir, target))) {
      const {match, candidates} = renamedCounterpart(rel, theirsDir);
      if (!match) {
        result.problems.push(`${rel}: not in ${opts.to}${candidates.length ? ` (candidates: ${candidates.join(', ')})` : ''} - pass --map ${rel}=<new path>`);
        continue;
      }
      target = match;
    }
    if (target !== rel) result.renamed.push({from: rel, to: target});
    const theirsRaw = fs.readFileSync(path.join(theirsDir, target), 'utf8');

    const [b, o, t] = [norm(base), norm(ours), norm(theirsRaw)];
    const wb = splitWebpack(b); const wo = splitWebpack(o); const wt = splitWebpack(t);
    let merged;
    const entry = {file: target, from: rel};
    if (wb && wo && wt) {
      merged = mergeWebpack(wb, wo, wt, target);
      Object.assign(entry, {mode: 'webpack modules', ...merged.report, conflictList: merged.report.conflicts});
    } else {
      merged = mergeText(o, b, t, target);
      Object.assign(entry, {mode: 'whole file'});
    }
    entry.conflicts = merged.conflicts;
    result.files.push(entry);

    const outFile = path.join(work, 'merged', target);
    fs.mkdirSync(path.dirname(outFile), {recursive: true});
    if (opts.resume) {
      // The file a person resolved after an earlier run, instead of this run's merge.
      const resolved = fs.existsSync(outFile) && norm(fs.readFileSync(outFile, 'utf8'));
      if (resolved === false) {
        result.problems.push(`${target}: --resume, but ${outFile} is not there`);
        continue;
      }
      if (/^(<{7}|\|{7}|={7}|>{7})( |$)/m.test(resolved)) {
        result.problems.push(`${target}: conflict markers are still in ${outFile}`);
        continue;
      }
      merged = {text: resolved, conflicts: 0};
      entry.conflicts = 0;
      entry.resumed = true;
    }
    if (merged.conflicts) {
      fs.writeFileSync(outFile, merged.text);
      result.problems.push(`${target}: ${merged.conflicts} conflict(s), marked in ${outFile}`);
      continue;
    }
    const final = spliceOnto(theirsRaw, merged.text);
    fs.writeFileSync(outFile, final);
    if (final === theirsRaw) {
      result.problems.push(`${target}: FastStream's changes are all in ${opts.to} already - the patch can be dropped for this file`);
      entry.landed = true;
    }
    if (/\.(m?js|cjs)$/.test(target)) {
      result.problems.push(...await checkJavaScript(norm(final), t, target, b, o));
    }
  }

  const clean = result.problems.every((p) => p.includes('can be dropped'));
  if (opts.json) {
    console.log(JSON.stringify({...result, clean}, null, 2));
  } else {
    for (const f of result.files) {
      const extra = f.mode === 'webpack modules' ?
        ` - modules: ${f.theirs} as released, ${f.ours} as patched, ${f.same} identical, ` +
        `${f.merged.length} merged${f.merged.length ? ` (${f.merged.join(', ')})` : ''}` : '';
      console.log(`  ${f.file}${f.from !== f.file ? ` (was ${f.from})` : ''}: ${f.mode}, ${f.conflicts} conflict(s)${extra}`);
      for (const c of f.conflictList || []) console.log(`      conflict: ${c}`);
    }
    console.log(result.problems.length ? '\n' + result.problems.map((p) => '  ! ' + p).join('\n') : '\n  merged cleanly; parse and undefined-name checks passed');
  }
  if (!clean) {
    if (!opts.json) {
      console.log(`\nNot applied. Resolve what is listed above in ${path.join(work, 'merged')}, then:\n` +
        `  node tools/recut-patch.mjs ${opts.pkg} ${opts.to} --out "${work}" --resume --apply\n` +
        '(docs/updating-patched-libraries.md)');
    }
    return 2;
  }
  if (!opts.apply) {
    log(`\nClean. Run again with --apply to take ${opts.pkg} ${opts.to}.`);
    return 0;
  }
  return applyUpdate(opts, cur, result, work);
}

function applyUpdate(opts, cur, result, work) {
  const {pkg, to} = opts;
  const from = cur.version;
  // package.json: keep the range prefix (hls.js is "^1.7.3").
  const pj = path.join(root, 'package.json');
  const pjText = fs.readFileSync(pj, 'utf8');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A registry range keeps its prefix; a git spec moves to the new version's tag.
  const verRe = new RegExp(`("${esc(pkg)}":\\s*"(?:[~^]?|(?:github:|git\\+|git:)[^#"]+#v?))${esc(from)}"`);
  if (!verRe.test(pjText)) throw new Error(`package.json has no "${pkg}" at ${from}`);
  fs.writeFileSync(pj, pjText.replace(verRe, `$1${to}"`));

  const ws = path.join(root, 'pnpm-workspace.yaml');
  const wsText = fs.readFileSync(ws, 'utf8');
  fs.writeFileSync(ws, wsText.replace(cur.line + '\n', ''));
  fs.rmSync(path.join(root, cur.patch));

  // Not frozen: pnpm freezes the lockfile by default in CI, and this has to change it.
  const install = run('pnpm', ['install', '--no-frozen-lockfile'], {cwd: root});
  if (install.status !== 0) {
    const text = install.stdout + install.stderr;
    fs.writeFileSync(pj, pjText);
    fs.writeFileSync(ws, wsText);
    fs.writeFileSync(path.join(root, cur.patch), cur.text);
    // pnpm 11: ERR_PNPM_NO_MATURE_MATCHING_VERSION.
    if (/NO_MATURE_MATCHING_VERSION|minimumReleaseAge/i.test(text)) {
      console.error(`${pkg} ${to} is newer than pnpm's minimumReleaseAge allows. Nothing changed; try again later.`);
      return 3;
    }
    throw new Error(`pnpm install failed; package.json and pnpm-workspace.yaml restored:\n${text}`);
  }

  const edit = path.join(work, 'pnpm-patch');
  fs.rmSync(edit, {recursive: true, force: true});
  must('pnpm', ['patch', `${pkg}@${to}`, '--edit-dir', edit], {cwd: root});
  for (const f of result.files) {
    if (f.landed) continue;
    fs.copyFileSync(path.join(work, 'merged', f.file), path.join(edit, f.file));
  }
  if (result.files.every((f) => f.landed)) {
    console.log(`Every change has landed in ${pkg} ${to}: the patch is dropped. ` +
      `Remove the \`patched: true\` marks in tools/sync-vendor.mjs and ${pkg} from .github/dependabot.yml's ignore list.`);
  } else {
    must('pnpm', ['patch-commit', edit], {cwd: root});
  }

  // A renamed chunk is named in tools/sync-vendor.mjs (mp4box's MP4BOX_CHUNKS).
  const sv = path.join(root, 'tools/sync-vendor.mjs');
  let svText = fs.readFileSync(sv, 'utf8');
  for (const {from: a, to: b} of result.renamed) svText = svText.split(path.posix.basename(a)).join(path.posix.basename(b));
  fs.writeFileSync(sv, svText);

  const sync = run('node', ['tools/sync-vendor.mjs'], {cwd: root});
  process.stdout.write(sync.stdout);
  if (sync.status !== 0) {
    console.error(sync.stderr + '\ntools/sync-vendor.mjs failed - an unpatched file was probably renamed too; fix it there, then `pnpm run verify`.');
    return 2;
  }
  console.log(`\n${pkg} ${from} -> ${to} applied. Next: pnpm run verify (docs/updating-patched-libraries.md).`);
  return 0;
}

export {applyHunks, parseDiff, patchedFiles, renamedCounterpart, mergeText, splitWebpack, mergeWebpack, spliceOnto, checkJavaScript};

// Run as a command; imported (tests/unit/recutPatch.test.mjs), it only exports the above.
if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => {
    console.error(`recut-patch: ${e.message}`);
    process.exit(1);
  });
}
