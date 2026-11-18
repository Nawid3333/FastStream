// @ts-check
// Signs the Firefox AMO build with web-ext and submits it to addons.mozilla.org.
// Credentials: .amo-credentials.json {"apiKey": "user:...", "apiSecret": "..."} (gitignored, never argv),
// or AMO_API_KEY / AMO_API_SECRET in CI (the "release" environment's secrets).
// Usage (after `pnpm run build:keep`):
//   node tools/sign-amo.mjs            # unlisted (self-distributed) signing
//   node tools/sign-amo.mjs --listed   # listed (public AMO store) submission
// When the network fails under web-ext's approval wait, the wait goes on here (fetch-amo-signed.mjs);
// a version AMO never received is uploaded once more.

import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';
import webExt from 'web-ext';

import {fetchSigned, isNetworkError, waitForSigned} from './fetch-amo-signed.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');
const credPath = path.join(root, '.amo-credentials.json');
const sourceDir = path.join(root, 'build_firefox_amo');
const artifactsDir = path.join(root, 'web-ext-artifacts');

// Twice the slowest signing seen; amo-signing-failsafe.yml collects a later xpi, so a longer wait only holds the runner.
const APPROVAL_TIMEOUT = 30 * 60 * 1000;
// A second upload is worth starting only with time left to be signed in.
const MIN_UPLOAD_TIME = 60 * 1000;

/**
 * Signs through web-ext; when the network fails under it, asks AMO for the version itself until the deadline.
 * @param {object} deps
 * @param {(ms: number) => Promise<{downloadedFiles?: string[]}>} deps.sign - web-ext's sign, given the approval timeout left.
 * @param {() => Promise<string>} deps.check
 * @param {number} deps.deadline - ms since the epoch.
 * @param {() => number} [deps.now]
 * @param {Object} [deps.wait] - Passed on to waitForSigned().
 * @param {(msg: string) => void} [deps.log]
 * @return {Promise<{signed: boolean, files: string[], state: string}>} files are web-ext's downloads; after a network failure fetchSigned() saves the xpi.
 */
export async function signOrCollect({sign, check, deadline, now = Date.now, wait = {}, log = console.log}) {
  for (let upload = 1; ; upload++) {
    try {
      const result = await sign(deadline - now());
      // web-ext 10.x leaves `success` unset: a downloaded .xpi is the success signal, and none is not signed.
      const files = result.downloadedFiles || [];
      if (files.length === 0) {
        return {signed: false, files, state: 'not downloaded'};
      }
      return {signed: true, files, state: 'signed'};
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }
      log(`\nSigning was interrupted (${/** @type {Error} */ (error).message}). Asking AMO for the version ` +
        `itself until ${new Date(deadline).toISOString()}...`);
      const state = await waitForSigned(check, {deadline, now, log, ...wait});
      if (state === 'missing' && upload === 1 && deadline - now() >= MIN_UPLOAD_TIME) {
        log('AMO has no such version: the upload never arrived. Uploading it again.');
        continue;
      }
      return {signed: state === 'signed', files: [], state};
    }
  }
}

async function main() {
  const listed = process.argv.includes('--listed');
  const channel = listed ? 'listed' : 'unlisted';

  let apiKey;
  let apiSecret;
  if (fs.existsSync(credPath)) {
    ({apiKey, apiSecret} = JSON.parse(fs.readFileSync(credPath, 'utf8')));
  } else if (process.env.AMO_API_KEY && process.env.AMO_API_SECRET) {
    apiKey = process.env.AMO_API_KEY;
    apiSecret = process.env.AMO_API_SECRET;
  } else {
    console.error(
        'Missing .amo-credentials.json, and AMO_API_KEY/AMO_API_SECRET are ' +
        'not set. Create the file locally, or set both env vars in CI (see ' +
        'the header comment in tools/sign-amo.mjs).');
    process.exit(2);
  }

  if (!apiKey || !apiSecret) {
    console.error('AMO credentials need both an API key and a secret.');
    process.exit(2);
  }

  const manifestPath = path.join(sourceDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(
        `No build at ${sourceDir}. Run: pnpm run build:keep`);
    process.exit(2);
  }
  const {version} = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  console.log(`Signing ${sourceDir} as ${channel}...`);

  const result = await signOrCollect({
    sign: (approvalTimeout) => webExt.cmd.sign({
      sourceDir,
      artifactsDir,
      channel,
      apiKey,
      apiSecret,
      amoBaseUrl: 'https://addons.mozilla.org/api/v5/',
      approvalTimeout,
    }),
    check: () => fetchSigned(version),
    deadline: Date.now() + APPROVAL_TIMEOUT,
  });

  // Not signed fails the step (continue-on-error); amo-signing-failsafe.yml completes the release.
  if (!result.signed) {
    console.error(result.state === 'not downloaded' ?
        `\nSigning failed: web-ext finished without downloading a signed xpi of ${version}.` :
        `\nSigning failed: AMO's answer for ${version} is "${result.state}".`);
    process.exit(1);
  }
  console.log('\nSigned: yes');
  result.files.forEach((f) => console.log(`  ${f}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('\nSigning failed:', err.message || err);
    process.exit(1);
  });
}
