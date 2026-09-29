// The harness's guard against the speed preset keys (speedWatch.mjs, which the wdio
// configs run around every test): a preset pressed in one test must not leave the next
// test on the same page playing at its speed, and the presses are logged per test. The
// cases run in order on one page, the second one depending on the first: that is the point.

import {browser, expect} from '@wdio/globals';

const rate = () => browser.execute(() => window.fastStream.playbackRate);
const presses = () => browser.execute(() => window.fastStream.keybindManager.e2ePresetPresses);

describe('Speed presets between tests', function() {
  before(async function() {
    await browser.url('/player/index.html?t=' + Date.now() + '#' +
      globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/sample.mp4');
    await browser.waitUntil(() => browser.execute(() => {
      const video = document.querySelector('video');
      return !!(window.fastStream && video && video.readyState >= 2);
    }), {timeout: 60000, timeoutMsg: 'video never became ready'});
  });

  it('a preset key sets its speed, and the test ends with it on', async function() {
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyQ', key: 'q', bubbles: true, cancelable: true,
    })));
    expect(await rate()).toBe(3);
    expect(await presses()).toEqual(['SpeedPreset3']);
  });

  it('the next test on the page starts at 1x, with no presses logged', async function() {
    expect(await rate()).toBe(1);
    expect(await presses()).toEqual([]);
  });
});
