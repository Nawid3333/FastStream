#!/usr/bin/env node
// Generates the self-hosted update manifest (updates.json) that
// browser_specific_settings.gecko.update_url in the AMO build points at
// (see build.mjs's buildFirefoxAmo). Firefox polls that URL -- both on its
// own schedule and when the user clicks "Check for Updates" in
// about:addons -- to learn whether a newer signed xpi exists. Format:
// https://extensionworkshop.com/documentation/manage/updating-your-extension/
//
// Run after signing, from the repo root:
//   node tools/gen-update-manifest.mjs <owner/repo> <tag>
// e.g. node tools/gen-update-manifest.mjs Nawid3333/FastStream v1.3.80.0
//
// Reads the extension id and version from the just-built
// build_firefox_amo/manifest.json (build:keep leaves it on disk) and finds
// the signed xpi in web-ext-artifacts/, so this can never drift out of sync
// with what was actually signed. Writes web-ext-artifacts/updates.json.
//
// Only the just-signed version is listed, not a history of older ones --
// good enough as long as every release stays compatible with the previous
// strict_min_version. If a future release raises strict_min_version high
// enough to strand users on old Firefox versions, they'd need a second
// entry here to fall back to; not needed today.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');

const [repo, tag] = process.argv.slice(2);
if (!repo || !tag) {
  console.error('Usage: node tools/gen-update-manifest.mjs <owner/repo> <tag>');
  process.exit(1);
}

const manifestPath = path.join(root, 'build_firefox_amo', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const gecko = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
const id = gecko && gecko.id;
if (!id) {
  console.error(`No browser_specific_settings.gecko.id found in ${manifestPath}`);
  process.exit(1);
}

const artifactsDir = path.join(root, 'web-ext-artifacts');
const xpiFiles = fs.readdirSync(artifactsDir).filter((f) => f.endsWith('.xpi'));
if (xpiFiles.length !== 1) {
  console.error(`Expected exactly one .xpi in ${artifactsDir}, found: ${xpiFiles.join(', ') || '(none)'}`);
  process.exit(1);
}
const xpiName = xpiFiles[0];
const xpiBuffer = fs.readFileSync(path.join(artifactsDir, xpiName));
const hash = crypto.createHash('sha256').update(xpiBuffer).digest('hex');

const updateEntry = {
  version: manifest.version,
  update_link: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(xpiName)}`,
  update_hash: `sha256:${hash}`,
};
if (gecko.strict_min_version) {
  updateEntry.applications = {gecko: {strict_min_version: gecko.strict_min_version}};
}

const updateManifest = {
  addons: {
    [id]: {
      updates: [updateEntry],
    },
  },
};

const outPath = path.join(artifactsDir, 'updates.json');
fs.writeFileSync(outPath, JSON.stringify(updateManifest, null, 2) + '\n');
console.log(`Wrote ${outPath}`);
console.log(`  version: ${updateEntry.version}`);
console.log(`  update_link: ${updateEntry.update_link}`);
console.log(`  update_hash: ${updateEntry.update_hash}`);
