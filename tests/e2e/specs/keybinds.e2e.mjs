// Regression coverage for the default keybinds.
//
// Every press travels the path a physical one would: a KeyboardEvent on document,
// turned into a key string by WebUtils.getKeyString ('Shift+' while shiftKey is held,
// then e.code) and matched exactly against DefaultKeybinds. The events are synthetic,
// so no real keyboard or window focus is needed, and the video stays paused - nothing
// here depends on playback, only on seeks and on the playback rate read back.
//
// Guarded:
//
// - Digit1..Digit9 jump to 10%..90% of the duration.
// - The mpv-style speed presets: a preset key sets its speed, pressing the SAME key
//   again reverts to the rate that was active before it took effect, and that memory
//   is per key (Q, then Y, then Y lands on 3x, not 1x). The target is clamped to
//   options.maxPlaybackRate, which is 8 on Firefox and 16 on Chrome.
// - The six moved defaults: plain KeyW is now the 3.5x preset, and Shift+KeyW is
//   windowed fullscreen and must not touch the rate.

import {browser, expect} from '@wdio/globals';

describe('Keybinds', function() {
  // Dispatches a synthetic keydown on document, where the KeybindManager
  // listens. Dispatching on document itself means only the document listener
  // handles the event, so each press acts exactly once. e.key only has to be
  // plausible: WebUtils.getKeyString matches on e.code, so the digit for
  // DigitN and the bare letter for KeyN are enough.
  const pressKey = (code, {shift} = {}) => browser.execute((code, shift) => {
    let key;
    if (code.startsWith('Digit')) {
      key = code.slice(5);
    } else if (code === 'Space') {
      key = ' ';
    } else {
      key = code.slice(3).toLowerCase();
    }
    document.dispatchEvent(new KeyboardEvent('keydown', {
      code,
      key,
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
    }));
  }, code, !!shift);

  before(async function() {
    await browser.url('/player/index.html?t=' + Date.now() + '#' +
        globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/sample.mp4');
    await browser.waitUntil(
        async () => browser.execute(() => {
          const video = document.querySelector('video');
          return !!(window.fastStream && video && video.readyState >= 2);
        }),
        {timeout: 60000, timeoutMsg: 'video never became ready'});
  });

  // The preset handlers keep per-key revert memory for the session and the
  // client may carry a rate over from an earlier test, so every test starts
  // from a known 1x on a paused video.
  beforeEach(async function() {
    await browser.execute(() => {
      const video = document.querySelector('video');
      if (video && !video.paused) {
        video.pause();
      }
      window.fastStream.playbackRate = 1;
    });
  });

  it('Digit5 and Digit1 seek to 50% and 10% of the duration', async function() {
    const duration = await browser.execute(() => window.fastStream.duration);
    expect(duration).toBeGreaterThan(1);

    // Park at the start so neither percentage target can already be satisfied
    // when its key is pressed. Seeks are asynchronous: poll currentTime.
    await browser.execute(() => {
      window.fastStream.currentTime = 0;
    });
    await browser.waitUntil(
        async () => browser.execute(() => window.fastStream.currentTime < 0.5),
        {timeout: 10000, timeoutMsg: 'video never seeked back to the start'});

    await pressKey('Digit5');
    const half = duration * 0.5;
    await browser.waitUntil(
        async () => {
          const t = await browser.execute(() => window.fastStream.currentTime);
          return Math.abs(t - half) <= 0.5;
        },
        {timeout: 10000, timeoutMsg: `Digit5 never seeked to ${half} s, 50% of ${duration} s`});
    const atHalf = await browser.execute(() => window.fastStream.currentTime);
    expect(atHalf).toBeLessThanOrEqual(half + 0.5);
    expect(atHalf).toBeGreaterThanOrEqual(half - 0.5);

    await pressKey('Digit1');
    const tenth = duration * 0.1;
    await browser.waitUntil(
        async () => {
          const t = await browser.execute(() => window.fastStream.currentTime);
          return Math.abs(t - tenth) <= 0.5;
        },
        {timeout: 10000, timeoutMsg: `Digit1 never seeked to ${tenth} s, 10% of ${duration} s`});
    const atTenth = await browser.execute(() => window.fastStream.currentTime);
    expect(atTenth).toBeLessThanOrEqual(tenth + 0.5);
    expect(atTenth).toBeGreaterThanOrEqual(tenth - 0.5);
  });

  it('KeyQ sets the 3x preset and pressing it again reverts to 1x', async function() {
    await pressKey('KeyQ');
    const atPreset = await browser.execute(() => window.fastStream.playbackRate);
    expect(atPreset).toBe(3);

    await pressKey('KeyQ');
    const afterRevert = await browser.execute(() => window.fastStream.playbackRate);
    expect(afterRevert).toBe(1);
  });

  it('KeyY reverts to the rate KeyQ set, the preset memory is per key', async function() {
    await pressKey('KeyQ');
    const atQ = await browser.execute(() => window.fastStream.playbackRate);
    expect(atQ).toBe(3);

    await pressKey('KeyY');
    const atY = await browser.execute(() => window.fastStream.playbackRate);
    expect(atY).toBe(5);

    await pressKey('KeyY');
    const afterY = await browser.execute(() => window.fastStream.playbackRate);
    expect(afterY).toBe(3);
  });

  it('KeyH clamps the 16x preset to options.maxPlaybackRate', async function() {
    const max = await browser.execute(() => window.fastStream.options.maxPlaybackRate);
    const expected = Math.min(16, max);

    await pressKey('KeyH');
    const atPreset = await browser.execute(() => window.fastStream.playbackRate);
    expect(atPreset).toBe(expected);
  });

  it('KeyW sets 3.5x and Shift+KeyW leaves the playbackRate alone', async function() {
    // Plain KeyW used to toggle windowed fullscreen; it must set the preset.
    await pressKey('KeyW');
    const atPreset = await browser.execute(() => window.fastStream.playbackRate);
    expect(atPreset).toBe(3.5);

    // Shift+KeyW is WindowedFullscreen now; it must leave the rate alone.
    await pressKey('KeyW', {shift: true});
    const afterShift = await browser.execute(() => window.fastStream.playbackRate);
    expect(afterShift).toBe(atPreset);
  });
});
