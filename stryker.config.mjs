// Mutation testing (T4): `pnpm run test:mutation`, and weekly on CI (mutation-tests.yml).
//
// Stryker changes one thing at a time in the modules below - a comparison, a bound, a
// call left out - and runs the unit tests against each change. A change the tests still
// pass is a place where a fix could ship without a test that fails without it: the rule
// every fix here follows, checked by hand until now. The weekly run reports; it does not
// gate (no break threshold).
//
// Only pure-logic modules with unit tests: the DOM and the player are the e2e suites'.
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
    'chrome/background/MpvBackend.mjs',
    'chrome/background/MultiRegexMatcher.mjs',
    'chrome/background/StreamLengths.mjs',
    'chrome/background/TabTracker.mjs',
    'chrome/background/UrlMatchList.mjs',
    'chrome/player/options/KeybindUtils.mjs',
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
