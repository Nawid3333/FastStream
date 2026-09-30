// Mocha's cap on one e2e test (mochaOpts.timeout). A test's own this.timeout() did not
// lift it under WebdriverIO: a local timing sweep of mpv-shortcut ended at 120 s on
// 2026-09-30. A long local run - a sweep, a loop that waits for a rare race - sets
// E2E_TEST_TIMEOUT_MS instead. CI keeps each suite's own cap: a test that hangs there
// fails at it, and the spec's retry and the job's other suites stay inside the job's
// time limit.

/**
 * @param {number} fallback - The suite's own cap, in ms.
 * @param {Object<string, string|undefined>} [env] - Where E2E_TEST_TIMEOUT_MS is read.
 * @return {number} E2E_TEST_TIMEOUT_MS when it is a whole number of ms above 0, else fallback.
 */
export function testTimeout(fallback, env = process.env) {
  const ms = Number(env.E2E_TEST_TIMEOUT_MS);
  return Number.isInteger(ms) && ms > 0 ? ms : fallback;
}
