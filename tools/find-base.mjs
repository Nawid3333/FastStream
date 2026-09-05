#!/usr/bin/env node
// Finds which upstream release or commit a vendored file was built from.
//
// Why this exists
// ---------------
// Every wrong provenance answer in this tree came from the same mistake:
// ranking candidate versions by how many *lines* differ. A line-count search
// picked mp4-muxer 5.0.0 when the real base was 4.3.3, and picked
// videojs/vtt.js 0.13.0 for a file that came from dash.js and was never in
// that repository at all. Line counts move with formatting, and every
// vendored file here was reformatted by the project's eslint before landing.
//
// This ranks by the parsed program instead, using tools/ast-compare.mjs. An
// exact hit is reported as EXACT and is proof. A near miss is reported with
// the size of the two normalised ASTs, which is the search key that works:
// it is insensitive to formatting and moves monotonically with real change.
//
// Two things to keep in mind when reading a near miss:
//   - The nearest candidate is not the base. If nothing is EXACT the base may
//     simply not be in the set - that is exactly how the vtt.js answer went
//     wrong - so widen the search before believing the top row.
//   - The vendored file usually has real modifications, so a small non-zero
//     distance is the expected outcome even for the correct base. Read the
//     diff to decide; this tool narrows the field, it does not conclude.
//
// Usage
// -----
//   node tools/find-base.mjs <local-file> <url>...
//   node tools/find-base.mjs <local-file> --repo owner/name --path src/x.js --tags
//   node tools/find-base.mjs <local-file> --repo owner/name --path src/x.js --commits
//
// --tags    ranks the file at every tag in the repository
// --commits ranks it at every commit that touched that path
//
// GitHub's API allows 60 unauthenticated requests an hour. Set GITHUB_TOKEN
// (or run `gh auth token`) to raise that; only the listing call needs it, the
// raw file fetches are not rate limited the same way.

import fs from 'node:fs';

import {fingerprint} from './ast-compare.mjs';

const args = process.argv.slice(2);
const positional = [];
const opts = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' || args[i] === '--path') {
    opts[args[i].slice(2)] = args[++i];
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
 * Calls the GitHub API, using a token when one is available.
 *
 * @param {string} url the API endpoint
 * @return {Promise<any>} the parsed response
 */
async function api(url) {
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

/**
 * Builds the list of candidate raw-file URLs to compare against.
 *
 * @return {Promise<Array<{label: string, url: string}>>} the candidates
 */
async function candidates() {
  if (!opts.mode) {
    return positional.map((url) => ({label: url, url}));
  }
  if (!opts.repo || !opts.path) {
    throw new Error('--tags and --commits both need --repo and --path');
  }
  const raw = (ref) =>
    `https://raw.githubusercontent.com/${opts.repo}/${ref}/${opts.path}`;

  if (opts.mode === 'tags') {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const tags = await api(
          `https://api.github.com/repos/${opts.repo}/tags` +
          `?per_page=100&page=${page}`);
      if (!tags.length) break;
      out.push(...tags.map((t) => ({label: t.name, url: raw(t.name)})));
    }
    return out;
  }

  const out = [];
  for (let page = 1; page <= 10; page++) {
    const commits = await api(
        `https://api.github.com/repos/${opts.repo}/commits` +
        `?path=${encodeURIComponent(opts.path)}&per_page=100&page=${page}`);
    if (!commits.length) break;
    out.push(...commits.map((c) => ({
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
    rows.push({label: c.label, note: `unparseable: ${e.message}`});
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

// Smallest AST-size difference first; a tie breaks on how far the two agree
// before diverging, which separates candidates of coincidentally equal size.
rows.sort((a, b) => {
  if (a.note) return 1;
  if (b.note) return -1;
  return a.delta - b.delta || b.prefix - a.prefix;
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
