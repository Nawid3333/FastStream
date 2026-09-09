#!/usr/bin/env node
// Cuts a release: bumps the version everywhere it needs to live in sync,
// commits, tags, and pushes both. That push is what release.yml watches
// for (v*.*.* / V*.*.* tags) - once this script exits, GitHub Actions
// builds all four flavors, signs the Firefox one, and publishes the
// GitHub Release on its own. Nothing here talks to GitHub's API directly.
//
// Replaces the multi-step-by-hand process (edit two files, commit, tag,
// push branch, push tag, in the right order) that produced a race the
// first time v1.3.79.0 was cut: the tag landed before every file agreed
// on the version, and a manual gh release upload had to patch the result
// afterward. This does the whole sequence atomically enough that a
// pushed tag always points at a commit where package.json,
// chrome/manifest.json and the tag itself already agree.
//
// Usage:
//   node tools/cut-release.mjs 1.3.80.0
//   pnpm run release 1.3.80.0

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '..');

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error('Usage: node tools/cut-release.mjs <major.minor.patch.build>');
  console.error('Example: node tools/cut-release.mjs 1.3.80.0');
  process.exit(1);
}

/**
 * Runs a git command and returns trimmed stdout.
 * @param {Array<string>} args - git subcommand and arguments.
 * @return {string} Trimmed stdout.
 */
function git(args) {
  return execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
}

// 1. The tree has to be clean, or the version-bump commit this script
//    makes would silently absorb unrelated work-in-progress changes.
const dirty = git(['status', '--porcelain']);
if (dirty) {
  console.error('Working tree is not clean:');
  console.error(dirty);
  console.error('Commit or stash first.');
  process.exit(1);
}

// 2. Refuse to reuse a version. AMO refuses the same version+channel
//    twice and a duplicate git tag push is simply rejected, but both of
//    those failures happen deep inside CI - much cheaper to catch here.
const existingTags = git(['tag', '--list', `v${newVersion}`, `V${newVersion}`]);
if (existingTags) {
  console.error(`Version ${newVersion} is already tagged:\n${existingTags}`);
  process.exit(1);
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
console.log(`Cutting ${newVersion} from ${branch}...`);

// 3. Bump both files in the same commit. These two have drifted apart
//    before (chore: update version to 1.3.79.0 in manifest and package
//    files was needed specifically because they hadn't).
const packageJsonPath = path.join(root, 'package.json');
const manifestPath = path.join(root, 'chrome/manifest.json');

for (const p of [packageJsonPath, manifestPath]) {
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  data.version = newVersion;
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

git(['add', 'package.json', 'chrome/manifest.json']);
git(['commit', '-m', `chore: release ${newVersion}`]);
console.log('Committed version bump.');

// 4. Tag and push both. The tag is what release.yml's `on: push: tags:`
//    trigger is watching for - pushing it is what starts the build.
const tag = `v${newVersion}`;
git(['tag', '-a', tag, '-m', `FastStream ${newVersion}`]);
git(['push', 'origin', branch]);
git(['push', 'origin', tag]);

console.log(`\nPushed ${branch} and tag ${tag}.`);
console.log('release.yml is now building and will publish the GitHub Release ' +
    'automatically once it finishes (a few minutes) -- ' +
    'https://github.com/Nawid3333/FastStream/actions/workflows/release.yml');
