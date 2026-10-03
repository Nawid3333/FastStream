#!/usr/bin/env node
// The versions tools/update-local.ps1 brings this PC to, by the rule CI's toolchain follows
// (tools/check-toolchain.mjs): the newest stable release at least MIN_AGE_DAYS old, so a
// broken or hijacked release is usually pulled before it is tried.
//
// Usage: node tools/newest-release.mjs node <major>    the newest Node.js <major>.x
//        node tools/newest-release.mjs npm <package>   the newest release of an npm package,
//                                                       from its latest major down
// Prints the version, or nothing when no release is old enough.

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {MIN_AGE_DAYS, newestOfMajor} from './check-toolchain.mjs';

const DAY = 24 * 60 * 60 * 1000;

// The only hosts this tool talks to; `name` never leaves them (CodeQL js/request-forgery).
const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';
const NPM_REGISTRY = 'https://registry.npmjs.org/';

/**
 * @param {Array<{version: string, date: string}>} index - nodejs.org/dist/index.json, newest first.
 * @param {number} major
 * @param {number} now - Date.now().
 * @param {number} [minAgeDays]
 * @return {string|null} The newest <major>.x old enough, without the "v".
 */
export function newestNode(index, major, now, minAgeDays = MIN_AGE_DAYS) {
  const cutoff = now - minAgeDays * DAY;
  // Only the exact "v1.2.3" shape: update-local.ps1 puts it into a URL and a file name (#243).
  const release = index.find((r) => /^v\d+\.\d+\.\d+$/.test(r.version) &&
      parseInt(r.version.slice(1), 10) === major && Date.parse(r.date) <= cutoff);
  return release ? release.version.slice(1) : null;
}

/**
 * Whether getJson may fetch this URL: nodejs.org's release index itself, or a package
 * document on the npm registry (CodeQL js/request-forgery).
 * @param {URL} url
 * @return {boolean}
 */
export function isPinnedUrl(url) {
  return url.href === NODE_INDEX_URL || (url.origin + url.pathname).startsWith(NPM_REGISTRY);
}

/**
 * The newest stable release old enough, from the major "latest" points at down: a new
 * major whose first release is a day old leaves the one before in use.
 * @param {{'dist-tags': {latest: string}, versions: Object, time: Object<string, string>}} doc
 *     - registry.npmjs.org/<package>.
 * @param {number} now - Date.now().
 * @param {number} [minAgeDays]
 * @return {string|null}
 */
export function newestPackage(doc, now, minAgeDays = MIN_AGE_DAYS) {
  for (let major = parseInt(doc['dist-tags'].latest, 10); major >= 0; major--) {
    const version = newestOfMajor(doc, major, now, minAgeDays);
    if (version) return version;
  }
  return null;
}

async function getJson(url) {
  // Only the two pinned hosts are talked to, however `name` was spelled on the
  // command line (CodeQL js/request-forgery), and the URL object proves the origin.
  // (Until #167 a precedence slip made this check pass every URL.)
  const parsed = new URL(url);
  if (!isPinnedUrl(parsed)) {
    throw new Error(`getJson refuses ${url}: not ${NODE_INDEX_URL} or a package on ${NPM_REGISTRY}`);
  }
  const response = await fetch(parsed, {headers: {'accept': 'application/json', 'user-agent': 'faststream-update-local'}});
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const [what, name] = process.argv.slice(2);
  let version;
  if (what === 'node' && /^\d+$/.test(name || '')) {
    version = newestNode(await getJson(NODE_INDEX_URL), Number(name), Date.now());
  } else if (what === 'npm' && /^[^/]+(\/[^/]+)?$/.test(name || '')) {
    // Exactly one or two path segments, percent-encoded: the scoped name stays on the
    // pinned registry host (CodeQL js/request-forgery).
    version = newestPackage(await getJson(new URL(encodeURIComponent(name), NPM_REGISTRY)), Date.now());
  } else {
    throw new Error('usage: node tools/newest-release.mjs node <major> | npm <package>');
  }
  if (version) console.log(version);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
