// @ts-check
// Checks a release's self-update path the way Firefox walks it.
// Follows update_url, the entry, update_hash, the signatures and the id as Firefox does: it fails silently.
// Usage: node tools/check-update-path.mjs <owner/repo> <tag>
// Exits with:
//   0  every link holds
//   1  a link is broken - printed, one line each
//   2  the check could not be made (the network, or 5xx/429 three times): nothing known wrong

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The files of a zip (an xpi): the central directory, entries inflated on demand; no ZIP64, no encryption.
 * @param {Buffer} buffer
 * @return {Map<string, () => Buffer>} Each file's name, and a function returning its contents.
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
 * @typedef {{version: string, update_link: string, update_hash: string, applications?: {gecko?: {strict_min_version?: string}}}} UpdateEntry
 * @typedef {{addons?: Object<string, {updates: UpdateEntry[]}>}} UpdatesJson
 * @param {UpdatesJson} json
 * @param {Object} release
 * @param {string} release.id
 * @param {string} release.version
 * @param {string} release.repo
 * @param {string} release.tag
 * @return {{problems: string[], entry?: UpdateEntry|undefined}}
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
 * @param {Buffer} xpi
 * @param {Object} expected
 * @param {string} expected.id
 * @param {string} expected.version
 * @param {string} expected.hash
 * @param {string} [expected.minVersion]
 * @return {string[]}
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
    return [...problems, `the xpi is not a readable zip: ${/** @type {Error} */ (e).message}`];
  }
  // AMO signs with both: the PKCS#7 signature and the COSE one newer Firefox checks.
  for (const signature of ['META-INF/mozilla.rsa', 'META-INF/cose.sig']) {
    if (!files.has(signature)) {
      problems.push(`the xpi has no ${signature}: it is not signed by Mozilla, and Firefox will not install it`);
    }
  }
  let manifest;
  try {
    manifest = JSON.parse(/** @type {() => Buffer} */ (files.get('manifest.json'))().toString('utf8'));
  } catch (e) {
    return [...problems, `the xpi has no readable manifest.json: ${/** @type {Error} */ (e).message}`];
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
 * @param {string} source
 * @return {string}
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
 * GitHub's trouble (a 5xx, a rate limit), not an answer about the file: asked again, then counted as the network.
 * @param {number} status
 * @return {boolean}
 */
export function isPassingTrouble(status) {
  return status === 429 || status >= 500;
}

/**
 * Network failures, server errors and rate limits are tried three times in all, then thrown as Unreachable.
 * @param {string} url
 * @param {Object} [options]
 * @param {(url: string, options: Object) => Promise<Response>} [options.get]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @return {Promise<{status: number, body?: Buffer}>} Status 200 with the body, or the status of an answer that the file is not there.
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
      trouble = /** @type {Error} */ (e).message;
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
  // Strict shapes for both CLI values, and the host pinned to github.com (CodeQL js/request-forgery).
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`${repo}: not an owner/repo pair`);
  if (!/^[\w.-]+$/.test(tag)) throw new Error(`${tag}: not a tag`);
  const id = geckoIdFromBuild(fs.readFileSync(path.join(root, 'build.mjs'), 'utf8'));
  const version = tag.replace(/^v/i, ''); // V1.2.3.4 as well (the header allows both)
  const updateUrl = `https://github.com/${repo}/releases/latest/download/updates.json`;

  const problems = [];
  const updates = /** @type {{status: number, body: Buffer}} */ (await download(updateUrl));
  if (updates.status !== 200) {
    problems.push(`${updateUrl}: HTTP ${updates.status} - the latest release has no updates.json`);
  } else {
    let json;
    try {
      json = JSON.parse(updates.body.toString('utf8'));
    } catch (e) {
      problems.push(`updates.json is not JSON: ${/** @type {Error} */ (e).message}`);
    }
    if (json) {
      const checked = checkUpdatesJson(json, {id, version, repo, tag});
      problems.push(...checked.problems);
      if (checked.entry && checked.problems.length === 0) {
        const xpi = /** @type {{status: number, body: Buffer}} */ (await download(checked.entry.update_link));
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
