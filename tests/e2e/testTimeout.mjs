// Mocha's cap on one e2e test: a test's own this.timeout() does not lift it under WebdriverIO. Long
// local runs set E2E_TEST_TIMEOUT_MS; CI keeps each suite's cap.

/**
 * @param {number} fallback - The suite's own cap, in ms.
 * @param {Object<string, string|undefined>} [env] - Where E2E_TEST_TIMEOUT_MS is read.
 * @return {number} E2E_TEST_TIMEOUT_MS when it is a whole number of ms above 0, else fallback.
 */
export function testTimeout(fallback, env = process.env) {
  const ms = Number(env.E2E_TEST_TIMEOUT_MS);
  return Number.isInteger(ms) && ms > 0 ? ms : fallback;
}
