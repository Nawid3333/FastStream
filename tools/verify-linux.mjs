#!/usr/bin/env node
// Runs CI's Linux checks here, before pushing:
//   pnpm run verify:linux [all|verify|workflows] [--distro <WSL distro>]...
//
// CI runs on Ubuntu with libx264 in its ffmpeg, where a Windows machine may have neither;
// PR #20 passed `pnpm run verify` here and failed on CI for exactly that. This runs CI's
// verify job (`pnpm run verify` with the current stable Firefox) and its workflows job
// (actionlint with shellcheck) on Linux, in WSL: tools/linux/setup.sh first brings the
// distro up to date (apt upgrade, the newest Node 22 and Firefox) and provisions it like
// the runner, then tools/linux/verify.sh runs on a copy of the working tree.
//
// It runs on each Ubuntu release CI does, read from the list runner-images.yml reads: the
// one ubuntu-latest gives, which every push runs on, and the newest one GitHub offers,
// which ubuntu-latest moves to next and which runner-images.yml tests daily. A release WSL
// does not have yet is installed. --distro names the distros to use instead. On Linux
// itself it runs verify.sh on the machine as it is.

import {spawnSync} from 'node:child_process';
import path from 'node:path';
import * as url from 'node:url';

const root = path.resolve(url.fileURLToPath(new URL('.', import.meta.url)), '..');
const RUNNER_IMAGES = 'https://raw.githubusercontent.com/actions/runner-images/main/README.md';

// The Ubuntu releases in GitHub's runner image table, read as runner-images.yml reads them:
// of the x64 images that are generally available, the one ubuntu-latest gives and the newest.
function ubuntuReleases(readme) {
  const rows = readme.split('\n').filter((row) => /^\|.*\| x64 \|/.test(row) && !/preview|beta|deprecated/i.test(row));
  const releases = (row) => [...row.matchAll(/`ubuntu-(\d{2}\.\d{2})`/g)].map((m) => m[1]);
  const latest = releases(rows.find((row) => row.includes('`ubuntu-latest`')) ?? '')[0];
  const newest = rows.flatMap(releases).sort((a, b) => a.localeCompare(b, 'en', {numeric: true})).at(-1);
  if (!latest || !newest) {
    throw new Error('no ubuntu-latest row in the runner image table; its format may have changed');
  }
  return {latest, newest};
}

const run = (cmd, args) => spawnSync(cmd, args, {stdio: 'inherit'}).status;

// wsl.exe writes its own messages in UTF-16.
function wslDistros() {
  const listed = spawnSync('wsl.exe', ['--list', '--quiet'], {encoding: 'utf16le'});
  return listed.status === 0 ? listed.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
}

async function main() {
  let what = 'all';
  const named = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (['all', 'verify', 'workflows'].includes(args[i])) {
      what = args[i];
    } else if (args[i] === '--distro' && args[i + 1]) {
      named.push(args[++i]);
    } else {
      console.error('usage: node tools/verify-linux.mjs [all|verify|workflows] [--distro <WSL distro>]...');
      return 1;
    }
  }

  if (process.platform === 'linux') {
    return run('bash', [path.join(root, 'tools/linux/verify.sh'), root, what]);
  }

  let distros = named.map((name) => ({name, role: 'named with --distro'}));
  if (distros.length === 0) {
    let releases;
    try {
      const response = await fetch(RUNNER_IMAGES);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      releases = ubuntuReleases(await response.text());
    } catch (e) {
      console.error(`Could not read which Ubuntu releases CI runs on from ${RUNNER_IMAGES}: ${e.message}`);
      console.error('Name the WSL distros instead: --distro Ubuntu-24.04');
      return 1;
    }
    distros = [{name: `Ubuntu-${releases.latest}`, role: 'ubuntu-latest, where every push runs'}];
    if (releases.newest !== releases.latest) {
      distros.push({name: `Ubuntu-${releases.newest}`, role: 'the newest image, which ubuntu-latest moves to next'});
    }
  }

  const results = [];
  for (const {name, role} of distros) {
    console.log(`\n=== ${name}: ${role}`);
    if (!wslDistros().includes(name)) {
      console.log(`WSL has no ${name} yet; installing it`);
      if (run('wsl.exe', ['--install', '-d', name, '--no-launch']) !== 0 || !wslDistros().includes(name)) {
        results.push(`${name}: could not be installed (wsl --install -d ${name})`);
        continue;
      }
    }
    const wslPath = spawnSync('wsl.exe', ['-d', name, '--', 'wslpath', '-a', root], {encoding: 'utf8'}).stdout.trim();
    if (!wslPath.startsWith('/')) {
      results.push(`${name}: could not map ${root} into it`);
      continue;
    }
    let status = run('wsl.exe', ['-d', name, '-u', 'root', '--', 'bash', `${wslPath}/tools/linux/setup.sh`, wslPath]);
    if (status !== 0) {
      results.push(`${name}: setup failed`);
      continue;
    }
    status = run('wsl.exe', ['-d', name, '-u', 'faststream', '--', 'bash', `${wslPath}/tools/linux/verify.sh`, wslPath, what]);
    results.push(`${name}: ${status === 0 ? 'passed' : 'FAILED'}`);
  }
  console.log(`\n=== verify:linux ${what}\n${results.join('\n')}`);
  return results.every((r) => r.endsWith(': passed')) ? 0 : 1;
}

export {ubuntuReleases};

// Run as a command; imported (tests/unit/verifyLinux.test.mjs), it only exports the above.
if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => {
    console.error(`verify-linux: ${e.message}`);
    process.exit(1);
  });
}
