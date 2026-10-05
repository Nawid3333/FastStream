#!/usr/bin/env node
// Checks a release's self-update path the way Firefox walks it.
//
// The AMO build's update_url (build.mjs) is .../releases/latest/download/updates.json.
// Firefox fetches it, looks up the installed add-on's id, and installs the xpi at
// update_link if its version is newer - after checking the file against update_hash, and
// only if Mozilla signed it. Each of those links can break without anything else failing:
// a release without updates.json (v1.3.82.37, for ten minutes), an entry for the wrong
// version, a hash of another file, an unsigned xpi, a changed add-on id. Firefox then just
// finds no update, silently. This follows every link and names the first that does not hold.
//
// Usage: node tools/check-update-path.mjs <owner/repo> <tag>
// Exits with:
//   0  every link holds
//   1  a link is broken - printed, one line each
//   2  the check could not be made (the network, or GitHub answering 5xx or 429 three
//      times): nothing is known to be wrong

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The files of a zip archive. An xpi is one; this reads the central directory and inflates
 * entries on demand, which is all an xpi needs (no ZIP64, no encryption).
 * @param {Buffer} buffer - The archive.
 * @return {Map<string, function(): Buffer>} Each file's name, and a function returning its
 *   contents.
 */
export function readZip(buffer) {
  // The end-of-central-directory record: 22 bytes, then a comment of up to 64 KiB.
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    throw new Error('not a zip archive');
  }
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('broken zip central directory');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    files.set(name, () => {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`${name}: compression method ${method}`);
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/**
 * What is wrong with a release's updates.json.
 * @param {Object} json - updates.json as fetched through update_url.
 * @param {Object} release
 * @param {string} release.id - The add-on id Firefox looks up.
 * @param {string} release.version - The release's version.
 * @param {string} release.repo - owner/repo.
 * @param {string} release.tag - The release's tag.
 * @return {{problems: string[], entry: Object|undefined}} No problems when it is right.
 */
export function checkUpdatesJson(json, {id, version, repo, tag}) {
  const updates = json?.addons?.[id]?.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    const ids = Object.keys(json?.addons || {});
    return {problems: [`updates.json has no updates for ${id} (it lists: ${ids.join(', ') || 'nothing'})`]};
  }
  const entry = updates.find((update) => update.version === version);
  if (!entry) {
    return {problems: [`updates.json offers ${updates.map((u) => u.version).join(', ')}, not ${version}`]};
  }
  const problems = [];
  const releaseFiles = `https://github.com/${repo}/releases/download/${tag}/`;
  if (typeof entry.update_link !== 'string' || !entry.update_link.startsWith(releaseFiles)) {
    problems.push(`update_link ${entry.update_link} is not a file of ${tag}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(entry.update_hash || '')) {
    problems.push(`update_hash ${entry.update_hash} is not a sha256 hash`);
  }
  return {problems, entry};
}

/**
 * What is wrong with the xpi an updates.json entry points at.
 * @param {Buffer} xpi - The downloaded file.
 * @param {Object} expected
 * @param {string} expected.id - The add-on id.
 * @param {string} expected.version - The release's version.
 * @param {string} expected.hash - update_hash, `sha256:<hex>`.
 * @param {string} [expected.minVersion] - updates.json's strict_min_version, if it has one.
 * @return {string[]} No problems when it is right.
 */
export function checkXpi(xpi, {id, version, hash, minVersion}) {
  const problems = [];
  const actual = 'sha256:' + crypto.createHash('sha256').update(xpi).digest('hex');
  if (actual !== hash) {
    problems.push(`the xpi's hash is ${actual}, updates.json says ${hash}: Firefox refuses it`);
  }
  let files;
  try {
    files = readZip(xpi);
  } catch (e) {
    return [...problems, `the xpi is not a readable zip: ${e.message}`];
  }
  // AMO signs with both: the PKCS#7 signature and the COSE one newer Firefox checks.
  for (const signature of ['META-INF/mozilla.rsa', 'META-INF/cose.sig']) {
    if (!files.has(signature)) {
      problems.push(`the xpi has no ${signature}: it is not signed by Mozilla, and Firefox will not install it`);
    }
  }
  let manifest;
  try {
    manifest = JSON.parse(files.get('manifest.json')().toString('utf8'));
  } catch (e) {
    return [...problems, `the xpi has no readable manifest.json: ${e.message}`];
  }
  const gecko = manifest.browser_specific_settings?.gecko || {};
  if (manifest.version !== version) {
    problems.push(`the xpi is version ${manifest.version}, not ${version}`);
  }
  if (gecko.id !== id) {
    problems.push(`the xpi's add-on id is ${gecko.id}, not ${id}: it would not update the installed add-on`);
  }
  if (minVersion && gecko.strict_min_version && gecko.strict_min_version !== minVersion) {
    problems.push(`updates.json says Firefox ${minVersion} or newer, the xpi ${gecko.strict_min_version}`);
  }
  return problems;
}

/**
 * The add-on id the AMO build gives itself (build.mjs, browser_specific_settings.gecko.id).
 * @param {string} source - build.mjs.
 * @return {string} The id.
 */
export function geckoIdFromBuild(source) {
  const ids = [...source.matchAll(/gecko:\s*\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
  if (ids.length === 0 || new Set(ids).size !== 1) {
    throw new Error(`build.mjs should name one gecko id, found: ${ids.join(', ') || 'none'}`);
  }
  return ids[0];
}

/** A network failure, as opposed to an answer. */
export class Unreachable extends Error {}

/**
 * Whether an HTTP status is GitHub having trouble rather than an answer about the file: a
 * server error (a 502 from the download redirect's CDN) or a rate limit. Asked again, then
 * counted as the network, as a broken link it is not.
 * @param {number} status
 * @return {boolean}
 */
export function isPassingTrouble(status) {
  return status === 429 || status >= 500;
}

/**
 * Downloads a link of the update path. A network failure, a server error or a rate limit is
 * tried again, three times in all, then thrown as Unreachable; any other answer is returned.
 * Until 2026-10-04 a 5xx came back as an answer, and a CDN hiccup opened "Update path
 * broken" for a path that held.
 * @param {string} url
 * @param {Object} [options]
 * @param {function(string, Object): Promise<Response>} [options.get] - fetch.
 * @param {function(number): Promise<void>} [options.sleep]
 * @return {Promise<{status: number, body?: Buffer}>} status 200 with the body, or the
 *   status of an answer that says the file is not there (a 404, say).
 */
export async function download(url, {
  get = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 1; ; attempt++) {
    let trouble;
    try {
      const response = await get(url, {redirect: 'follow'});
      if (response.ok) {
        return {status: 200, body: Buffer.from(await response.arrayBuffer())};
      }
      if (!isPassingTrouble(response.status)) {
        return {status: response.status};
      }
      trouble = `HTTP ${response.status}`;
    } catch (e) {
      trouble = e.message;
    }
    if (attempt === 3) {
      throw new Unreachable(`${url}: ${trouble}`);
    }
    await sleep(10 * 1000);
  }
}

async function main() {
  const [repo, tag] = process.argv.slice(2);
  if (!repo || !tag) {
    throw new Error('usage: node tools/check-update-path.mjs <owner/repo> <tag>');
  }
  // Strict shapes for both CLI values, and the download host pinned to
  // github.com, so the URL cannot leave it (CodeQL js/request-forgery).
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`${repo}: not an owner/repo pair`);
  if (!/^[\w.-]+$/.test(tag)) throw new Error(`${tag}: not a tag`);
  const id = geckoIdFromBuild(fs.readFileSync(path.join(root, 'build.mjs'), 'utf8'));
  const version = tag.replace(/^v/i, ''); // V1.2.3.4 as well (the header allows both)
  const updateUrl = `https://github.com/${repo}/releases/latest/download/updates.json`;

  const problems = [];
  const updates = await download(updateUrl);
  if (updates.status !== 200) {
    problems.push(`${updateUrl}: HTTP ${updates.status} - the latest release has no updates.json`);
  } else {
    let json;
    try {
      json = JSON.parse(updates.body.toString('utf8'));
    } catch (e) {
      problems.push(`updates.json is not JSON: ${e.message}`);
    }
    if (json) {
      const checked = checkUpdatesJson(json, {id, version, repo, tag});
      problems.push(...checked.problems);
      if (checked.entry && checked.problems.length === 0) {
        const xpi = await download(checked.entry.update_link);
        if (xpi.status !== 200) {
          problems.push(`${checked.entry.update_link}: HTTP ${xpi.status}`);
        } else {
          problems.push(...checkXpi(xpi.body, {
            id, version, hash: checked.entry.update_hash,
            minVersion: checked.entry.applications?.gecko?.strict_min_version,
          }));
        }
      }
    }
  }

  if (problems.length > 0) {
    console.log(`The update path of ${tag} is broken:`);
    problems.forEach((problem) => console.log(`  - ${problem}`));
    process.exitCode = 1;
  } else {
    console.log(`The update path of ${tag} holds: ${updateUrl} -> ${id} ${version}, hash and Mozilla signature OK.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(error instanceof Unreachable ? 2 : 1);
  });
}
