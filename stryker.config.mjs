// Mutation testing (T4): `pnpm run test:mutation`, and weekly on CI (mutation-tests.yml).
//
// Stryker changes one thing at a time in the modules below - a comparison, a bound, a
// call left out - and runs the unit tests against each change. A change the tests still
// pass is a place where a fix could ship without a test that fails without it: the rule
// every fix here follows, checked by hand until now. The weekly run reports; it does not
// gate (no break threshold).
//
// Only pure-logic modules with unit tests: the DOM and the player are the e2e suites'.
// In four areas (#253): `core`, `network` (the downloader, the loaders and what they use),
// `tools` (the tools and e2e harness modules with unit tests) and `host` (the mpv host, on
// the command runner), each split into shards (SHARDS, below) that mutation-tests.yml runs
// side by side, each in a job of its own. STRYKER_SHARD picks one; without it, all of them run (`pnpm run test:mutation`,
// locally).
//
// How long an area took with the command runner, measured on CI (#349, run 37333779402,
// 2026-10-05): network 7 mutants a minute, core 14, tools 10 - with ~3,300, ~5,100 and
// ~3,200 mutants, 7.7, 6 and 5.3 hours. The first estimate (1.2 s a mutant, 2026-10-04) was a local run's: on CI a
// mutant the tests do not catch runs the whole suite (~18 s), and a third to a half of
// them survive. One job an area ran out of its 240 minutes at 51-74%, and no report came.
// So each area was cut into PARTS shards of about the same size, each a few hours; with the
// vitest runner (below) a shard should take minutes, measured on its first CI run.
//
// The weekly job runs on Linux: the mpv host's Windows-only tests (mpvHostInstall, the
// PowerShell cases of mpvHostSecurity) are skipped there, so its PowerShell and WMI
// mutants can only survive, and count against its score.
//
// Stryker's vitest runner, with per-test coverage: a mutant runs only the tests that reached
// its code, in a Vitest that stays up between mutants - 143 mutants in 31 s on a PC
// (2026-10-06), where the command runner ran the whole unit suite for each, ~18 s a mutant
// on CI, the hours above. Its 10.0.0 release (August 2026) predates Vitest 5, which joins a
// test's suite chain with ' > ': its test filter matched nothing and every mutant
// "survived" (stryker-js #6210). FastStream carries the fix, stryker-js PR #6214, as a pnpm
// patch (patches/@stryker-mutator__vitest-runner@10.0.0.patch); the Patched libraries
// workflow drops it once a release has it, and moves @stryker-mutator/core with the runner
// (LOCKSTEP in tools/check-patched-updates.mjs).
//
// A mutant is switched on inside the test worker, so a test that runs a module as a process
// of its own does not see it there. For the mpv host that left its message loop untested,
// so the host keeps the command runner (COMMAND_AREAS); the tools' tests that start their
// tool as a process only reach its entry line, where the vitest runner sees a crashed run.
import fs from 'node:fs';

export const AREAS = {
  core: [
    'chrome/background/CustomSourcePatterns.mjs',
    'chrome/background/DownloadFilename.mjs',
    'chrome/background/KeyShortcut.mjs',
    'chrome/background/ManifestTypes.mjs',
    'chrome/background/MpvBackend.mjs',
    'chrome/background/MultiRegexMatcher.mjs',
    'chrome/background/StreamLengths.mjs',
    'chrome/background/TabTracker.mjs',
    'chrome/background/UrlMatchList.mjs',
    'chrome/player/modules/LargeBuffer.mjs',
    'chrome/player/modules/hls2mp4/ptsNormalize.mjs',
    'chrome/player/modules/remux/TimestampRebaser.mjs',
    'chrome/player/network/OpQueue.mjs',
    'chrome/player/network/SpeedTracker.mjs',
    'chrome/player/options/KeybindUtils.mjs',
    'chrome/player/players/hls/HLSDecrypter.mjs',
    'chrome/player/players/mp4/SourceBufferWrapper.mjs',
    'chrome/player/players/mp4/StallWatchdog.mjs',
    'chrome/player/ui/FrameStepper.mjs',
    'chrome/player/utils/StreamLength.mjs',
    'chrome/player/utils/StreamPick.mjs',
    'chrome/player/utils/SubtitleSyncUtils.mjs',
    'chrome/player/utils/SubtitleUtils.mjs',
    'chrome/player/utils/URLUtils.mjs',
  ],
  network: [
    'chrome/background/BackgroundUtils.mjs',
    'chrome/background/NetRequestRuleManager.mjs',
    'chrome/player/modules/SecureMemory.mjs',
    'chrome/player/network/DownloadEntry.mjs',
    'chrome/player/network/DownloadManager.mjs',
    'chrome/player/network/OPFSManager.mjs',
    'chrome/player/network/StandardDownloader.mjs',
    'chrome/player/network/FetchLoader.mjs',
    'chrome/player/players/LevelManager.mjs',
    'chrome/player/players/SyncedAudioPlayer.mjs',
    'chrome/player/players/dash/DashLoader.mjs',
    'chrome/player/players/hls/HLSFragmentRequester.mjs',
    'chrome/player/players/hls/HLSLoader.mjs',
    'chrome/player/utils/StringUtils.mjs',
  ],
  tools: [
    'tests/e2e/bidi.mjs',
    'tests/e2e/mozLog.mjs',
    'tests/e2e/mp4Fixture.mjs',
    'tests/e2e/reportRetried.mjs',
    'tests/e2e/retriedSpecs.mjs',
    'tests/e2e/serveFile.mjs',
    'tests/e2e/setupGuard.mjs',
    'tests/e2e/shardSpecs.mjs',
    'tests/e2e/testTimeout.mjs',
    'tools/check-patched-updates.mjs',
    'tools/check-toolchain.mjs',
    'tools/check-update-path.mjs',
    'tools/e2e-spec-weights.mjs',
    'tools/fetch-amo-signed.mjs',
    'tools/mutation-report.mjs',
    'tools/newest-release.mjs',
    'tools/recut-patch.mjs',
    'tools/sign-amo.mjs',
    'tools/verify-linux.mjs',
  ],
  // The mpv host, with the command runner (COMMAND_AREAS, below).
  host: ['native-host/faststream-mpv-host.mjs'],
};

