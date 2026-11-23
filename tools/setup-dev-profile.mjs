// @ts-check
// Builds a persistent Firefox profile for web-ext run with uBlock Origin pre-installed.
// Real streaming sites are full of ads and overlays: testing with a blocker matches real use.
// FastStream itself is not installed: web-ext run loads it from build_firefox_github/ at each launch.
//   node tools/setup-dev-profile.mjs      # download + install into .dev-profile
//   pnpm run start:ff                     # build + launch separate Firefox
// The profile is gitignored. Delete .dev-profile/ to start clean.

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';

/**
 * Pinned by version and SHA-256 (web-ext turns add-on updates off).
 * To move one: AMO's /api/v5/addons/addon/<slug>/ gives current_version's file url and hash; hash the file yourself too.
 */
export const ADDONS = [
  {
    id: 'uBlock0@raymondhill.net',
    name: 'uBlock Origin',
    version: '1.77.0',
    url: 'https://addons.mozilla.org/firefox/downloads/file/5290541/ublock_origin-1.77.0.xpi',
    sha256: '894ea48dedd26a637ab98ba627ae70b7ed94798eabfd4b089f5e5e73524a24eb',
  },
];

// The repository's, as the launchers use it.
const PROFILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.dev-profile');
const EXT_DIR = path.join(PROFILE, 'extensions');

/**
 * autoDisableScopes=0: Firefox otherwise leaves profile add-ons disabled pending an approval that never comes.
 */
const PREFS = [
  ['extensions.autoDisableScopes', 0],
  ['extensions.enabledScopes', 15],
  // The dev browser must never claim http/https from the user's Firefox.
  ['browser.shell.checkDefaultBrowser', false],
  ['browser.shell.skipDefaultBrowserCheckOnFirstRun', true],
  ['browser.shell.didSkipDefaultBrowserCheck', true],
  ['browser.shell.setDefaultBrowserUserChoice', false],
  ['browser.shell.setDefaultAlwaysAsk', false],
  ['browser.startup.homepage_override.mstone', 'ignore'],
  // Firefox 89+ hides the bookmarks toolbar ('newtab'), and the test links with it.
  ['browser.toolbars.bookmarks.visibility', 'always'],
  ['datareporting.policy.dataSubmissionEnabled', false],
  ['browser.aboutwelcome.enabled', false],
];

const BOOKMARKS = [
  {
    name: 'DASH test',
    url: 'https://reference.dashif.org/dash.js/latest/samples/getting-started/auto-load-single-video-src.html',
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
 * Keeps the file only when its SHA-256 matches: anything else is deleted, not taken for present next time.
 * @param {string} url
 * @param {string} dest
 * @param {string} sha256
 * @return {Promise<number>}
 */
export async function download(url, dest, sha256) {
  const res = await fetch(url, {redirect: 'follow'});
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const part = dest + '.part';
  try {
    await pipeline(/** @type {NonNullable<typeof res.body>} */ (res.body), fs.createWriteStream(part));
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

  // user.js is copied into prefs.js on every start: these survive what web-ext writes back.
  const userJs = PREFS
      .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
      .join('\n');
  fs.writeFileSync(path.join(PROFILE, 'user.js'), userJs + '\n');

  // A Netscape bookmarks file Firefox imports at first start; PERSONAL_TOOLBAR_FOLDER puts it on the toolbar.
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
 * @param {string} text
 * @return {string}
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
