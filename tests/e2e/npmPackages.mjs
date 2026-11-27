// npm releases the e2e pages load: the player libraries sites are built with
// (live-specs/player-libraries.json, which toolchain-updates.yml moves) and the hls.js and dash.js
// this repository pins. Downloaded from the registry, checked against its integrity, kept in memory.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '../..');

/**
 * The player libraries' releases, by package name: live-specs/player-libraries.json.
 * @type {Object<string, string>}
 */
export const PLAYER_LIBRARIES = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'live-specs/player-libraries.json'), 'utf8'));

// The registry host is pinned, and a package name and version must have exactly npm's
// shape before either reaches a URL (CodeQL js/request-forgery).
const REGISTRY = 'https://registry.npmjs.org';
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/**
 * Splits a tar archive into its files: a run of 512-byte headers, each followed by its
 * file padded to 512.
 * @param {Buffer} tar - The archive.
 * @return {Map<string, Buffer>} Path inside the package (without "package/") -> contents.
 */
function untar(tar) {
  const files = new Map();
  const field = (start, length) => tar.toString('utf8', start, start + length).replace(/\0[\s\S]*$/, '');
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = field(offset, 100);
    if (!name) {
      break;
    }
    const size = parseInt(field(offset + 124, 12).trim() || '0', 8);
    const prefix = field(offset + 345, 155);
    const full = (prefix ? prefix + '/' : '') + name;
    // Packed by npm, everything is under package/ (a few old tarballs use another top
    // folder: the first segment is dropped either way).
    files.set(full.replace(/^[^/]+\//, ''), tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const packages = new Map();

/**
 * Every file of one npm package version, its tarball downloaded once per run, checked against the
 * registry's integrity.
 * Kept in memory only (CodeQL js/http-to-file-access).
 * @param {string} pkg - The package name, scoped or not.
 * @param {string} version - An exact version.
 * @return {Promise<Map<string, Buffer>>} Path inside the package -> contents.
 */
export async function npmPackage(pkg, version) {
  if (!PACKAGE_NAME.test(pkg) || !SEMVER.test(version)) {
    throw new Error(`not an npm package name and version: ${pkg}@${version}`);
  }
  const key = `${pkg}@${version}`;
  if (packages.has(key)) {
    return packages.get(key);
  }
  const metaRes = await fetch(`${REGISTRY}/${pkg}/${version}`);
  if (!metaRes.ok) {
    throw new Error(`could not look up ${key}: HTTP ${metaRes.status}`);
  }
  const {dist} = await metaRes.json();
  const tarball = new URL(dist.tarball);
  if (tarball.origin !== REGISTRY) {
    throw new Error(`${key}: the registry named a tarball on another host: ${tarball.origin}`);
  }
  const res = await fetch(tarball);
  if (!res.ok) {
    throw new Error(`could not download ${key}: HTTP ${res.status}`);
  }
  const tgz = Buffer.from(await res.arrayBuffer());
  const [algorithm, expected] = String(dist.integrity).split('-');
  if (algorithm !== 'sha512' || crypto.createHash('sha512').update(tgz).digest('base64') !== expected) {
    throw new Error(`${key}: the tarball does not match the registry's integrity ${dist.integrity}`);
  }
  const files = untar(zlib.gunzipSync(tgz));
  packages.set(key, files);
  return files;
}

/**
 * The version of a package this repo's package.json pins: the hls.js and dash.js a test
 * site uses are the releases FastStream's own copies come from.
 * @param {string} pkg - The package name.
 * @return {string}
 */
export function pinnedVersion(pkg) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return String(pkgJson.devDependencies[pkg]).replace(/^[\^~]/, '');
}

/**
 * Returns one file of an npm package at the version package.json pins.
 * @param {string} pkg - The package name.
 * @param {string} file - The file's path inside the package.
 * @return {Promise<Buffer>} The file.
 */
export async function npmFile(pkg, file) {
  const version = pinnedVersion(pkg);
  const data = (await npmPackage(pkg, version)).get(file);
  if (!data) {
    throw new Error(`${pkg}@${version} has no ${file}`);
  }
  return data;
}

/**
 * A file of one of PLAYER_LIBRARIES (or the pinned hls.js), by its path under a page's /npm/.
 * @param {string} rest - "<package>/<file>", the package possibly scoped.
 * @return {Promise<?Buffer>} The file, or null for none.
 */
export async function playerLibraryFile(rest) {
  const parts = rest.split('/');
  const pkg = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const file = parts.slice(pkg.split('/').length).join('/');
  // Own keys only: a path such as /npm/constructor/x would find Object.prototype's.
  const version = Object.hasOwn(PLAYER_LIBRARIES, pkg) ? PLAYER_LIBRARIES[pkg] : (pkg === 'hls.js' ? pinnedVersion('hls.js') : null);
  if (!version) {
    return null;
  }
  return (await npmPackage(pkg, version)).get(file) || null;
}

/** Content types of the files a page loads from /npm/, by extension. */
export const NPM_FILE_TYPES = {js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
  svg: 'image/svg+xml'};
