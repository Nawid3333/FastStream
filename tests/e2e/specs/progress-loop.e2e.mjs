// The progress loop of a short video (InterfaceController.progressLoop): it moved the bar at
// the screen's every frame, up to 144 times a second for a video of 24 to 60. It waits for the
// video's next frame now (requestVideoFrameCallback), and goes on after a pause, which such a
// wait never sees end: play() asks for it again.

import {browser, expect} from '@wdio/globals';

const FIXTURE = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/frames-24fps.mp4`;

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
 * How often the client was told the time during a second of playback.
 * @return {Promise<number>}
 */
async function updatesInASecond() {
  await browser.execute(() => {
    const client = window.fastStream;
    if (!client.__zzCount) {
      const update = client.updateTime.bind(client);
      client.__zzCount = {n: 0};
      client.updateTime = (time) => {
        client.__zzCount.n++;
        return update(time);
      };
    }
    client.__zzCount.n = 0;
  });
  await browser.pause(1000);
  return browser.execute(() => window.fastStream.__zzCount.n);
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
    }), FIXTURE());
    expect(error).toBe(null);
    await browser.waitUntil(async () => browser.execute(() => {
      const client = window.fastStream;
      return !!client.player && client.duration > 0 && client.currentVideo?.readyState >= 2;
    }), {timeout: 30000, timeoutMsg: 'the video never loaded'});

    const play = () => browser.execute(() => {
      window.fastStream.currentVideo.muted = true;
      return window.fastStream.play();
    });
    await play();
    const playing = await updatesInASecond();
    console.log(`      updates in a second of playback: ${playing}`);
    // A 24 fps video: about 24 rounds, not the screen's 60 (or more).
    expect(playing).toBeGreaterThan(10);
    expect(playing).toBeLessThan(40);

    await browser.execute(() => window.fastStream.pause());
    await browser.pause(300);
    await play();
    const again = await updatesInASecond();
    console.log(`      updates in a second after a pause: ${again}`);
    expect(again).toBeGreaterThan(10);
  });
});
