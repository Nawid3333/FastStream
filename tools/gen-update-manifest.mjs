// @ts-check
// Writes web-ext-artifacts/updates.json, the self-hosted update manifest the AMO build's update_url names.
// Run after signing, from the repo root:
//   node tools/gen-update-manifest.mjs <owner/repo> <tag>
// e.g. node tools/gen-update-manifest.mjs Nawid3333/FastStream v1.3.80.0
// Id and version come from build_firefox_amo/manifest.json, the xpi from web-ext-artifacts/.
// Only the just-signed version is listed: enough while no release strands users on an older Firefox.

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
// web-ext-artifacts/ keeps earlier runs' files: only <id>-<version>.xpi is this version's.
if (!xpiName.endsWith(`-${manifest.version}.xpi`)) {
  console.error(`${xpiName} is not the xpi of version ${manifest.version} (its name must end in -${manifest.version}.xpi): remove stale .xpi files from ${artifactsDir} and sign again`);
  process.exit(1);
}
const xpiBuffer = fs.readFileSync(path.join(artifactsDir, xpiName));
const hash = crypto.createHash('sha256').update(xpiBuffer).digest('hex');

/** @type {{version: string, update_link: string, update_hash: string, applications?: {gecko: {strict_min_version: string}}}} */
const updateEntry = {
  version: manifest.version,
  update_link: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(xpiName)}`,
  update_hash: `sha256:${hash}`,
};
if (gecko.strict_min_version) {
  updateEntry.applications = {gecko: {strict_min_version: gecko.strict_min_version}};
}

// A Map, not an object, for an id read from a build artifact (CodeQL js/remote-property-injection).
if (id.includes('"') || id.includes('\\')) {
  console.error(`Unexpected gecko id in ${manifestPath}: ${id}`);
  process.exit(1);
}
const addons = new Map([[id, {updates: [updateEntry]}]]);
const updateManifest = {addons: Object.fromEntries(addons)};

const outPath = path.join(artifactsDir, 'updates.json');
fs.writeFileSync(outPath, JSON.stringify(updateManifest, null, 2) + '\n');
console.log(`Wrote ${outPath}`);
console.log(`  version: ${updateEntry.version}`);
console.log(`  update_link: ${updateEntry.update_link}`);
console.log(`  update_hash: ${updateEntry.update_hash}`);
