#!/usr/bin/env node
// Builds a persistent Firefox profile for `web-ext run` with uBlock Origin
// pre-installed.
//
// Why: `web-ext run` creates a throwaway profile with only FastStream in it.
// Real streaming sites are heavy with ads and overlay players, which makes it
// hard to tell "FastStream failed to replace the player" from "an ad iframe
// got in the way". Testing with a blocker matches how the extension is
// actually used.
//
// FastStream itself is NOT installed here — `web-ext run` loads it straight
// from build_firefox_libre/ on every launch, so source changes are reflected
// as soon as you rebuild.
//
//   node tools/setup-dev-profile.mjs      # download + install into .dev-profile
//   pnpm run start:ff                     # build + launch separate Firefox
//
// The profile is gitignored. Delete .dev-profile/ to start clean.

import fs from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';

/** Extensions to preinstall, keyed by their Firefox add-on ID. */
const ADDONS = [
  {
    id: 'uBlock0@raymondhill.net',
    name: 'uBlock Origin',
    url: 'https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi',
  },
];

const PROFILE = path.resolve('.dev-profile');
const EXT_DIR = path.join(PROFILE, 'extensions');

/**
 * Prefs that let a sideloaded add-on actually run in a fresh profile.
 * autoDisableScopes=0 is the important one: by default Firefox installs
 * profile-directory add-ons but leaves them disabled pending user approval,
 * which never comes in an automated run.
 */
const PREFS = [
  ['extensions.autoDisableScopes', 0],
  ['extensions.enabledScopes', 15],
  // Aggressively prevent the dev browser from claiming to be the default
  // browser or writing itself into Windows default-app associations.
  // Without this, a separate Firefox process can steal http/https from the
  // user's normal Firefox, so VS Code links open in the wrong browser.
  ['browser.shell.checkDefaultBrowser', false],
  ['browser.shell.skipDefaultBrowserCheckOnFirstRun', true],
  ['browser.shell.didSkipDefaultBrowserCheck', true],
  ['browser.shell.setDefaultBrowserUserChoice', false],
  ['browser.shell.setDefaultAlwaysAsk', false],
  ['browser.startup.homepage_override.mstone', 'ignore'],
  ['datareporting.policy.dataSubmissionEnabled', false],
  ['browser.aboutwelcome.enabled', false],
];

/**
 * Downloads a URL to a file, following redirects.
 * @param {string} url Source URL.
 * @param {string} dest Destination path.
 * @return {Promise<number>} Bytes written.
 */
async function download(url, dest) {
  const res = await fetch(url, {redirect: 'follow'});
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  await pipeline(res.body, fs.createWriteStream(dest));
  return fs.statSync(dest).size;
}

fs.mkdirSync(EXT_DIR, {recursive: true});

for (const addon of ADDONS) {
  // Firefox installs a profile add-on when the filename is its add-on ID.
  const dest = path.join(EXT_DIR, `${addon.id}.xpi`);
  if (fs.existsSync(dest)) {
    console.log(`${addon.name}: already present, skipping`);
    continue;
  }
  process.stdout.write(`${addon.name}: downloading... `);
  const bytes = await download(addon.url, dest);
  console.log(`${(bytes / 1e6).toFixed(1)} MB -> ${path.relative(process.cwd(), dest)}`);
}

// user.js is copied into prefs.js on every start, so these survive the
// profile changes web-ext writes back.
const userJs = PREFS
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join('\n');
fs.writeFileSync(path.join(PROFILE, 'user.js'), userJs + '\n');

console.log(`\nProfile ready at ${path.relative(process.cwd(), PROFILE)}`);
console.log('Run: pnpm run start:ff');
