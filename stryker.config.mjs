// Mutation testing (T4): `pnpm run test:mutation`, and weekly on CI (mutation-tests.yml).
//
// Stryker changes one thing at a time in the modules below - a comparison, a bound, a
// call left out - and runs the unit tests against each change. A change the tests still
// pass is a place where a fix could ship without a test that fails without it: the rule
// every fix here follows, checked by hand until now. The weekly run reports; it does not
// gate (no break threshold).
//
// Only pure-logic modules with unit tests: the DOM and the player are the e2e suites'.
// Not all of them yet (#253): the 15 first ones were 3,833 mutants on 2026-10-03, the ten
// small ones added then 441. The rest with unit tests - the downloader (XHRLoader,
// DownloadEntry, DownloadManager, StandardDownloader, OPFSManager), NetRequestRuleManager,
// SecureMemory, StringUtils, BackgroundUtils, LevelManager, SyncedAudioPlayer, the HLS and
// DASH loaders - are 2,790 more, and the tools and e2e harness modules with tests 3,084:
// together over twice the run, past the job's 240 minutes. They wait for the first weekly
// run's time, or for Stryker's vitest runner (per-test coverage) to support vitest 5.
//
// The weekly job runs on Linux: the mpv host's Windows-only tests (mpvHostInstall, the
// PowerShell cases of mpvHostSecurity) are skipped there, so its PowerShell and WMI
// mutants can only survive, and count against its score.
//
// The command runner: every mutant runs the whole unit suite, switched on through
// __STRYKER_ACTIVE_MUTANT__, about 1.2 s each with 4 workers. Stryker's vitest runner would
// run only the tests that reach a mutant, but its newest release (10.0.0, August 2026)
// predates vitest 5 and switches no mutant on there: every one "survived". Use it again
// once a release supports vitest 5.

export default {
  testRunner: 'command',
  commandRunner: {command: 'node node_modules/vitest/vitest.mjs run --bail=1 --reporter=dot'},
  coverageAnalysis: 'off',
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
  mutate: [
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
    'native-host/faststream-mpv-host.mjs',
  ],
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: {fileName: 'reports/mutation/index.html'},
  jsonReporter: {fileName: 'reports/mutation/mutation.json'},
  thresholds: {high: 80, low: 60, break: null},
  concurrency: 4,
  timeoutMS: 60000,
  incremental: false,
};
