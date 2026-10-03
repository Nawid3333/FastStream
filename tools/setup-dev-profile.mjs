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

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';

/**
 * Extensions to preinstall, keyed by their Firefox add-on ID.
 *
 * Each is a release pinned by version and SHA-256, as .github/mpv-build.json pins mpv: the
 * `latest` URL this used put whatever AMO served that day into the profile, unchecked (#177).
 * web-ext turns add-on updates off in the profiles it runs, so the version stays as installed.
 * To move it: https://addons.mozilla.org/api/v5/addons/addon/ublock-origin/ gives
 * current_version.version, .file.url and .file.hash; hash the downloaded file yourself too.
 */
export const ADDONS = [
  {
    id: 'uBlock0@raymondhill.net',
    name: 'uBlock Origin',
    version: '1.75.0',
    url: 'https://addons.mozilla.org/firefox/downloads/file/5034826/ublock_origin-1.75.0.xpi',
    sha256: '5b74415860456370644bd80f16125e865b0e6c356bb5dfcfb84069967eaa5287',
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
 * Downloads a URL to a file, following redirects, and keeps the file only when its SHA-256 is
 * the one expected. Anything else is deleted, so the next run downloads it again instead of
 * taking it for "already present".
 * @param {string} url Source URL.
 * @param {string} dest Destination path.
 * @param {string} sha256 The file's expected SHA-256, in hex.
 * @return {Promise<number>} Bytes written.
 */
export async function download(url, dest, sha256) {
  const res = await fetch(url, {redirect: 'follow'});
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const part = dest + '.part';
  try {
    await pipeline(res.body, fs.createWriteStream(part));
    const got = createHash('sha256').update(fs.readFileSync(part)).digest('hex');
    if (got !== sha256) {
      throw new Error(`${url}: SHA-256 ${got}, expected ${sha256}`);
    }
    fs.renameSync(part, dest);
  } finally {
    fs.rmSync(part, {force: true});
  }
  return fs.statSync(dest).size;
}

async function main() {
  fs.mkdirSync(EXT_DIR, {recursive: true});

  for (const addon of ADDONS) {
    // Firefox installs a profile add-on when the filename is its add-on ID.
    const dest = path.join(EXT_DIR, `${addon.id}.xpi`);
    if (fs.existsSync(dest)) {
      console.log(`${addon.name}: already present, skipping`);
      continue;
    }
    process.stdout.write(`${addon.name} ${addon.version}: downloading... `);
    const bytes = await download(addon.url, dest, addon.sha256);
    console.log(`${(bytes / 1e6).toFixed(1)} MB, SHA-256 checked -> ${path.relative(process.cwd(), dest)}`);
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

  console.log(`\nProfile ready at ${path.relative(process.cwd(), PROFILE)}`);
  console.log('Run: pnpm run start:ff');
}

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
