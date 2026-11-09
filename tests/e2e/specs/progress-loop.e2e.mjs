// The progress loop of a short video (InterfaceController.progressLoop): it moved the bar at
// the screen's every frame, up to 144 times a second for a video of 24 to 60. It waits for the
// video's next frame now (requestVideoFrameCallback), and goes on after a pause, which such a
// wait never sees end: play() asks for it again.
//
// Counted against the frames the video really presented, not against a second of the clock:
// some Linux CI runners present only 1 to 5 frames in the first second, where others show 23
// to 28 and Windows 28, and a count per second failed there twice in a row (#641, #644).

import {browser, expect} from '@wdio/globals';

const fixtureUrl = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/frames-24fps.mp4`;

/** How many frames each measurement waits for. At 24 fps, half a second of playback. */
const FRAMES = 12;

/**
 * Opens the player with no source, autoplay and remembered positions off.
 * @return {Promise<void>}
 */
async function openEmptyPlayer() {
  await browser.url(`/player/index.html?t=${Date.now()}`);
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.optionsApplied),
      {timeout: 30000, timeoutMsg: 'the player never started'});
  await browser.execute(() => {
    window.fastStream.options.autoPlay = false;
    window.fastStream.options.storeProgress = false;
  });
}

/**
 * The progress loop's rounds while the video presents the next FRAMES frames.
 * @return {Promise<{rounds: number, frames: number, ms: number}>}
 */
async function roundsOverFrames() {
  await browser.execute(() => {
    const client = window.fastStream;
    if (!window.__zzCount) {
      window.__zzCount = {rounds: 0, frames: 0, start: 0};
      const controller = client.interfaceController;
      const schedule = controller.scheduleProgressFrame.bind(controller);
      controller.scheduleProgressFrame = () => {
        window.__zzCount.rounds++;
        schedule();
      };
      const video = client.currentVideo;
      const onFrame = () => {
        window.__zzCount.frames++;
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    }
    Object.assign(window.__zzCount, {rounds: 0, frames: 0, start: performance.now()});
  });
  await browser.waitUntil(async () => (await browser.execute(() => window.__zzCount.frames)) >= FRAMES,
      {timeout: 30000, interval: 50, timeoutMsg: `the video did not present ${FRAMES} frames in 30 s`});
  return browser.execute(() => {
    const {rounds, frames, start} = window.__zzCount;
    return {rounds, frames, ms: Math.round(performance.now() - start)};
  });
}

describe('The progress loop of a short video', function() {
  it('runs at the video\'s frames, and goes on after a pause', async function() {
    await openEmptyPlayer();
    const error = await browser.execute((url) => new Promise((done) => {
      Promise.all([import('/player/VideoSource.mjs'), import('/player/utils/URLUtils.mjs')])
          .then(([{VideoSource}, {URLUtils}]) => {
            window.fastStream.addSource(new VideoSource(url, {}, URLUtils.getModeFromURL(url)), true);
            done(null);
          }).catch((e) => done(String(e)));
    }), fixtureUrl());
    expect(error).toBe(null);
    await browser.waitUntil(async () => browser.execute(() => {
      const client = window.fastStream;
      return !!client.player && client.duration > 0 && client.currentVideo?.readyState >= 2;
    }), {timeout: 30000, timeoutMsg: 'the video never loaded'});

    const play = () => browser.execute(() => {
      const video = window.fastStream.currentVideo;
      video.muted = true;
      // The fixture lasts 4 s: a runner that presents a frame a second must not reach its end.
      video.loop = true;
      return window.fastStream.play();
    });
    await play();
    const playing = await roundsOverFrames();
    console.log(`      playing: ${JSON.stringify(playing)}`);
    // One round a frame. At the screen's 60 a second it would be 2.5 rounds for this 24 fps video.
    expect(playing.rounds).toBeGreaterThanOrEqual(playing.frames - 2);
    expect(playing.rounds).toBeLessThanOrEqual(playing.frames * 1.5);

    await browser.execute(() => window.fastStream.pause());
    await browser.pause(300);
    await play();
    const again = await roundsOverFrames();
    console.log(`      after a pause: ${JSON.stringify(again)}`);
    expect(again.rounds).toBeGreaterThanOrEqual(again.frames - 2);
  });
});
