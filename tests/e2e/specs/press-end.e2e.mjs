// A press in the player ends however it ends (PressTracker): with the window switched while
// the button is held, the mouseup goes to the other window.
//
// Measured on 2026-10-28 before the fix: the video held (twice the speed) and the window
// switched, the player heard blur and visibilitychange but stayed at twice the speed until
// the next click. A tool held for its long press started the reordering after it was let go
// elsewhere, and a drag on the progress bar went on until a move with no button held.
//
// The window switch is WebDriver's own: a new tab, the button let go in it, the tab closed.
// WebdriverIO lets every held button go at the end of an action (perform()); perform(true)
// keeps it held, and releaseActions() lets it go, where the test is then.
import {browser, expect} from '@wdio/globals';

const videoUrl = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/long-av.mp4`;

/**
 * Opens the player on the 160 s fixture, autoplay and remembered positions off, and waits
 * for its picture.
 * @return {Promise<void>}
 */
async function openPlayer() {
  await browser.url(`/player/index.html?t=${Date.now()}`);
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.optionsApplied),
      {timeout: 30000, timeoutMsg: 'the player never started'});
  const error = await browser.execute((url) => new Promise((done) => {
    window.fastStream.options.autoPlay = false;
    window.fastStream.options.storeProgress = false;
    Promise.all([import('/player/VideoSource.mjs'), import('/player/utils/URLUtils.mjs')])
        .then(([{VideoSource}, {URLUtils}]) => {
          window.fastStream.addSource(new VideoSource(url, {}, URLUtils.getModeFromURL(url)), true);
          done(null);
        }).catch((e) => done(String(e)));
  }), videoUrl());
  expect(error).toBe(null);
  await browser.waitUntil(async () => browser.execute(() =>
    !!window.fastStream.player && window.fastStream.duration > 0 && window.fastStream.currentVideo?.readyState >= 2),
  {timeout: 30000, timeoutMsg: 'the video never loaded'});
}

/** The player's state that the presses change. */
const state = () => browser.execute(() => {
  const client = window.fastStream;
  return {
    rate: client.player.getVideo().playbackRate,
    paused: client.player.getVideo().paused,
    time: client.currentTime,
    seeking: client.interfaceController.progressBar.isSeeking,
    reordering: client.interfaceController.toolManager.specialReorderModeEnabled,
  };
});

/**
 * Switches to a new tab with the button still held, lets it go there, and comes back.
 * @return {Promise<void>}
 */
async function letGoInAnotherWindow() {
  const main = await browser.getWindowHandle();
  const other = await browser.createWindow('tab');
  await browser.switchToWindow(other.handle);
  await browser.pause(300);
  // The held button, let go there (a new pointer action would hold none).
  await browser.releaseActions();
  await browser.closeWindow();
  await browser.switchToWindow(main);
  await browser.pause(300);
}

describe('A press in the player', function() {
  beforeEach(openPlayer);

  it('holding the video plays it at twice the speed, and the window switched ends it', async function() {
    await browser.execute(() => window.fastStream.play());
    await browser.waitUntil(async () => !(await state()).paused, {timeout: 10000, timeoutMsg: 'the video never played'});
    const container = await browser.$('.mainplayer .video-container');
    await browser.action('pointer').move({origin: container}).down().pause(1300).perform(true);
    expect((await state()).rate).toBe(2);
    await letGoInAnotherWindow();
    // Back at once, before any click; still playing, as before the hold.
    const after = await state();
    console.log('      after the window switch:', JSON.stringify(after));
    expect(after.rate).toBe(1);
    expect(after.paused).toBe(false);
  });

  it('holding the video and letting go on it neither plays nor pauses it', async function() {
    await browser.execute(() => window.fastStream.play());
    await browser.waitUntil(async () => !(await state()).paused, {timeout: 10000, timeoutMsg: 'the video never played'});
    const container = await browser.$('.mainplayer .video-container');
    await browser.action('pointer').move({origin: container}).down().pause(1300).perform(true);
    expect((await state()).rate).toBe(2);
    await browser.releaseActions();
    await browser.pause(600);
    const after = await state();
    expect(after.rate).toBe(1);
    expect(after.paused).toBe(false);
  });

  it('a tool let go in another window before its long press starts no reordering', async function() {
    const tool = await browser.$('.mainplayer .fluid_button_settings');
    await browser.action('pointer').move({origin: tool}).down().pause(300).perform(true);
    await letGoInAnotherWindow();
    // Past the 800 ms the long press takes.
    await browser.pause(1200);
    expect((await state()).reordering).toBe(false);
  });

  it('a drag on the progress bar ends where it was when the window is switched', async function() {
    const bar = await browser.$('.mainplayer .fluid_controls_progress_container');
    const {width} = await bar.getSize();
    await browser.action('pointer').move({origin: bar, x: Math.round(-width * 0.3), y: 0}).down()
        .move({origin: bar, x: 0, y: 0, duration: 200}).perform(true);
    expect((await state()).seeking).toBe(true);
    await letGoInAnotherWindow();
    const after = await state();
    expect(after.seeking).toBe(false);
    // A move over the bar with no button held seeks no more.
    await browser.action('pointer').move({origin: bar, x: Math.round(width * 0.35), y: 0, duration: 200}).perform();
    await browser.pause(300);
    expect(Math.abs((await state()).time - after.time)).toBeLessThan(1);
  });
});
