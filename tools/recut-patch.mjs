// @ts-check
// Re-cuts a library's pnpm patch onto a newer release of that library.
//   node tools/recut-patch.mjs <package> <new-version>          report only
//   node tools/recut-patch.mjs <package> <new-version> --apply  and take it
// Per patched file: a three-way merge of ours (base + patch) onto theirs (the new release), by module for a
// webpack bundle; on a conflict, the patch's hunks are tried where their lines occur exactly once.
// Each merged JavaScript file must parse and add no no-undef/no-unused-vars name: a clean merge is not a correct one.
// Exit status: 0 merged and checked, 1 usage or setup error, 2 conflicts or a failed check, 3 too new (minimumReleaseAge).
// --apply (after a clean run) bumps, installs, commits the patch and regenerates; `pnpm run verify` proves playback.
// Replaying a past upgrade:
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
// This repository, always (CodeQL js/path-injection).
const root = path.resolve(__dirname, '..');

/**
 * The command line, parsed.
 * @typedef {Object} RecutOptions
 * @property {Map<string, string>} map - --map: a file's old path to its new one.
 * @property {boolean} apply
 * @property {boolean} json
 * @property {boolean} [resume]
 * @property {string} [from] - --from: the release to start from; always with patch.
 * @property {string} [patch]
 * @property {string} [out]
 * @property {string} pkg
 * @property {string} to - The new version.
 */

/**
 * @param {string[]} argv
 * @return {RecutOptions}
 */
function parseArgs(argv) {
  // pkg and to are set below, from the two arguments that are not options.
  const opts = /** @type {RecutOptions} */ ({map: new Map(), apply: false, json: false});
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
  // npm shapes only: both reach paths and a shell command (CodeQL js/path-injection, js/command-line-injection).
  if (!/^@[\w.-]+\/[\w.-]+$|^[A-Za-z0-9][\w.-]*$/.test(opts.pkg)) usage(`not an npm package name: ${opts.pkg}`);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][\w.-]+)?$/.test(opts.to)) usage(`not a version: ${opts.to}`);
  if (opts.patch && !/^[\w/@.-]+\.patch$/.test(opts.patch)) usage(`not a patch file: ${opts.patch}`);
  if ((opts.from === undefined) !== (opts.patch === undefined)) usage('--from and --patch go together');
  if (opts.apply && opts.from) usage('--apply takes the current patch, not --from/--patch');
  if (opts.resume && !opts.out) usage('--resume needs the --out directory of the run it resumes');
  return opts;
}

/**
 * @param {string} msg
 * @return {never} It exits.
 */
function usage(msg) {
  console.error(`recut-patch: ${msg}\n` +
    'usage: node tools/recut-patch.mjs <package> <new-version> [--apply] [--out <dir> [--resume]]\n' +
    '       [--map <old-path>=<new-path>] [--from <version> --patch <file>] [--json]');
  process.exit(1);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string}} [opts]
 * @return {import('node:child_process').SpawnSyncReturns<string>}
 */
function run(cmd, args, opts = {}) {
  const base = /** @type {{encoding: 'utf8', maxBuffer: number}} */ ({encoding: 'utf8', maxBuffer: 1 << 30, ...opts});
  // npm and pnpm are .cmd shims on Windows, started through a shell that does not quote: quoted here,
  // % included, since cmd.exe expands %VAR% inside double quotes (CodeQL js/command-line-injection).
  const r = process.platform === 'win32' && (cmd === 'npm' || cmd === 'pnpm') ?
    spawnSync([cmd, ...args].map((a) => /[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a).join(' '), {...base, shell: true}) :
    spawnSync(cmd, args, base);
  if (r.error) throw r.error;
  return r;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string}} [opts]
 * @return {string} Its stdout.
 */
