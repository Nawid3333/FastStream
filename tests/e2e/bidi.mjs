// WebDriver BiDi for the suites that need it, or a fresh browser that has it.
//
// The playback and extension suites run their scripts over WebDriver BiDi, in the page's
// own realm. WebdriverIO connects to BiDi when the session starts and gives up after 10 s
// ("Could not connect to Bidi protocol of any candidate url in time", seen on the Windows
// runner). It then carries on over WebDriver classic without failing: browser.isBidi is
// false, and execute() and executeAsync() go to /execute/sync and /execute/async (9.32.0;
// only that connect, again on reloadSession(), decides isBidi). There a script runs in a sandbox,
// so its import() gets a module instance of its own (subtitle-search.e2e.mjs stubbed a
// RequestUtils the player never used, and saw no request), an ArrayBuffer made in it is
// from another realm (ORT refuses it: vad.e2e.mjs), and a result with an `error` field
// reads as a failed command (save-fmp4.e2e.mjs). They failed as flakes.
//
// The configs' before hooks call ensureBidi() first, which starts the browser again when
// the session came up without BiDi. When that did not help either, bidiRootHooks fails the
// file's tests with that as the reason (an error thrown in a config hook is only logged),
// and specFileRetries runs the file again in a fresh browser. Sessions that ask for
// classic (the classic and pbm suites) are left alone.

/**
 * Why a test must not run in this session, or null when it may.
 * @param {WebdriverIO.Browser} browser
 * @return {?string}
 */
export function bidiMissing(browser) {
  if (browser.isBidi || browser.requestedCapabilities?.['wdio:enforceWebDriverClassic']) {
    return null;
  }
  return 'WebDriver BiDi is not connected, so this would run over WebDriver classic, ' +
      'where the specs of this suite do not work (tests/e2e/bidi.mjs)';
}

/**
 * Starts the browser again while the session has no BiDi. Anything a before hook sets up
 * in the browser comes after this.
 * @param {WebdriverIO.Browser} [browser]
 * @param {number} [reloads] - How many times to start it again at most.
 * @return {Promise<void>}
 */
export async function ensureBidi(browser = globalThis.browser, reloads = 2) {
  for (let reload = 1; reload <= reloads && bidiMissing(browser); reload++) {
    console.log(`      WebDriver BiDi did not connect; starting the browser again (${reload} of ${reloads})`);
    await browser.reloadSession();
  }
}

// Mocha's root hooks (mochaOpts.rootHooks), which run before every test of the suite.
export const bidiRootHooks = {
  beforeEach() {
    const reason = bidiMissing(globalThis.browser);
    if (reason) {
      throw new Error(reason);
    }
  },
};
