// @ts-check
// Bumps the version in package.json and the manifest, commits, tags and pushes; release.yml does the rest.
// Only for a deliberate version bump: auto-release.yml releases every ordinary push to main.
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
 * @param {Array<string>} args
 * @return {string}
 */
function git(args) {
  return execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
}

// 1. A clean tree, or the bump commit would absorb unrelated changes.
const dirty = git(['status', '--porcelain']);
if (dirty) {
  console.error('Working tree is not clean:');
  console.error(dirty);
  console.error('Commit or stash first.');
  process.exit(1);
}

// 2. A new version, checked against the remote's tags too: AMO and git refuse a reuse only deep in CI.
const existingTags = git(['tag', '--list', `v${newVersion}`, `V${newVersion}`]);
if (existingTags) {
  console.error(`Version ${newVersion} is already tagged:\n${existingTags}`);
  process.exit(1);
}
const remoteTags = git(['ls-remote', '--tags', 'origin', `refs/tags/v${newVersion}`, `refs/tags/V${newVersion}`]);
if (remoteTags) {
  console.error(`Version ${newVersion} is already tagged on origin:\n${remoteTags}\nRun git fetch --tags.`);
  process.exit(1);
}

// 2b. Only from main: release.yml refuses a tag not on main, but only once both are on GitHub.
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') {
  console.error(`A release is cut from main, not from ${branch}.`);
  process.exit(1);
}
console.log(`Cutting ${newVersion} from ${branch}...`);

// 3. Both files in the same commit.
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

// 4. Branch and tag in one atomic push: a refused tag would leave a bump that is never built.
const tag = `v${newVersion}`;
git(['tag', '-a', tag, '-m', `FastStream ${newVersion}`]);
try {
  git(['push', '--atomic', 'origin', branch, `refs/tags/${tag}`]);
} catch {
  console.error(`\nThe push was refused, so neither ${branch} nor ${tag} reached origin.`);
  console.error(`The commit and the tag are local only: fix the cause and run git push --atomic origin ${branch} ${tag},`);
  console.error(`or undo them with git tag -d ${tag} and git reset --hard HEAD~1.`);
  process.exit(1);
}

console.log(`\nPushed ${branch} and tag ${tag}.`);
console.log('release.yml is now building and will publish the GitHub Release ' +
    'automatically once it finishes (a few minutes) -- ' +
    'https://github.com/Nawid3333/FastStream/actions/workflows/release.yml');
