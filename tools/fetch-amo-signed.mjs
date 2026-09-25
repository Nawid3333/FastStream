#!/usr/bin/env node
// Fetches the signed xpi of a version already submitted to addons.mozilla.org, without
// uploading anything.
//
// release.yml signs inline with web-ext, which uploads the build and then polls AMO until
// the version is approved or its wait runs out. AMO has no webhook or callback for
// "signed" (its API documents none), so when the wait runs out the release is published
// without the xpi and updates.json. AMO still finishes the review afterwards: v1.3.79.0 and
// v1.3.82.2 both shipped without an xpi, and both are `public` on AMO. Running web-ext
// sign again cannot collect them - AMO refuses a second upload of the same version - so
// .github/workflows/amo-signing-failsafe.yml asks AMO for that version with this script.
// The file it downloads is byte-identical to what web-ext saves (checked on 1.3.82.27).
//
// Usage: node tools/fetch-amo-signed.mjs <version>
//   Credentials as in tools/sign-amo.mjs: .amo-credentials.json, or AMO_API_KEY and
//   AMO_API_SECRET. The add-on id is read from build_firefox_amo/manifest.json.
//
// Prints `state=<state>` for the workflow and exits with:
//   0  signed   - the xpi is saved in web-ext-artifacts/
//   3  pending  - uploaded, still awaiting review: try again later
//   4  missing  - AMO has no such version: the upload never happened, sign it now
//   5  rejected - AMO disabled or rejected it: waiting will not help
//   1  error    - anything else (network, credentials)

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JwtApiAuth} from 'web-ext/util/submit-addon';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AMO_API = 'https://addons.mozilla.org/api/v5';

export const EXIT = {signed: 0, error: 1, pending: 3, missing: 4, rejected: 5};

/**
 * What a version's API response says about its signing.
 * @param {number} httpStatus - The response status.
 * @param {Object|null} version - The response body, when there is one.
 * @return {'signed'|'pending'|'missing'|'rejected'|'error'}
 */
export function signingState(httpStatus, version) {
  if (httpStatus === 404) return 'missing';
  if (httpStatus !== 200 || !version) return 'error';
  const status = version.file?.status;
  if (status === 'public' && version.file?.url) return 'signed';
  if (status === 'unreviewed') return 'pending';
  if (status === 'disabled') return 'rejected';
  return 'error';
}

function credentials() {
  const file = path.join(root, '.amo-credentials.json');
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  if (process.env.AMO_API_KEY && process.env.AMO_API_SECRET) {
    return {apiKey: process.env.AMO_API_KEY, apiSecret: process.env.AMO_API_SECRET};
  }
  throw new Error('no AMO credentials: .amo-credentials.json or AMO_API_KEY/AMO_API_SECRET');
}

async function main() {
  const version = process.argv[2];
  if (!version) {
    throw new Error('usage: node tools/fetch-amo-signed.mjs <version>');
  }
  const {apiKey, apiSecret} = credentials();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'build_firefox_amo', 'manifest.json'), 'utf8'));
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (!id) {
    throw new Error('no gecko id in build_firefox_amo/manifest.json: run pnpm run build:keep first');
  }
  if (manifest.version !== version) {
    throw new Error(`build_firefox_amo is version ${manifest.version}, not ${version}: build the right tag first`);
  }

  // The same authentication web-ext's `sign` uses for every release (a short-lived HS256
  // token per request), so this cannot drift from the path that already works.
  const jwt = new JwtApiAuth({apiKey, apiSecret});
  const auth = async () => ({Authorization: await jwt.getAuthHeader()});
  // The `v` prefix makes AMO look the version up by number rather than by id.
  const response = await fetch(`${AMO_API}/addons/addon/${encodeURIComponent(id)}/versions/v${version}/`, {headers: await auth()});
  const body = response.status === 200 ? await response.json() : null;
  const state = signingState(response.status, body);
  console.log(`state=${state}`);
  console.log(`AMO: ${id} ${version}: HTTP ${response.status}${body ? `, file.status=${body.file?.status}` : ''}`);

  if (state === 'signed') {
    const download = await fetch(body.file.url, {headers: await auth()});
    if (!download.ok) {
      throw new Error(`downloading ${body.file.url}: HTTP ${download.status}`);
    }
    const name = decodeURIComponent(new URL(body.file.url).pathname.split('/').pop());
    const artifacts = path.join(root, 'web-ext-artifacts');
    fs.mkdirSync(artifacts, {recursive: true});
    fs.writeFileSync(path.join(artifacts, name), Buffer.from(await download.arrayBuffer()));
    console.log(`Saved web-ext-artifacts/${name}`);
  }
  process.exitCode = EXIT[state];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.log('state=error');
    console.error(error.message);
    process.exit(EXIT.error);
  });
}
