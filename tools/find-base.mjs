// @ts-check
// Finds which upstream release or commit a vendored file was built from.
// Ranks candidates by the parsed program (ast-compare.mjs), not by lines: line counts move with formatting.
// EXACT is proof; a near miss shows the two normalised ASTs' sizes, which move only with real change.
// The nearest candidate is not the base, and a small distance is expected: this narrows, it does not conclude.
//   node tools/find-base.mjs <local-file> <url>...
//   node tools/find-base.mjs <local-file> --repo owner/name --path src/x.js --tags
//   node tools/find-base.mjs <local-file> --repo owner/name --path src/x.js --commits
// --tags    ranks the file at every tag in the repository
// --commits ranks it at every commit that touched that path
// GitHub allows 60 unauthenticated requests an hour: set GITHUB_TOKEN for the listing call.

import fs from 'node:fs';

import {fingerprint} from './ast-compare.mjs';

const args = process.argv.slice(2);
/** @type {string[]} */
const positional = [];
/** @type {Object<string, string>} */
const opts = {};
// Two fixed option names: an argv value never becomes an object key (CodeQL js/remote-property-injection).
const optionNames = new Set(['repo', 'path']);
for (let i = 0; i < args.length; i++) {
  const opt = /^--([a-z]+)$/.exec(args[i] || '');
  if (opt && optionNames.has(opt[1])) {
    opts[opt[1]] = args[++i];
  } else if (args[i] === '--tags' || args[i] === '--commits') {
    opts.mode = args[i].slice(2);
  } else {
    positional.push(args[i]);
  }
}

const localPath = positional.shift();
if (!localPath) {
  console.error('usage: node tools/find-base.mjs <local-file> [<url>... | ' +
    '--repo owner/name --path file --tags|--commits]');
  process.exit(2);
}

/**
 * @param {string} url
 * @return {Promise<any>}
 */
async function api(url) {
  /** @type {Object<string, string>} */
  const headers = {'accept': 'application/vnd.github+json'};
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, {headers});
  if (!res.ok) {
    throw new Error(`${url}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** @return {Promise<Array<{label: string, url: string}>>} */
async function candidates() {
  if (!opts.mode) {
    return positional.map((url) => ({label: url, url}));
  }
  if (!opts.repo || !opts.path) {
    throw new Error('--tags and --commits both need --repo and --path');
  }
  // Strict shapes for the CLI values, and the hosts pinned (CodeQL js/request-forgery).
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`${opts.repo}: not an owner/repo pair`);
  if (!/^[\w./-]+\.[a-z]+$/.test(opts.path)) throw new Error(`${opts.path}: not a file path`);
  /** @param {string} ref */
  const raw = (ref) =>
    `https://raw.githubusercontent.com/${opts.repo}/${ref}/${opts.path}`;

  if (opts.mode === 'tags') {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const tags = await api(
          `https://api.github.com/repos/${opts.repo}/tags` +
          `?per_page=100&page=${page}`);
      if (!tags.length) break;
      out.push(...tags.map((/** @type {{name: string}} */ t) => ({label: t.name, url: raw(t.name)})));
    }
    return out;
  }

  const out = [];
  for (let page = 1; page <= 10; page++) {
    const commits = await api(
        `https://api.github.com/repos/${opts.repo}/commits` +
        `?path=${encodeURIComponent(opts.path)}&per_page=100&page=${page}`);
    if (!commits.length) break;
    out.push(...commits.map((/** @type {{sha: string, commit: {author: {date: string}}}} */ c) => ({
      label: `${c.sha.slice(0, 8)} ${c.commit.author.date.slice(0, 10)}`,
      url: raw(c.sha),
    })));
  }
  return out;
}

const target = fingerprint(fs.readFileSync(localPath, 'utf8'));
console.log(`${localPath}: normalised AST is ${target.length} chars\n`);

const list = await candidates();
if (!list.length) {
  console.error('no candidates - pass URLs, or --repo/--path with a mode');
  process.exit(2);
}

const rows = [];
for (const c of list) {
  const res = await fetch(c.url);
  if (!res.ok) {
    // A tag predating the file, or a commit that deleted it. Not an error.
    rows.push({label: c.label, note: `unavailable (${res.status})`});
    continue;
  }
  const src = await res.text();
  let fp;
  try {
    fp = fingerprint(src);
  } catch (e) {
    rows.push({label: c.label, note: `unparseable: ${/** @type {Error} */ (e).message}`});
    continue;
  }
  let i = 0;
  while (i < fp.length && i < target.length && fp[i] === target[i]) i++;
  rows.push({
    label: c.label,
    size: fp.length,
    delta: Math.abs(fp.length - target.length),
    prefix: i,
    exact: fp === target,
  });
}

// Smallest AST-size difference first; a tie breaks on how far the two agree before diverging.
rows.sort((a, b) => {
  if (a.note) return 1;
  if (b.note) return -1;
  return /** @type {number} */ (a.delta) - /** @type {number} */ (b.delta) || /** @type {number} */ (b.prefix) - /** @type {number} */ (a.prefix);
});

for (const r of rows.slice(0, 25)) {
  if (r.note) {
    console.log(`  ${r.label.padEnd(28)} ${r.note}`);
  } else {
    console.log(
        `  ${r.label.padEnd(28)} ast ${String(r.size).padStart(8)}  ` +
        `delta ${String(r.delta).padStart(8)}  ` +
        `agrees to ${String(r.prefix).padStart(8)}` +
        (r.exact ? '   <-- EXACT' : ''));
  }
}

if (rows.some((r) => r.exact)) {
  console.log('\nEXACT means the two parse to the same program. That is ' +
    'proof, not a ranking.');
} else {
  console.log('\nNo exact match. The top row is the nearest candidate ' +
    'searched, which\nis not the same as the base - widen the search before ' +
    'trusting it.');
}
