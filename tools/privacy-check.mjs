#!/usr/bin/env node
// @ts-check
// Keeps personal information out of this repository, which is public: its files, its history,
// its branch names and its Actions logs. Nothing personal may go in: no user folder path
// (C:\Users\<name>), no private claude.ai link, no e-mail address but a noreply or a public
// one, no word from the private list (real name, user and PC names, private paths, titles of
// what the owner watches and the sites he watches them on), and every commit's author and
// committer a public identity (a GitHub noreply address whose name is its login, or Claude).
//
//   node tools/privacy-check.mjs staged
//       the commit guard (.githooks/pre-commit): the added lines and file names, the
//       identities, and no file .gitignore keeps out forced in.
//   node tools/privacy-check.mjs push <remote>
//       the push guard (.githooks/pre-push; git's ref lines on stdin): every commit the push
//       sends, its message too, and the name each ref gets on the remote.
//   node tools/privacy-check.mjs ci <base> <head> [branch]
//       privacy.yml: every tracked file, the commits base..head and the branch name. Its
//       findings name the place and the rule only: an Actions log is public too.
//   node tools/privacy-check.mjs hooks
//       turns the guards on in this clone (core.hooksPath .githooks); package.json's prepare
//       runs it on every pnpm install, outside CI.
//
// The private words come from the clone's own .git/info/private-words (hooks) or the
// PRIVATE_WORDS secret (CI): one per line, compared case-insensitively, a line starting with #
// a comment. Neither is ever committed. A deliberate exception: git commit/push --no-verify.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A user folder: C:\Users\ and a name, in any case, either slash. */
const USER_FOLDER = /[A-Za-z]:[\\/]+Users[\\/]+([^\s\\/<>%$*"'`.,;:)\]]+)/gi;
/** Folder names that stand for nobody: what tests and docs write for "some user". */
const PLACEHOLDER_FOLDERS = new Set(['x', 'user', 'username', 'name', 'victim', 'example', 'josé', 'public', 'default']);
const CLAUDE_LINK = /claude\.ai\/(?:code|artifacts?|chat|share|project)\//i;
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+([A-Za-z]{2,}))\b/g;
/** Endings that make a package and its version (hls.js@1.7.3.patch) or a file look like an address. */
const FILE_ENDINGS = new Set(['patch', 'mjs', 'cjs', 'js', 'ts', 'json', 'yaml', 'yml', 'md', 'sh', 'txt', 'html', 'css', 'xpi', 'zip', 'lua']);
/** Domains reserved for examples and tests (RFC 2606, RFC 6761). */
const RESERVED_DOMAIN = /(?:^|\.)(?:example|test|invalid|localhost)$|(?:^|\.)example\.(?:com|net|org)$/i;
const NOREPLY = /^(?:noreply@anthropic\.com|noreply@github\.com|support@github\.com|[^@\s]+@users\.noreply\.github\.com)$/i;
/**
 * Public addresses: an add-on's ID, Mozilla's release signing key, and the original FastStream
 * author's published contact (the license, the code of conduct, the welcome page).
 */
const PUBLIC_ADDRESSES = new Set(['ublock0@raymondhill.net', 'release@mozilla.com', 'andrews54757@gmail.com']);

/**
 * @typedef {{line: number, rule: string, text: string}} Finding
 */

/**
 * The private words of a list: trimmed, without blank lines and # comments.
 * @param {string} text
 * @return {string[]}
 */
export function parseWords(text) {
  return text.split(/\r?\n/).map((word) => word.trim()).filter((word) => word && !word.startsWith('#'));
}

/**
 * What in a text would publish something personal, line by line.
 * @param {string} text
 * @param {string[]} words - The private words.
 * @return {Finding[]}
 */
export function findings(text, words) {
  /** @type {Finding[]} */
  const found = [];
  const lowered = words.map((word) => word.toLowerCase());
  text.split('\n').forEach((line, index) => {
    const add = (/** @type {string} */ rule, /** @type {string} */ match) => found.push({line: index + 1, rule, text: match});
    for (const match of line.matchAll(USER_FOLDER)) {
      if (!PLACEHOLDER_FOLDERS.has(match[1].toLowerCase())) add('a user folder path', match[0]);
    }
    const link = CLAUDE_LINK.exec(line);
    if (link) add('a private claude.ai link', link[0]);
    for (const match of line.matchAll(EMAIL)) {
      const address = match[0];
      const before = line.slice(0, match.index);
      // user@host in a URL is its user name, not an address
      if (/\/\/[^\s/]*$/.test(before)) continue;
      if (FILE_ENDINGS.has(match[2].toLowerCase()) || RESERVED_DOMAIN.test(match[1])) continue;
      if (NOREPLY.test(address) || PUBLIC_ADDRESSES.has(address.toLowerCase())) continue;
      add('an e-mail address', address);
    }
    const low = line.toLowerCase();
    for (const word of lowered) {
      if (low.includes(word)) add('a private word', word);
    }
  });
  return found;
}

/**
 * Whether "Name <email>" names no one: a GitHub noreply address whose name is its login
 * (<id>+<login>@users.noreply.github.com, the id a number), or Claude <noreply@anthropic.com>.
 * @param {string} ident
 * @return {boolean}
 */
export function isPublicIdentity(ident) {
  const match = /^(.*?) <([^>]*)>/.exec(ident.trim());
  if (!match) return false;
  const [, name, email] = match;
  if (email === 'noreply@anthropic.com') return name === 'Claude';
  const noreply = /^(\d+)\+([^@]+)@users\.noreply\.github\.com$/.exec(email);
  return !!noreply && noreply[2] === name;
}

/**
 * @param {string[]} args
 * @param {string} [input]
 * @return {string}
 */
function git(args, input) {
  return execFileSync('git', args, {cwd: root, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024});
}

/** @return {string[]} The words of .git/info/private-words, none without the file. */
function cloneWords() {
  const file = path.resolve(root, git(['rev-parse', '--git-path', 'info/private-words']).trim());
  return fs.existsSync(file) ? parseWords(fs.readFileSync(file, 'utf8')) : [];
}

/**
 * The lines a diff adds, each with the file and line it lands on.
 * @param {string} diff - `git diff -U0` output.
 * @return {Array<{file: string, line: number, text: string}>}
 */
export function addedLines(diff) {
  const out = [];
  let file = '';
  let line = 0;
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) {
      file = row.slice(4).replace(/^b\//, '');
    } else if (row.startsWith('@@')) {
      const hunk = /\+(\d+)/.exec(row);
      line = hunk ? Number(hunk[1]) : 0;
    } else if (row.startsWith('+')) {
      out.push({file, line, text: row.slice(1)});
      line++;
    }
  }
  return out;
}