function must(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

const norm = /** @param {string} s @return {string} */ (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '');

/**
 * The patch being moved onto the new release.
 * @typedef {Object} PatchInUse
 * @property {string} version - The release it is cut against.
 * @property {string} patch - Its file, relative to the repository.
 * @property {string} [line] - Its line in pnpm-workspace.yaml (not with --from).
 * @property {string} [text]
 */

/**
 * The current patch for a package, from pnpm-workspace.yaml's patchedDependencies.
 * @param {string} pkg
 * @return {PatchInUse}
 */
function currentPatch(pkg) {
  const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  const entry = patchedDependencies(yaml).find(({name}) => name === pkg);
  if (!entry) throw new Error(`${pkg} has no entry in patchedDependencies`);
  const key = `${pkg}@${entry.version}`;
  const line = /** @type {string} */ (yaml.split('\n').find((l) => /^\s/.test(l) && l.replace(/['"]/g, '').trim().startsWith(key + ':')));
  const patch = line.slice(line.indexOf(':', line.indexOf(key) + key.length) + 1).trim();
  return {version: entry.version, patch, line};
}

/**
 * package.json's git spec for a library from GitHub (`github:mdbassit/Coloris#v0.25.0`) at another version's tag;
 * undefined for an npm library.
 * @param {string} pkg
 * @param {string} version
 * @return {string|undefined}
 */
function gitSpec(pkg, version) {
  const pj = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const spec = (pj.dependencies || {})[pkg] || (pj.devDependencies || {})[pkg] || '';
  const m = /^((?:github:|git\+|git:)[^#]+#v?)[^#]+$/.exec(spec);
  return m ? m[1] + version : undefined;
}

/**
 * Downloads and unpacks a release from npm (or GitHub); returns the package directory.
 * @param {string} pkg
 * @param {string} version
 * @param {string} dir - Where to unpack it.
 * @return {Promise<string>}
 */
async function fetchRelease(pkg, version, dir) {
  fs.mkdirSync(dir, {recursive: true});
  const git = gitSpec(pkg, version);
  if (git) {
    // GitHub's archive of the tag, not `npm pack <git spec>`: npm may be set not to fetch git dependencies.
    const m = /^github:([\w.-]+)\/([\w.-]+)#([\w.-]+)$/.exec(git);
    if (!m) throw new Error(`${pkg}: only github: git specs are supported (${git})`);
    // The host is pinned and the owner/repo/tag shapes are checked (CodeQL js/request-forgery).
    if (!/^[a-zA-Z0-9._-]+$/.test(m[3])) throw new Error(`${pkg}: unsupported tag ${m[3]}`);
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

/**
 * @param {string} from
 * @param {string} to
 */
function copyDir(from, to) {
  fs.cpSync(from, to, {recursive: true});
}

/**
 * Applies one file's hunks the way pnpm does: `git apply` refuses what pnpm's own patches do,
 * dropping a last line that has no final newline without the "No newline at end of file" marker.
 * @param {string} original
 * @param {Hunk[]} hunks
 * @param {string} label
 * @return {string}
 */
function applyHunks(original, hunks, label) {
  const hadEol = original.endsWith('\n');
  const lines = original.split('\n');
  if (hadEol) lines.pop();
  const same = /** @param {string} a @param {string} b */ (a, b) => a === b || a.replace(/\r$/, '') === b.replace(/\r$/, '');
  const out = [];
  let pos = 0;
  let eol = hadEol;
  for (const h of hunks) {
    const old = h.lines.filter((l) => l.op !== '+').map((l) => l.text);
    const want = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    const fits = /** @param {number} at - A line index. */ (at) => at >= pos && at + old.length <= lines.length && old.every((l, i) => same(lines[at + i], l));
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

/**
 * Applies a patch's hunks to a newer release, each where its old lines occur exactly once, in any order:
 * a reordered bundle moves FastStream's changes. A hunk whose old lines are missing or repeated is not guessed at.
 * @param {string} text - The new release's file, CRs taken out (norm).
 * @param {Hunk[]} hunks
 * @return {{text?: string, failed: string[]}} text: when every hunk applied; failed: why each one did not.
 */
function applyHunksByContext(text, hunks) {
  const lines = text.split('\n');
  const failed = [];
  /** @type {Array<{at: number, old: number, lines: string[], hunk: string}>} */
  const placed = [];
  for (const h of hunks) {
    const hunk = `@@ -${h.oldStart},${h.oldCount}`;
    // An end-of-file marker ties a hunk to the last line, which a reordered file moves.
    if (h.newNoEol || h.oldNoEol) {
      failed.push(`${hunk} (at the end of the file)`); continue;
    }
    const old = h.lines.filter((l) => l.op !== '+').map((l) => l.text);
    if (!old.length) {
      failed.push(`${hunk} (no context to find it by)`); continue;
    }
    const at = [];
    for (let i = 0; i + old.length <= lines.length; i++) {
      if (lines[i] === old[0] && old.every((l, k) => lines[i + k] === l)) at.push(i);
    }
    if (at.length !== 1) {
      const first = (old.find((l) => l.trim()) || '').trim().slice(0, 60);
      failed.push(`${hunk} ("${first}") is ${at.length ? `there ${at.length} times` : 'not there'}`);
      continue;
    }
    placed.push({at: at[0], old: old.length, lines: h.lines.filter((l) => l.op !== '-').map((l) => l.text), hunk});
  }
  placed.sort((a, b) => a.at - b.at);
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].at < placed[i - 1].at + placed[i - 1].old) failed.push(`${placed[i].hunk} (overlaps ${placed[i - 1].hunk})`);
  }
  if (failed.length) return {failed};
  for (const p of placed.reverse()) lines.splice(p.at, p.old, ...p.lines);
  return {text: lines.join('\n'), failed};
}

/**
 * One hunk of a unified diff.
 * @typedef {Object} Hunk
 * @property {number} oldStart
 * @property {number} oldCount
 * @property {Array<{op: ' '|'-'|'+', text: string}>} lines
 * @property {boolean} [newNoEol] - The new side's last line has no newline.
 * @property {boolean} [oldNoEol] - The old side's last line has no newline.
 */

/**
 * Splits a unified diff into {file, hunks} per file; deleted: the patch deletes the file.
 * @param {string} patchText
 * @return {Array<{file: string, hunks: Hunk[], deleted?: boolean}>}
 */
function parseDiff(patchText) {
  /** @type {Array<{file: string, hunks: Hunk[], deleted?: boolean}>} */
  const files = [];
  /** @type {{file: string, hunks: Hunk[], deleted?: boolean}|undefined} */
  let file;
  /** @type {Hunk|undefined} */
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
    if (file && !hunk && /^deleted file mode /.test(line)) {
      file.deleted = true;
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

/**
 * Paths a unified diff touches (a/ side).
 * @param {string} patchText
 * @return {string[]}
 */
function patchedFiles(patchText) {
  return [...patchText.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((m) => {
    if (m[1] !== m[2]) throw new Error(`the patch renames ${m[1]} to ${m[2]}; not supported`);
    return m[1];
  });
}

/**
 * Finds a file's counterpart in the new release when a content hash renamed it.
 * @param {string} rel
 * @param {string} theirsDir
 * @return {{candidates: string[], match?: string}} match: the one candidate, if one.
 */
function renamedCounterpart(rel, theirsDir) {
  const dir = path.dirname(rel);
  const m = /^(.*?)-[A-Za-z0-9_-]{6,}(\.[a-z]+)$/.exec(path.basename(rel));
  if (!m || !fs.existsSync(path.join(theirsDir, dir))) return {candidates: []};
  const candidates = fs.readdirSync(path.join(theirsDir, dir))
      .filter((f) => f.startsWith(m[1] + '-') && f.endsWith(m[2]) && !f.endsWith('.map'))
      .map((f) => path.posix.join(dir.split(path.sep).join('/'), f));
  return {candidates, match: candidates.length === 1 ? candidates[0] : undefined};
}

/**
 * Rewrites every content-hashed chunk name in tools/sync-vendor.mjs to its counterpart in the new release:
 * a patch records only the chunk it patches, and a stale name fails the sync's checkMp4boxImports.
 * @param {string} text
 * @param {string} distDir
 * @param {{from: string, to: string}[]} known - Renames the patch recorded; their new names are already in the text.
 * @return {{text: string, renamed: {from: string, to: string}[]}} The reworked text and every rename applied.
 */
function renameHashedChunks(text, distDir, known) {
  const renamed = [...known];
  for (const {from, to} of known) {
    text = text.split(path.posix.basename(from)).join(path.posix.basename(to));
  }
  // The patch's renames are not looked at again, or a second pass would rename them onward.
  const seen = new Set(renamed.map(({to}) => path.posix.basename(to)));
  for (const entry of text.matchAll(/['"]([^'"]*?-[A-Za-z0-9_-]{6,}\.(?:mjs|js|cjs))['"]/g)) {
    const rel = entry[1];
    if (seen.has(rel)) continue;
    seen.add(rel);
    const {match} = renamedCounterpart(rel, distDir);
    // Itself as the one candidate: the name is current.
    if (!match || match === rel) continue;
    text = text.split(path.posix.basename(rel)).join(path.posix.basename(match));
    renamed.push({from: rel, to: match});
  }
  return {text, renamed};
}

/**
 * @param {string} ours
 * @param {string} base
 * @param {string} theirs
 * @param {string} label
 * @return {{text: string, conflicts: number}} conflicts: how many git merge-file marked.
 */
function mergeText(ours, base, theirs, label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-merge-'));
  try {
    for (const [n, v] of [['ours', ours], ['base', base], ['theirs', theirs]]) fs.writeFileSync(path.join(tmp, n), v);
    const r = /** @type {{status: number, stdout: string, stderr: string}} */ (run('git', ['merge-file', '-p', '--diff3', '-L', `ours (FastStream)`, '-L', `base`, '-L', `theirs (new release)`,
      path.join(tmp, 'ours'), path.join(tmp, 'base'), path.join(tmp, 'theirs')]));
    if (r.status < 0 || r.status > 127) throw new Error(`git merge-file failed on ${label}: ${r.stderr}`);
    return {text: r.stdout, conflicts: r.status};
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
}

/**
 * Splits a webpack debug bundle into its runtime head, modules keyed by source path, and runtime tail;
 * null for anything else.
 * @param {string} text
 * @return {?WebpackParts}
 */
function splitWebpack(text) {
  const lines = text.split('\n');
  /** @type {Array<[number, string]>} Each module's first line, and its source path. */
  const starts = [];
  lines.forEach((l, i) => {
    const m = /^\/\*\*\*\/ "(.+)":$/.exec(l);
    if (m) starts.push([i, m[1]]);
  });
  if (starts.length < 2) return null;
  const last = /** @type {[number, string]} */ (starts.at(-1))[0];
  const end = lines.findIndex((l, i) => i > last && /^\/\*{6}\/ \t?\}\);?$/.test(l));
  if (end < 0) return null;
  /** @type {Map<string, string>} */
  const modules = new Map();
  starts.forEach(([i, p], k) => {
    const j = k + 1 < starts.length ? starts[k + 1][0] : end;
    if (modules.has(p)) throw new Error('duplicate webpack module ' + p);
    modules.set(p, lines.slice(i, j).join('\n'));
  });
  return {head: lines.slice(0, starts[0][0]).join('\n'), modules, order: starts.map(([, p]) => p),
    tail: lines.slice(end).join('\n')};
}

/**
 * A webpack debug bundle, cut up by splitWebpack.
 * @typedef {Object} WebpackParts
 * @property {string} head - The runtime before the modules.
 * @property {Map<string, string>} modules - Source path to the module's text.
 * @property {string[]} order - The source paths, in bundle order.
 * @property {string} tail - The runtime after the modules.
 */

/**
 * @param {WebpackParts} b - Base.
 * @param {WebpackParts} o - Ours.
 * @param {WebpackParts} t - Theirs.
 * @param {string} label
 */
function mergeWebpack(b, o, t, label) {
  /** @type {{theirs: number, ours: number, same: number, merged: string[], conflicts: string[], removedUpstream: string[]}} */
  const report = {theirs: 0, ours: 0, same: 0, merged: [], conflicts: [], removedUpstream: []};
  const part = /** @param {string} name @param {string} bv @param {string} ov @param {string} tv */ (name, bv, ov, tv) => {
    if (ov === bv) return tv;
    if (tv === bv || ov === tv) return ov;
    const m = mergeText(ov + '\n', bv + '\n', tv + '\n', `${label} ${name}`);
    (m.conflicts ? report.conflicts : report.merged).push(m.conflicts ? `${name} (${m.conflicts})` : name);
    return m.text.replace(/\n$/, '');
  };
  const out = [];
  const head = part('<webpack head>', b.head, o.head, t.head);
  for (const p of t.order) {
    const bv = b.modules.get(p); const ov = o.modules.get(p); const tv = /** @type {string} t.order lists its modules. */ (t.modules.get(p));
    if (ov === bv) {
      out.push(tv); report.theirs++; continue;
    }
    if (ov === undefined) {
      // In base and the new release, not in ours: the patch deleted it, so it stays deleted;
      // one the new release changed too is for a person to decide.
      if (tv === bv) {
        report.merged.push(`${p} (FastStream's deletion, kept)`);
      } else {
        report.conflicts.push(`${p} (FastStream deleted it; the new release changed it)`);
      }
      continue;
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
 * Applies the line changes between norm(raw) and target onto raw: untouched lines keep their bytes, stray CRs included.
 * @param {string} raw - The new release's file.
 * @param {string} target - The merge, CRs taken out (norm).
 * @return {string}
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

/**
 * Parses the merged file and reports any undefined or unused name that neither the stock new release
 * nor the current patch already has.
 * @param {string} merged
 * @param {string} stock - The new release's file.
 * @param {string} label
 * @param {string} oldBase - The release the current patch is cut against.
 * @param {string} oldOurs - That release, patched.
 * @return {Promise<string[]>}
 */
async function checkJavaScript(merged, stock, label, oldBase, oldOurs) {
  const problems = [];
  const acorn = await import('acorn');
  /** @type {'module'|'script'} */
  let sourceType = 'module';
  const parse = /** @param {string} text @param {'module'|'script'} type */ (text, type) => acorn.parse(text, {ecmaVersion: 'latest', sourceType: type, allowHashBang: true});
  try {
    parse(stock, 'module');
  } catch {
    sourceType = 'script';
  }
  try {
    parse(merged, sourceType);
  } catch (e) {
    return [`${label}: does not parse (${/** @type {Error} */ (e).message})`];
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
  const names = /** @param {string} text */ async (text) => {
    const [r] = await eslint.lintText(text, {filePath: path.join(root, '__recut-check__.mjs')});
    /** @type {Map<string, number>} */
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

/**
 * One file the patch touches: its paths in each release and how its merge went.
 * @typedef {Object} MergedFile
 * @property {string} file - Its path in the new release.
 * @property {string} from - Its path in the release the patch was cut against.
 * @property {number} conflicts
 * @property {string} [mode]
 * @property {number} [theirs]
 * @property {number} [ours]
 * @property {number} [same]
 * @property {string[]} merged - Modules merged or kept; empty for a whole-file merge.
 * @property {string[]} [removedUpstream]
 * @property {string[]} [conflictList]
 * @property {{conflicts: number, hunks: number}} [byContext] - A conflicting merge taken from the patch's hunks instead.
 * @property {string[]} [contextMisses] - Why the hunks did not fit.
 * @property {boolean} [resumed]
 * @property {boolean} [deleted] - The patch deletes the file.
 * @property {boolean} [landed]
 */

/**
 * What a run found, per file, and the problems that keep --apply from going on.
 * @typedef {Object} RecutResult
 * @property {string} package
 * @property {string} from
 * @property {string} to
 * @property {string} work - The working directory.
 * @property {MergedFile[]} files
 * @property {string[]} problems
 * @property {{from: string, to: string}[]} renamed - Files a content hash renamed.
 */

/** @return {Promise<number>} The exit status. */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // --from comes with --patch (parseArgs).
  /** @type {PatchInUse} */
  const cur = opts.from ? {version: opts.from, patch: /** @type {string} */ (opts.patch)} : currentPatch(opts.pkg);
  const patchPath = path.resolve(root, cur.patch);
  const patchText = fs.readFileSync(patchPath, 'utf8');
  cur.text = patchText; // --apply puts it back if the install fails
  const files = patchedFiles(patchText);
  // An empty patch changes no file: every check would pass over nothing.
  if (files.length === 0) throw new Error(`${cur.patch} changes no file (empty, or no git diff): nothing to move`);
  if (cur.version === opts.to && !opts.from) {
    console.log(`${opts.pkg} is already patched at ${opts.to}.`);
    return 0;
  }

  const work = opts.out ? path.resolve(opts.out) :
    fs.mkdtempSync(path.join(os.tmpdir(), `recut-${opts.pkg.replace(/[^\w.-]+/g, '_')}-${opts.to}-`));
  if (!opts.resume) fs.rmSync(path.join(work, 'merged'), {recursive: true, force: true});
  const log = /** @param {string} s */ (s) => opts.json || console.log(s);
  log(`${opts.pkg}: re-cutting ${path.relative(root, patchPath)} (${cur.version}) onto ${opts.to}\n  working in ${work}`);

  const baseDir = await fetchRelease(opts.pkg, cur.version, path.join(work, 'base'));
  const theirsDir = await fetchRelease(opts.pkg, opts.to, path.join(work, 'theirs'));
  const oursDir = path.join(work, 'ours');
  fs.rmSync(oursDir, {recursive: true, force: true});
  copyDir(baseDir, oursDir);
  /** @type {Map<string, Hunk[]>} */
  const patchHunks = new Map();
  /** @type {Set<string>} */
  const deleted = new Set();
  for (const {file, hunks, deleted: gone} of parseDiff(patchText)) {
    const f = path.join(oursDir, file);
    if (gone) {
      fs.rmSync(f, {force: true});
      deleted.add(file);
      continue;
    }
    fs.writeFileSync(f, applyHunks(fs.readFileSync(f, 'utf8'), hunks, file));
    patchHunks.set(file, hunks);
  }
  // What pnpm installed is what ships: for the current patch it must equal what the hunks produced.
  const installed = path.join(root, 'node_modules', opts.pkg);
  const installedVersion = fs.existsSync(path.join(installed, 'package.json')) &&
    JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version;
  if (installedVersion === cur.version) {
    for (const rel of files) {
      if (deleted.has(rel)) {
        if (fs.existsSync(path.join(installed, rel))) {
          throw new Error(`${rel}: ${cur.patch} deletes it, but it is installed - run pnpm install`);
        }
        continue;
      }
      if (!fs.readFileSync(path.join(installed, rel)).equals(fs.readFileSync(path.join(oursDir, rel)))) {
        throw new Error(`${rel}: applying ${cur.patch} to ${opts.pkg} ${cur.version} does not give the installed file - run pnpm install`);
      }
    }
  }

  /** @type {RecutResult} */
  const result = {package: opts.pkg, from: cur.version, to: opts.to, work, files: [], problems: [], renamed: []};
  for (const rel of files) {
    if (deleted.has(rel)) {
      // Nothing to merge: the new patch deletes it again, unless the release dropped it.
      const landed = !fs.existsSync(path.join(theirsDir, rel));
      result.files.push({file: rel, from: rel, conflicts: 0, mode: 'deleted', merged: [], deleted: true, landed});
      if (landed) result.problems.push(`${rel}: FastStream's changes are all in ${opts.to} already - the patch can be dropped for this file`);
      continue;
    }
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
    const entry = /** @type {MergedFile} */ ({file: target, from: rel});
    if (wb && wo && wt) {
      merged = mergeWebpack(wb, wo, wt, target);
      Object.assign(entry, {mode: 'webpack modules', ...merged.report, conflictList: merged.report.conflicts});
    } else {
      merged = mergeText(o, b, t, target);
      Object.assign(entry, {mode: 'whole file'});
    }
    if (merged.conflicts) {
      // A reordered bundle throws the three-way merge off; the patch's own hunks may still fit.
      const hunks = (patchHunks.get(rel) || []).map((h) => ({...h, lines: h.lines.map((l) => ({...l, text: l.text.replace(/\r$/, '')}))}));
      const byContext = applyHunksByContext(t, hunks);
      if (byContext.text !== undefined) {
        entry.byContext = {conflicts: merged.conflicts, hunks: hunks.length};
        delete entry.conflictList;
        merged = {text: byContext.text, conflicts: 0};
      } else {
        entry.contextMisses = byContext.failed;
      }
    }
    entry.conflicts = merged.conflicts;
    result.files.push(entry);

    const outFile = path.join(work, 'merged', target);
    fs.mkdirSync(path.dirname(outFile), {recursive: true});
    if (opts.resume) {
      // The file a person resolved after an earlier run, instead of this run's merge.
      const resolved = fs.existsSync(outFile) && norm(fs.readFileSync(outFile, 'utf8'));
      // An empty file would pass every check below.
      if (resolved === false || !resolved.trim()) {
        result.problems.push(`${target}: --resume, but ${outFile} is not there or empty`);
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
      result.problems.push(`${target}: ${merged.conflicts} conflict(s), marked in ${outFile}` +
        (entry.contextMisses ? `; FastStream's hunks do not fit ${opts.to} as they are either: ${entry.contextMisses.join(', ')}` : ''));
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
      const extra = (f.mode === 'webpack modules' ?
        ` - modules: ${f.theirs} as released, ${f.ours} as patched, ${f.same} identical, ` +
        `${f.merged.length} merged${f.merged.length ? ` (${f.merged.join(', ')})` : ''}` : '') +
        (f.byContext ? ` - the three-way merge marked ${f.byContext.conflicts}; all ${f.byContext.hunks} of the patch's hunks fit ${opts.to} by their context instead` : '');
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
  // --apply takes the current patch (parseArgs), which has its line; its text is read above.
  return applyUpdate(opts, /** @type {PatchInUse & {line: string, text: string}} */ (cur), result, work);
}

/**
 * Takes names off .github/dependabot.yml's ignore list (a library whose patch is dropped).
 * @param {string[]} names
 * @param {string} [file] - The Dependabot config.
 * @return {string[]} The names that were on the list.
 */
function dropDependabotIgnores(names, file = path.join(root, '.github/dependabot.yml')) {
  /** @type {string[]} */
  const dropped = [];
  const kept = fs.readFileSync(file, 'utf8').split('\n').filter((line) => {
    const entry = /^\s*- dependency-name: '([^']+)'\s*$/.exec(line);
    if (!entry || !names.includes(entry[1])) return true;
    dropped.push(entry[1]);
    return false;
  });
  fs.writeFileSync(file, kept.join('\n'));
  return dropped;
}

/**
 * package.json with a library moved from one version to another.
 * @param {string} text
 * @param {string} pkg
 * @param {string} from
 * @param {string} to
 * @return {string}
 */
function bumpPackageJson(text, pkg, from, to) {
  const esc = /** @param {string} s */ (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A registry range keeps its prefix; a git spec moves to the new version's tag.
  const verRe = new RegExp(`("${esc(pkg)}":\\s*"(?:[~^]?|(?:github:|git\\+|git:)[^#"]+#v?))${esc(from)}"`);
  if (!verRe.test(text)) throw new Error(`package.json has no "${pkg}" at ${from}`);
  return text.replace(verRe, `$1${to}"`);
}

/**
 * --apply: takes the new release, with the merged patch.
 * @param {RecutOptions} opts
 * @param {PatchInUse & {line: string, text: string}} cur - The current patch.
 * @param {RecutResult} result - A clean run's.
 * @param {string} work - The working directory.
 * @return {number} The exit status.
 */
function applyUpdate(opts, cur, result, work) {
  const {pkg, to} = opts;
  const from = cur.version;
  const pj = path.join(root, 'package.json');
  const pjText = fs.readFileSync(pj, 'utf8');
  fs.writeFileSync(pj, bumpPackageJson(pjText, pkg, from, to));

  const ws = path.join(root, 'pnpm-workspace.yaml');
  const wsText = fs.readFileSync(ws, 'utf8');
  fs.writeFileSync(ws, wsText.replace(cur.line + '\n', ''));
  fs.rmSync(path.join(root, cur.patch));

  // Not frozen: this has to change the lockfile. No install scripts: none of the new release's code runs here.
  const install = run('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts'], {cwd: root});
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
    if (f.deleted) fs.rmSync(path.join(edit, f.file), {force: true});
    else fs.copyFileSync(path.join(work, 'merged', f.file), path.join(edit, f.file));
  }
  if (result.files.every((f) => f.landed)) {
    // Dependabot takes the library back.
    const handedBack = dropDependabotIgnores([pkg]);
    console.log(`Every change has landed in ${pkg} ${to}: the patch is dropped` +
      (handedBack.length ? `, and Dependabot updates ${handedBack.join(' and ')} again (.github/dependabot.yml)` : '') +
      `. Remove any \`patched: true\` marks for ${pkg} in tools/sync-vendor.mjs.`);
  } else {
    must('pnpm', ['patch-commit', edit], {cwd: root});
  }

  // Every hashed chunk name in tools/sync-vendor.mjs gets its new-release counterpart, patch renames first.
  const sv = path.join(root, 'tools/sync-vendor.mjs');
  const svText = fs.readFileSync(sv, 'utf8');
  const {text, renamed} = renameHashedChunks(svText, path.join(root, 'node_modules', pkg, 'dist'), result.renamed);
  for (const {from, to} of renamed) console.log(`  ${from} renamed to ${to} in tools/sync-vendor.mjs`);
  fs.writeFileSync(sv, text);

  const sync = run('node', ['tools/sync-vendor.mjs'], {cwd: root});
  process.stdout.write(sync.stdout);
  if (sync.status !== 0) {
    console.error(sync.stderr + '\ntools/sync-vendor.mjs failed - an unpatched file was probably renamed too; fix it there, then `pnpm run verify`.');
    return 2;
  }
  console.log(`\n${pkg} ${from} -> ${to} applied. Next: pnpm run verify (docs/updating-patched-libraries.md).`);
  return 0;
}

export {applyHunks, applyHunksByContext, bumpPackageJson, dropDependabotIgnores, parseDiff, patchedFiles, renamedCounterpart, renameHashedChunks, mergeText, splitWebpack, mergeWebpack, spliceOnto, checkJavaScript};

// Run as a command; imported (tests/unit/recutPatch.test.mjs), it only exports the above.
if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => {
    console.error(`recut-patch: ${e.message}`);
    process.exit(1);
  });
}
