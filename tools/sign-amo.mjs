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
// used instead - see .github/workflows/publish-amo.yml, which injects them
// from repo secrets.
//
// Usage
// -----
//   node tools/sign-amo.mjs            # unlisted (self-distributed) signing
//   node tools/sign-amo.mjs --listed   # listed (public AMO store) submission
//
// The build must already exist: run `pnpm run build:keep` first.

import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';
import webExt from 'web-ext';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');
const credPath = path.join(root, '.amo-credentials.json');
const sourceDir = path.join(root, 'build_firefox_amo');
const artifactsDir = path.join(root, 'web-ext-artifacts');

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

if (!fs.existsSync(path.join(sourceDir, 'manifest.json'))) {
  console.error(
      `No build at ${sourceDir}. Run: pnpm run build:keep`);
  process.exit(2);
}

console.log(`Signing ${sourceDir} as ${channel}...`);

webExt.cmd.sign({
  sourceDir,
  artifactsDir,
  channel,
  apiKey,
  apiSecret,
  amoBaseUrl: 'https://addons.mozilla.org/api/v5/',
}).then((result) => {
  // web-ext 10.x resolves with the downloaded files; `success` is not
  // populated, so treat a downloaded .xpi as the success signal.
  const files = result.downloadedFiles || [];
  console.log(`\nSigned: ${files.length ? 'yes' : 'no'}`);
  files.forEach((f) => console.log(`  ${f}`));
}).catch((err) => {
  console.error('\nSigning failed:', err.message || err);
  process.exit(1);
});