/**
 * Checks added lines and file names; each finding a message.
 * @param {Array<{file: string, line: number, text: string}>} lines
 * @param {string[]} names - File names added or changed.
 * @param {string[]} words
 * @param {boolean} quote - Whether a message may quote what it found.
 * @return {string[]}
 */
export function checkAdded(lines, names, words, quote) {
  const out = [];
  for (const {file, line, text} of lines) {
    for (const found of findings(text, words)) out.push(`${file}:${line}: ${found.rule}${quote ? `: ${found.text}` : ''}`);
  }
  for (const name of names) {
    for (const found of findings(name, words)) out.push(`the file name ${quote ? name : '(not shown)'}: ${found.rule}`);
  }
  return out;
}

/**
 * Checks one commit: its identities, its message, what it adds.
 * @param {string} sha
 * @param {string[]} words
 * @param {boolean} quote
 * @return {string[]}
 */
function checkCommit(sha, words, quote) {
  const short = sha.slice(0, 8);
  const out = [];
  const [author, committer] = git(['log', '-1', '--format=%an <%ae>%n%cn <%ce>', sha]).split('\n');
  if (!isPublicIdentity(author)) out.push(`${short}: the author is not a public identity`);
  if (committer !== 'GitHub <noreply@github.com>' && !isPublicIdentity(committer)) {
    out.push(`${short}: the committer is not a public identity`);
  }
  for (const found of findings(git(['log', '-1', '--format=%B', sha]), words)) {
    out.push(`${short}: its message holds ${found.rule}${quote ? `: ${found.text}` : ''}`);
  }
  // a merge: what it adds to its first parent (the other side's commits are checked themselves)
  const diff = git(['diff-tree', '-p', '-m', '--first-parent', '--root', '--no-commit-id', '--no-color', '--no-ext-diff', '-U0', sha]);
  const names = git(['diff-tree', '-r', '-m', '--first-parent', '--root', '--no-commit-id', '--name-only', '--no-renames', '--diff-filter=AMT', sha])
      .split('\n').filter(Boolean);
  out.push(...checkAdded(addedLines(diff), names, words, quote).map((message) => `${short}: ${message}`));
  return out;
}