// The areas Stryker runs with the command runner, every mutant against the whole unit suite
// in a process of its own, which hands the active mutant to the processes a test starts
// (__STRYKER_ACTIVE_MUTANT__). The vitest runner switches a mutant on inside the test worker
// only, and the mpv host's message loop - main() and sendMessage(), which run only in the
// host process mpvHostVersion.test.mjs starts and talks to - had no test reaching it there:
// 24 of its mutants the command runner caught were "no coverage" (CI runs 37384050152 and
// 37393654214, compared mutant by mutant, 2026-10-06). Every other module came out the same
// (11,313 of 11,370 alike; the rest a crashed run for a caught one, or two swapped on a line).
export const COMMAND_AREAS = ['host'];

// How many shards each area is cut into. With the vitest runner one each: on CI the seven
// shards of 2026-10-06 took 2 to 10 minutes (core 7 and 10, network 2 to 3, tools 2 to 3).
// The host, on the command runner, about an hour and a half at core's 14 mutants a minute,
// inside its job's 350 minutes (mutation-tests.yml).
export const PARTS = {core: 1, network: 1, tools: 1, host: 1};

/**
 * An area's modules in `parts` groups of about the same size, the size of a file standing
 * for how many mutants it gives: the largest first, each to the group with the least so far.
 * The same files give the same groups, so a shard's name always means the same modules.
 * @param {string[]} modules - The area's modules.
 * @param {number} parts - How many groups.
 * @return {string[][]} The groups, each in the area's own order.
 */
export function splitArea(modules, parts) {
  const size = (file) => {
    try {
      return fs.statSync(new URL(file, import.meta.url)).size;
    } catch {
      return 0;
    }
  };
  const groups = Array.from({length: parts}, () => ({files: new Set(), size: 0}));
  const bySize = modules.map((file) => ({file, size: size(file)}))
      .sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));
  for (const {file, size: bytes} of bySize) {
    const lightest = groups.reduce((min, group) => group.size < min.size ? group : min);
    lightest.files.add(file);
    lightest.size += bytes;
  }
  return groups.map((group) => modules.filter((file) => group.files.has(file)));
}

// core-1, network-1, tools-1, host-1: the shards mutation-tests.yml runs, one job each.
export const SHARDS = Object.fromEntries(Object.entries(AREAS).flatMap(([area, modules]) =>
  splitArea(modules, PARTS[area]).map((group, i) => [`${area}-${i + 1}`, group])));

/**
 * The modules a run mutates.
 * @param {string|undefined} shard - STRYKER_SHARD: a key of SHARDS, or empty for all.
 * @return {string[]}
 */
export function modulesOf(shard) {
  if (!shard) {
    return Object.values(SHARDS).flat();
  }
  if (!Object.hasOwn(SHARDS, shard)) {
    throw new Error(`STRYKER_SHARD is ${shard}: it is one of ${Object.keys(SHARDS).join(', ')}`);
  }
  return SHARDS[shard];
}

/**
 * The test runner settings for a shard: the command runner for one of COMMAND_AREAS, the
 * vitest runner otherwise - and for a run of everything at once (`pnpm run test:mutation`
 * with no STRYKER_SHARD), where the host's message loop then shows as no coverage.
 * @param {string|undefined} shard - STRYKER_SHARD.
 * @return {Object}
 */
export function runnerOf(shard) {
  if (shard && COMMAND_AREAS.some((area) => shard.startsWith(`${area}-`))) {
    return {
      testRunner: 'command',
      commandRunner: {command: 'node node_modules/vitest/vitest.mjs run --bail=1 --reporter=dot'},
      coverageAnalysis: 'off',
    };
  }
  return {
    testRunner: 'vitest',
    // pnpm's layout: Stryker looks for @stryker-mutator/* plugins beside its own core only.
    plugins: ['@stryker-mutator/vitest-runner'],
    vitest: {configFile: 'vitest.config.mjs'},
    coverageAnalysis: 'perTest',
  };
}

export default {
  ...runnerOf(process.env.STRYKER_SHARD),
  // What the sandbox leaves out: builds, profiles, logs and fixtures the unit tests never
  // read, and tsconfig.json, which Stryker would rewrite through TypeScript's JS API -
  // TypeScript 7 has none (`ts.parseConfigFileTextToJson is not a function`).
  ignorePatterns: [
    'tsconfig.json',
    '/.dev-profile*',
    '/build_firefox_*',
    '/built',
    '/logs',
    '/logs-moz',
    '/.e2e-downloads',
    '/reports',
    '/coverage',
    '/tests/e2e/fixtures',
    '/fsaunpack',
    '/docs',
  ],
  // Nothing here is TypeScript, and its HTML files do not parse as Stryker expects.
  disableTypeChecks: false,
  mutate: modulesOf(process.env.STRYKER_SHARD),
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: {fileName: 'reports/mutation/index.html'},
  jsonReporter: {fileName: 'reports/mutation/mutation.json'},
  thresholds: {high: 80, low: 60, break: null},
  concurrency: 4,
  timeoutMS: 60000,
  incremental: false,
};
