#!/usr/bin/env node
// Signs the Firefox AMO build with web-ext and submits it to addons.mozilla.org.
//
// Locally, credentials come from .amo-credentials.json (gitignored), never
// from the command line, so they cannot leak into shell history. The file
// is:
//
//   {
//     "apiKey": "user:...",
//     "apiSecret": "..."
//   }
//
// In CI (no file on the runner), AMO_API_KEY / AMO_API_SECRET env vars are
// used instead: .github/workflows/release.yml and amo-signing-failsafe.yml
// inject them from the repository's secrets.
//
// Usage
// -----
//   node tools/sign-amo.mjs            # unlisted (self-distributed) signing
//   node tools/sign-amo.mjs --listed   # listed (public AMO store) submission
//
// The build must already exist: run `pnpm run build:keep` first.
//
// web-ext uploads the build and then polls AMO until the version is signed. When
// the network fails under it (v1.3.82.37: "fetch failed" while waiting for
// approval, a minute after a clean upload), web-ext gives up, and the release went
// out without its xpi until amo-signing-failsafe.yml collected it hours later.
// Now the wait goes on here instead, with tools/fetch-amo-signed.mjs - the check
// the failsafe makes - within the same 30 minutes; a version AMO never received is
// uploaded once more.

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

// How long to wait for AMO's approval before giving up. Measured over 30
// releases, signing took 2-6 minutes, once 15 (v1.3.82.2, which hit
// web-ext's old 15-minute default and shipped without its xpi). 30 minutes
// is twice the slowest seen. Giving up is not a failure any more: AMO keeps
// reviewing, and .github/workflows/amo-signing-failsafe.yml collects the
// signed xpi afterwards (tools/fetch-amo-signed.mjs), so a longer wait
// would only hold release.yml's runner.
const APPROVAL_TIMEOUT = 30 * 60 * 1000;
// A second upload is worth starting only with time left to be signed in.
const MIN_UPLOAD_TIME = 60 * 1000;

/**
 * Signs through web-ext, and when the network fails under it, asks AMO for the
 * version itself until the deadline.
 * @param {Object} deps
 * @param {function(number): Promise<Object>} deps.sign - web-ext's sign, given the
 *   approval timeout left; resolves with its result.
 * @param {function(): Promise<string>} deps.check - fetchSigned() for this version.
 * @param {number} deps.deadline - When to stop waiting (ms since the epoch).
 * @param {function(): number} [deps.now]
 * @param {Object} [deps.wait] - Passed on to waitForSigned() (interval, sleep).
 * @param {function(string): void} [deps.log]
 * @return {Promise<{signed: boolean, files: string[], state: string}>} files are
 *   web-ext's downloads; after a network failure the xpi is saved by fetchSigned().
 */
export async function signOrCollect({sign, check, deadline, now = Date.now, wait = {}, log = console.log}) {
  for (let upload = 1; ; upload++) {
    try {
      const result = await sign(deadline - now());
      // web-ext 10.x resolves with the downloaded files; `success` is not
      // populated, so treat a downloaded .xpi as the success signal.
      const files = result.downloadedFiles || [];
      return {signed: files.length > 0, files, state: 'signed'};
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }
      log(`\nSigning was interrupted (${error.message}). Asking AMO for the version ` +
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

  if (result.state !== 'signed') {
    console.error(`\nSigning failed: AMO's answer for ${version} is "${result.state}".`);
    process.exit(1);
  }
  console.log(`\nSigned: ${result.signed ? 'yes' : 'no'}`);
  result.files.forEach((f) => console.log(`  ${f}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('\nSigning failed:', err.message || err);
    process.exit(1);
  });
}
