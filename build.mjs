import {glob} from './miniglob.mjs';
import fs from 'fs';
import path from 'path';
import * as url from 'url';
import webExt from 'web-ext';
import {spliceAndCopy} from './tools/splicer.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const builtDir = path.resolve(__dirname, 'built');
const chromeSourceDir = path.resolve(__dirname, 'chrome');
const firefoxGithubBuildDir = path.resolve(__dirname, 'build_firefox_github');
const firefoxAmoBuildDir = path.resolve(__dirname, 'build_firefox_amo');
const webBuildDir = path.resolve(__dirname, 'built/web');
const licenseText = fs.readFileSync(path.resolve(__dirname, 'LICENSE.md'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));

// Keep the unpacked build directories on disk so `web-ext run` and
// `web-ext lint` have something to point at. Off by default so a
// normal build still leaves only the zips in built/.
const KEEP_BUILD_DIRS = process.argv.includes('--keep');

fs.mkdirSync(builtDir, {recursive: true});
glob(builtDir + '/*.zip').forEach((file) => {
  fs.unlinkSync(file);
});

removeBuildDirs();
deleteDirectoryRecursively(webBuildDir);

function removeBuildDirs() {
  deleteDirectoryRecursively(firefoxGithubBuildDir);
  deleteDirectoryRecursively(firefoxAmoBuildDir);
}

function deleteDirectoryRecursively(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.readdirSync(dirPath).forEach((file, index) => {
      const curPath = path.join(dirPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        deleteDirectoryRecursively(curPath);
      } else {
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(dirPath);
  }
}

function extractImports(fileText) {
  const lines = fileText.split('\n');
  const newLines = [];
  const imports = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith('import')) {
      const match = line.match(/import\s+\{{0,1}(.*?)\}{0,1}\s+(?:as\s+(.*)\s+){0,1}from\s+'(.*)'/);

      if (!match) {
        throw new Error('Invalid import: ' + line);
      }

      const importName = match[1];
      const importAs = match[3] ? match[2] : null;
      const importFrom = match[3] || match[2];

      imports.push({
        name: importName,
        as: importAs,
        from: importFrom,
      });
    } else {
      newLines.push(line);
    }
  }

  return {
    imports: imports,
    fileText: newLines.join('\n'),
  };
}

function extractExports(fileText) {
  const lines = fileText.split('\n');
  const newLines = [];
  const exports = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith('export')) {
      const match = line.match(/export\s+(?:default\s+){0,1}(const|let|var|class|function)\s+([^= ]*)/);
      if (!match) {
        throw new Error('Invalid export: ' + line);
      }

      const exportType = match[1];
      const exportName = match[2];

      exports.push({
        type: exportType,
        name: exportName,
      });

      newLines.push(line.replace('export', '').trim());
      continue;
    }

    newLines.push(line);
  }
  return {
    exports: exports,
    fileText: newLines.join('\n'),
  };
}

// eslint-disable-next-line no-unused-vars
function generateScriptWithAllImports(sourceDir, filePath, resolvedPaths = []) {
  const text = extractExports(fs.readFileSync(filePath, 'utf8')).fileText;
  const {imports, fileText} = extractImports(text);

  const importScripts = [];
  imports.forEach((importData) => {
    const importPath = path.resolve(path.dirname(filePath), importData.from);
    if (resolvedPaths.includes(importPath)) {
      return;
    }

    resolvedPaths.push(importPath);
    const importScript = generateScriptWithAllImports(sourceDir, importPath, resolvedPaths);
    importScripts.push(importScript.trim());
  });

  return importScripts.join('\n') + '\n' + fileText;
}

async function runWebExtBuild(sourceDir, artifactsDir) {
  // A failed build rejects: the promise this was wrapped in never settled then, and the
  // build hung or died on an unhandled rejection with no word of what failed.
  const result = await webExt.cmd.build({
    sourceDir: sourceDir,
    artifactsDir: artifactsDir,
    overwriteDest: true,
  });
  return result.extensionPath;
}

function insertLicense(buildDir) {
  const newLicensePath = path.join(buildDir, 'LICENSE.md');
  fs.writeFileSync(newLicensePath, licenseText);
}

