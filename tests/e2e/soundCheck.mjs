// What a spec that listens to the player does when this machine played no sound.
//
// Where Firefox has no audio device its AudioContext never starts, and the cases that
// listen (firefox.e2e.mjs's 8x pin, audio-tools.e2e.mjs) can only skip. They skipped on
// every CI job, so the 8x pin ran only on the owner's PC (#265). Linux CI's e2e setup now
// gives Firefox a device, a PulseAudio null sink (.github/actions/e2e-setup), and there a
// missing sound is a failure, not a skip. Windows' runner has no audio endpoint (its
// AudioContext stays "suspended") and nothing to start one, so there they still skip, as
// they do on a developer's machine without sound and in verify:linux.

/**
 * Whether this machine was given a sound device for the e2e suites: Linux CI.
 * @param {Object<string, string|undefined>} [env] - The environment.
 * @param {string} [platform] - process.platform.
 * @return {boolean}
 */
export function soundRequired(env = process.env, platform = process.platform) {
  return platform === 'linux' && !!env.CI;
}

/**
 * Skips a case that needs sound on a machine without it, or fails it where the e2e setup
 * gave Firefox a sound device.
 * @param {{skip: function(): void}} test - The running mocha case (its `this`).
 * @param {string} what - What did not happen, for the log or the error.
 * @param {Object} state - What the page reported.
 * @param {Object<string, string|undefined>} [env] - The environment.
 * @param {string} [platform] - process.platform.
 */
export function withoutSound(test, what, state, env = process.env, platform = process.platform) {
  const details = JSON.stringify(state);
  if (soundRequired(env, platform)) {
    throw new Error(`${what}, on Linux CI, where the e2e setup gives Firefox a sound device ` +
      `(PulseAudio sink ${env.E2E_SOUND_SINK || 'not set up'}, PULSE_SERVER ` +
      `${env.PULSE_SERVER || 'not set'}): ${details}`);
  }
  console.log(`      ${what}, skipping:`, details);
  test.skip();
}
