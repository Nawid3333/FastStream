#!/usr/bin/env node
// Signs the Firefox AMO build with web-ext and submits it to addons.mozilla.org.
//
// Credentials come from .amo-credentials.json (gitignored), never from the
// command line or the environment, so they cannot leak into shell history or
// CI logs. The file is:
//
//   {
//     "apiKey": "user:...",
//     "apiSecret": "..."
//   }
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

if (!fs.existsSync(credPath)) {
  console.error(
      'Missing .amo-credentials.json. Create it with your AMO API key and ' +
      'secret (see the header comment in tools/sign-amo.mjs).');
  process.exit(2);
}

if (!fs.existsSync(path.join(sourceDir, 'manifest.json'))) {
  console.error(
      `No build at ${sourceDir}. Run: pnpm run build:keep`);
  process.exit(2);
}

const {apiKey, apiSecret} = JSON.parse(fs.readFileSync(credPath, 'utf8'));
if (!apiKey || !apiSecret) {
  console.error('.amo-credentials.json needs both "apiKey" and "apiSecret".');
  process.exit(2);
}

console.log(`Signing ${sourceDir} as ${channel}...`);

webExt.cmd.sign({
  sourceDir,
  artifactsDir,
  channel,
  apiKey,
  apiSecret,
}).then((result) => {
  console.log(`\nSigned: ${result.success ? 'yes' : 'no'}`);
  if (result.downloadedFiles) {
    result.downloadedFiles.forEach((f) => console.log(`  ${f}`));
  }
}).catch((err) => {
  console.error('\nSigning failed:', err.message || err);
  process.exit(1);
});
