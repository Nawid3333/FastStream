// Fails every test of a worker whose setup failed (F4).
//
// An error thrown in a config's before hook is only logged: WebdriverIO carries on, and
// every spec of the file runs without what the hook set up (bidi.mjs lives off the same
// behaviour). If installing the extension failed, the specs that check "the player does not
// open" passed in a browser with no extension at all. So a config's before hook records its
// failure here, and the mocha root hook below throws it before every test: a hook that
// throws fails the test it runs before, whatever WebdriverIO does with a config hook's
// error. The hooks still throw too, which keeps the logged error.

import {bidiRootHooks} from './bidi.mjs';

let setupError = null;

/**
 * Runs a config's setup, and records its failure for the root hook below.
 * @param {function(): Promise<void>} setup - The setup.
 * @return {Promise<void>} Rejects as the setup does.
 */
export async function guardSetup(setup) {
  // A retry is a worker of its own, with its own setup: only its own failure counts.
  setupError = null;
  try {
    await setup();
  } catch (e) {
    setupError = e;
    throw e;
  }
}

// The configs' mochaOpts.rootHooks: the setup's failure first, the more useful reason, then
// bidi.mjs's check; and after every test, the window's top again.
export const rootHooks = {
  beforeEach() {
    if (setupError) {
      throw new Error(`the suite's setup failed, so this test cannot run: ${setupError.message || setupError}`,
          {cause: setupError});
    }
    bidiRootHooks.beforeEach();
  },
  // A test that ended in a frame (a player's) could leave the next test's first browser.url()
  // waiting in a frame the navigation removed, until the 120 s timeout: on CI's Linux runner,
  // each hang came in a test after one that ended in the player's frame, before its first step
  // (autoplay-next-episode, main and #449, 2026-10-11; not every such test hung - a race in the
  // driver). framed-player.e2e.mjs did this itself. A window or a session already gone is no
  // news; anything else is said, so a reset that stops working shows.
  async afterEach() {
    try {
      await globalThis.browser?.switchFrame(null);
    } catch (e) {
      if (!/no such (window|frame)|invalid session|session (deleted|not created)/i.test(String(e?.message || e))) {
        console.warn('e2e: back to the window\'s top failed after a test:', e);
      }
    }
  },
};