/** @return {string[]} */
function staged() {
  const words = cloneWords();
  const out = [];
  for (const who of ['AUTHOR', 'COMMITTER']) {
    const ident = git(['var', `GIT_${who}_IDENT`]).trim();
    if (!isPublicIdentity(ident)) {
      out.push(`the ${who.toLowerCase()} is not a public identity: ${ident.replace(/ \d+ [+-]\d{4}$/, '')}` +
        '\n  Use your GitHub login and its noreply address in this clone: git config user.name <login>;' +
        ' git config user.email <id>+<login>@users.noreply.github.com');
    }
  }
  const names = git(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=AMT']).split('\n').filter(Boolean);
  if (names.length) {
    let ignored = '';
    try {
      ignored = git(['check-ignore', '--no-index', '--stdin'], names.join('\n'));
    } catch (error) {
      // exit 1: none of them is ignored; anything else is a failure
      if (/** @type {{status?: number}} */ (error).status !== 1) throw error;
    }
    for (const name of ignored.split('\n').filter(Boolean)) out.push(`${name}: .gitignore keeps it out of git (private or generated)`);
  }
  const diff = git(['diff', '--cached', '--no-color', '--no-ext-diff', '-U0']);
  out.push(...checkAdded(addedLines(diff), names, words, true));
  return out;
}

/**
 * @param {string} remote
 * @param {string} refs - git's pre-push lines: <local ref> <local sha> <remote ref> <remote sha>.
 * @return {string[]}
 */
function push(remote, refs) {
  const words = cloneWords();
  const zero = /^0+$/;
  const out = [];
  for (const row of refs.split('\n').filter(Boolean)) {
    const [, local, remoteRef, remoteSha] = row.split(' ');
    if (!local || zero.test(local)) continue; // a deletion
    for (const found of findings(remoteRef, words)) out.push(`a pushed branch or tag: its name holds ${found.rule}`);
    let range;
    try {
      git(['cat-file', '-e', `${remoteSha}^{commit}`]);
      range = zero.test(remoteSha) ? null : [local, `^${remoteSha}`];
    } catch {
      range = null;
    }
    const commits = git(['rev-list', ...(range || [local, '--not', `--remotes=${remote}`])]).split('\n').filter(Boolean);
    for (const sha of commits) out.push(...checkCommit(sha, words, true));
  }
  return out;
}

/**
 * @param {string} base
 * @param {string} head
 * @param {string} branch
 * @return {string[]}
 */
function ci(base, head, branch) {
  const fromEnv = process.env.PRIVATE_WORDS;
  if (!fromEnv) {
    console.log('::warning title=No PRIVATE_WORDS::The secret is not set for this run (a fork\'s or Dependabot\'s pull request gets none): the private words are not checked.');
  }
  const words = parseWords(fromEnv || '');
  const out = [];
  for (const name of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
    const file = path.join(root, name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // a submodule or a file the checkout left out
    }
    if (text.includes('\0')) continue; // binary
    for (const found of findings(name, words)) out.push(`a tracked file's name: ${found.rule}`);
    for (const found of findings(text, words)) out.push(`${name}:${found.line}: ${found.rule}`);
  }
  if (branch) {
    for (const found of findings(branch, words)) out.push(`the branch name: ${found.rule}`);
  }
  let commits = [head];
  if (base && !/^0+$/.test(base)) {
    try {
      git(['cat-file', '-e', `${base}^{commit}`]);
      commits = git(['rev-list', `${base}..${head}`]).split('\n').filter(Boolean);
    } catch {
      console.log(`::warning::The base ${base} is not in this checkout: only ${head} is checked.`);
    }
  }
  for (const sha of commits) out.push(...checkCommit(sha, words, false));
  return out;
}

function hooks() {
  if (process.env.CI) return;
  try {
    if (git(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return;
  } catch {
    return; // not a clone: an unpacked archive
  }
  let current = '';
  try {
    current = git(['config', '--get', 'core.hooksPath']).trim();
  } catch {
    // not set
  }
  if (current === '.githooks') return;
  if (current) {
    console.warn(`core.hooksPath is ${current}, not .githooks: the privacy guards are off in this clone.`);
    return;
  }
  git(['config', 'core.hooksPath', '.githooks']);
  console.log('The privacy guards are on in this clone (core.hooksPath .githooks).');
}

/**
 * The modes, by name: how many arguments each takes at most, what it runs, and how a refusal
 * starts.
 * @type {Map<string, {max: number, run: (args: string[]) => string[]|void, refused: string}>}
 */
const MODES = new Map([
  ['staged', {max: 0, run: () => staged(), refused: 'Commit refused'}],
  ['push', {max: 2, run: (/** @type {string[]} */ args) => push(args[0] || 'origin', fs.readFileSync(0, 'utf8')), refused: 'Push refused'}],
  ['ci', {max: 3, run: (/** @type {string[]} */ args) => ci(args[0] || '', args[1] || 'HEAD', args[2] || ''), refused: 'Found'}],
  ['hooks', {max: 0, run: () => hooks(), refused: ''}],
]);

function main() {
  const [name, ...args] = process.argv.slice(2);
  const mode = MODES.get(name || '');
  if (!mode || args.length > mode.max) {
    console.error('usage: node tools/privacy-check.mjs staged | push <remote> | ci <base> <head> [branch] | hooks');
    process.exitCode = 2;
    return;
  }
  let out;
  try {
    out = mode.run(args) || [];
  } catch (error) {
    // a check that could not run is no pass: unchecked is not clean
    console.error(`The privacy check could not run: ${/** @type {Error} */ (error).message}`);
    process.exitCode = 1;
    return;
  }
  if (out.length) {
    const ci = name === 'ci';
    console.error(`${mode.refused}: the repository is public, and this would publish something personal:`);
    for (const message of out) console.error(ci ? `::error::${message}` : `  ${message}`);
    if (!ci) console.error('A deliberate exception: --no-verify.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
