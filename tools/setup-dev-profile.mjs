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
// from build_firefox_github/ on every launch, so source changes are reflected
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
  // Keep the bookmarks toolbar on screen. Firefox 89+ defaults this to
  // 'newtab', which hides the imported test links as soon as a page loads.
  ['browser.toolbars.bookmarks.visibility', 'always'],
  ['datareporting.policy.dataSubmissionEnabled', false],
  ['browser.aboutwelcome.enabled', false],
];

/**
 * Default test bookmarks for FastStream playback validation. Firefox will
 * import these automatically when a fresh profile first starts.
 */
const BOOKMARKS = [
  {
    name: 'DASH test',
    url: 'https://reference.dashif.org/dash.js/v4.4.0/samples/getting-started/auto-load-single-video-src.html',
  },
  {
    name: 'HLS test',
    url: 'https://tracylocalschool.com/gquzbcolcgom',
  },
  {
    name: 'MP4 test',
    url: 'https://video.nie.edu.sg/media/Sample-Video-File-For-Testing.mp4/0_9311zvk2/22238',
  },
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

// Write a bookmarks file that Firefox imports automatically on first run.
// The Netscape bookmark format is the simplest portable format that
// Firefox still recognises at startup.
// PERSONAL_TOOLBAR_FOLDER="true" is what tells Firefox's importer that this
// folder is the Bookmarks Toolbar rather than the Bookmarks Menu. Without it
// the links import correctly but land in the menu, where they are two clicks
// away instead of visible on every new tab.
const bookmarkLinks = BOOKMARKS
    .map((b) => `        <DT><A HREF="${escapeHtml(b.url)}" ADD_DATE="0">${escapeHtml(b.name)}</A>`)
    .join('\n');
const bookmarksHtml = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated bookmarks file for FastStream testing. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Toolbar</H3>
    <DL><p>
${bookmarkLinks}
    </p></DL>
</p></DL>
`;
fs.writeFileSync(path.join(PROFILE, 'bookmarks.html'), bookmarksHtml);

/**
 * Minimal HTML escaping for the bookmark file.
 * @param {string} text Raw text.
 * @return {string} Escaped text.
 */
function escapeHtml(text) {
  return text
      .replace(/\u0026/g, '\u0026amp;')
      .replace(/\u003c/g, '\u0026lt;')
      .replace(/\u003e/g, '\u0026gt;')
      .replace(/"/g, '\u0026quot;');
}

console.log(`\nProfile ready at ${path.relative(process.cwd(), PROFILE)}`);
console.log('Run: pnpm run start:ff');
