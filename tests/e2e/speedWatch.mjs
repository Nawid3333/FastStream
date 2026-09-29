// Keeps the player's speed presets from misleading a test.
//
// The player has mpv-style speed presets: R, G, B, Q, W, A, Y, E and H each set a speed
// from 1x to 16x (DefaultKeybinds.mjs), and the speed stays for the rest of the page's
// life. A test that presses one of those letters, on purpose or by accident, leaves the
// video playing at up to 16x, and every time it, or the next test on the same page,
// measures is then off without anything saying why. So around every test:
// - before it, a speed left over from an earlier test on the same page is set back to 1x,
//   and the log says so;
// - after it, the log names the preset keys pressed during the test and the speed it ended
//   at, marked "SPEED" when the test failed, so that a timing failure is not taken for a
//   player bug.
// Only a player in the page the session is on is seen, not one inside a frame from
// another origin (the extension's player embedded in a web page).

const PRESET = 'SpeedPreset';
const LATE = Symbol('late');

// A page that is busy, navigating or gone must not hold the next test up, nor turn a
// test's own failure into one from here. A page too busy to answer gives LATE, so that
// the log can say the speed went unchecked rather than stay silent.
async function soon(promise) {
  let timer;
  const late = new Promise((resolve) => timer = setTimeout(() => resolve(LATE), 3000));
  try {
    return await Promise.race([promise, late]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sets a leftover preset speed back to 1x and starts logging the preset keys pressed.
 * @param {Object} test - The mocha test about to run.
 * @return {Promise<void>}
 */
export async function speedBeforeTest(test) {
  const leftover = await soon(browser.execute((prefix) => {
    const client = window.fastStream;
    const manager = client && client.keybindManager;
    if (!manager) return null;
    if (!manager.e2ePresetPresses) {
      manager.e2ePresetPresses = [];
      manager.on('keybind', (actions) => {
        manager.e2ePresetPresses.push(...actions.filter((action) => action.startsWith(prefix)));
      });
    }
    manager.e2ePresetPresses.length = 0;
    const rate = client.playbackRate;
    if (rate === 1) return null;
    client.playbackRate = 1;
    return rate;
  }, PRESET));
  if (leftover === LATE) {
    console.log(`      speed: the page did not answer within 3 s before "${test.title}": ` +
      'a speed left by an earlier test was not checked');
  } else if (leftover) {
    console.log(`      speed: set back to 1x from ${leftover}x, left by an earlier test, before "${test.title}"`);
  }
}

/**
 * Logs the preset keys pressed during a test and the speed it ended at, if either is
 * worth saying.
 * @param {Object} test - The mocha test that ran.
 * @param {boolean} passed - Whether it passed.
 * @return {Promise<void>}
 */
export async function speedAfterTest(test, passed) {
  const state = await soon(browser.execute(() => {
    const client = window.fastStream;
    const manager = client && client.keybindManager;
    if (!manager) return null;
    // A page opened during the test was not there to be logged from its start. Its
    // presets' revert memory, empty when the page loaded, says which ones were used on it.
    const presses = manager.e2ePresetPresses ?
      [...manager.e2ePresetPresses] : Object.keys(manager.presetRevertMemory || {});
    // Read once: should the next test's start find the page too busy to clear the log,
    // these presses must not be counted again as the next test's.
    if (manager.e2ePresetPresses) manager.e2ePresetPresses.length = 0;
    return {rate: client.playbackRate, presses};
  }));
  if (state === LATE) {
    if (!passed) {
      console.log(`      SPEED: the page did not answer within 3 s after "${test.title}": ` +
        'whether a speed preset was on is not known');
    }
    return;
  }
  if (!state || (state.rate === 1 && !state.presses.length)) return;
  const keys = state.presses.length ? `preset keys pressed: ${state.presses.join(', ')}` : 'no preset key pressed';
  const line = `${keys}; "${test.title}" ended at ${state.rate}x`;
  console.log(passed ? `      speed: ${line}` :
    `      SPEED: ${line}. The times this failed test measured ran at that speed.`);
}