async function buildFirefoxGithub() {
  spliceAndCopy(chromeSourceDir, firefoxGithubBuildDir, ['EXTENSION', 'FIREFOX']);
  insertLicense(firefoxGithubBuildDir);

  const manifestPath = path.join(firefoxGithubBuildDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // 'downloads' and 'cookies' are in the source manifest. This build also asks for
  // 'contextualIdentities'; the AMO build deliberately does not (see below).
  manifest.permissions.push('contextualIdentities');

  manifest.browser_specific_settings = {
    gecko: {
      id: 'thanatus@Nawid',
      // Same floor and data-collection declaration as the AMO build.
      // data_collection_permissions needs Firefox 140+ (Android 142+);
      // without it web-ext lint warns MISSING_DATA_COLLECTION_PERMISSIONS.
      // The old floor of 136 only kept 136-139, all long out of support.
      strict_min_version: '142.0',
      data_collection_permissions: {
        required: ['none'],
      },
    },
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const builtPath = await runWebExtBuild(firefoxGithubBuildDir, path.join(firefoxGithubBuildDir, 'github'));
  const name = path.basename(builtPath);
  const finalPath = path.join(builtDir, 'firefox-github-' + name);
  fs.renameSync(builtPath, finalPath);
  return finalPath;
}


async function buildFirefoxAmo() {
  spliceAndCopy(chromeSourceDir, firefoxAmoBuildDir, ['EXTENSION', 'FIREFOX', 'NO_UPDATE_CHECKER']);
  insertLicense(firefoxAmoBuildDir);

  const manifestPath = path.join(firefoxAmoBuildDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  manifest.browser_specific_settings = {
    gecko: {
      id: 'thanatus@Nawid',
      // data_collection_permissions needs Firefox 140+ (Android 142+).
      strict_min_version: '142.0',
      // FastStream sends no telemetry and contacts no analytics
      // service, so nothing is collected. Required by AMO for all new
      // submissions: https://mzl.la/firefox-builtin-data-consent
      data_collection_permissions: {
        required: ['none'],
      },
      // Self-hosted update checking: this is an "unlisted" AMO build, so it
      // has no store page for Firefox to poll for new versions. Without
      // this, "Check for Updates" in about:addons has nothing to check
      // against. releases/latest/download/<name> is a GitHub redirect that
      // always resolves to whatever the current newest Release publishes
      // under that filename, so this URL never has to change between
      // releases - release.yml regenerates and re-uploads updates.json
      // (and the xpi it points at) every time it cuts one.
      update_url: 'https://github.com/Nawid3333/FastStream/releases/latest/download/updates.json',
    },
  };

  // 'cookies' is in the source manifest: the DOWNLOAD handler in background.mjs reads
  // `sender.tab.cookieStoreId` and passes it to `tabs.create()` so a
  // download started from a container tab runs in that container. Firefox
  // gates cookieStoreId on the "cookies" permission - Mozilla's own schema
  // says so in as many words on downloads.download - so dropping it would
  // quietly break container downloads.
  //
  // 'contextualIdentities' is deliberately not requested, for that same
  // reason. Mozilla's schema scopes that permission to the
  // `browser.contextualIdentities` namespace - querying and editing
  // container definitions - which nothing here calls. Reading a tab's
  // cookieStoreId, which is all this add-on does, needs 'cookies' and not
  // this.

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const builtPath = await runWebExtBuild(firefoxAmoBuildDir, path.join(firefoxAmoBuildDir, 'amo'));
  const name = path.basename(builtPath);
  const finalPath = path.join(builtDir, 'firefox-amo-' + name);
  fs.renameSync(builtPath, finalPath);
  return finalPath;
}


async function buildWeb() {
  spliceAndCopy(chromeSourceDir, webBuildDir, ['WEB', 'NO_UPDATE_CHECKER'], [
    'manifest.json',
    'content.js',
    'overlay-guard.js',
    'background',
    '_locales',
    'perms.html',
    'perms.mjs',
    'welcome.html',
    'icon2_128.png',
    'icon3_128.png',
    'icon16.png',
    'icon48.png',
    'keyboard.png',
    'custom',
  ]);


  insertLicense(webBuildDir);
}

async function runAll() {
  // update manifest version
  const manifestPath = path.join(chromeSourceDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = packageJson.version;
  // The trailing newline matters more than it looks: without it, every build
  // rewrote this file as a one-line "no newline at end of file" diff and
  // dirtied the working tree of anyone who ran build:keep. git, editors and
  // prettier all expect a final newline.
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Building version ${manifest.version}`);

  await Promise.all([buildFirefoxGithub(), buildFirefoxAmo(), buildWeb()]);
  if (KEEP_BUILD_DIRS) {
    console.log('Keeping unpacked build directories (--keep)');
  } else {
    removeBuildDirs();
  }
}

runAll();
