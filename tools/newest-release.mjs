// @ts-check
// The versions tools/update-local.ps1 brings this PC to: the newest stable release, once old enough.
// Usage: node tools/newest-release.mjs node <major>    the newest Node.js <major>.x
//        node tools/newest-release.mjs npm <package>   the newest release of an npm package,
//                                                       from its latest major down
//        node tools/newest-release.mjs wsl             WSL's latest release (microsoft/WSL)
// Prints the version, or nothing when there is no stable release.

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {MIN_AGE_DAYS, newestOfMajor} from './check-toolchain.mjs';

const DAY = 24 * 60 * 60 * 1000;

// The only hosts this tool talks to; `name` never leaves them (CodeQL js/request-forgery).
const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const WSL_RELEASE_URL = 'https://api.github.com/repos/microsoft/WSL/releases/latest';

/**
 * @param {Array<{version: string, date: string}>} index
 * @param {number} major
 * @param {number} now - Date.now().
 * @param {number} [minAgeDays]
 * @return {string|null} Without the "v".
 */
export function newestNode(index, major, now, minAgeDays = MIN_AGE_DAYS) {
  const cutoff = now - minAgeDays * DAY;
  // Only the exact "v1.2.3" shape: update-local.ps1 puts it into a URL and a file name.
  const release = index.find((r) => /^v\d+\.\d+\.\d+$/.test(r.version) &&
      parseInt(r.version.slice(1), 10) === major && Date.parse(r.date) <= cutoff);
  return release ? release.version.slice(1) : null;
}

/**
 * nodejs.org's release index, WSL's latest release, or an npm package document (CodeQL js/request-forgery).
 * @param {URL} url
 * @return {boolean}
 */
export function isPinnedUrl(url) {
  return url.href === NODE_INDEX_URL || url.href === WSL_RELEASE_URL ||
    (url.origin + url.pathname).startsWith(NPM_REGISTRY);
}

/**
 * GitHub's latest is never a pre-release or a draft; one marked so is skipped all the same.
 * @param {{tag_name?: string, published_at?: string, prerelease?: boolean, draft?: boolean}} release
 * @param {number} now
 * @param {number} [minAgeDays]
 * @return {string|null} Null while too new. Throws for a tag that is not a plain version number.
 */
export function newestWsl(release, now, minAgeDays = MIN_AGE_DAYS) {
  const version = release && release.tag_name;
  if (typeof version !== 'string' || !/^\d+(\.\d+){1,3}$/.test(version)) {
    throw new Error(`microsoft/WSL's latest release is tagged '${version}', not a version number`);
  }
  if (release.prerelease || release.draft) return null;
  const published = Date.parse(release.published_at || '');
  return published <= now - minAgeDays * DAY ? version : null;
}

/**
 * From the major latest points at down: a day-old new major leaves the one before in use.
 * @param {{'dist-tags': {latest: string}, versions: Record<string, {deprecated?: string}>, time: Object<string, string>}} doc
 * @param {number} now
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

/** @param {string|URL} url */
async function getJson(url) {
  // Only the pinned hosts, however name was spelled (CodeQL js/request-forgery).
  const parsed = new URL(url);
  if (!isPinnedUrl(parsed)) {
    throw new Error(`getJson refuses ${url}: not ${NODE_INDEX_URL}, ${WSL_RELEASE_URL} or a package on ${NPM_REGISTRY}`);
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
    // One or two path segments, percent-encoded: a scoped name stays on the registry host.
    version = newestPackage(await getJson(new URL(encodeURIComponent(name), NPM_REGISTRY)), Date.now());
  } else if (what === 'wsl') {
    version = newestWsl(await getJson(WSL_RELEASE_URL), Date.now());
  } else {
    throw new Error('usage: node tools/newest-release.mjs node <major> | npm <package> | wsl');
  }
  if (version) console.log(version);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
