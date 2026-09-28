// FastStreamClient's setup of a source, and what it does once one plays.
//
// Each case opens the web player with no source, changes what it needs in the page, and
// then hands the player a source the way main.mjs does.

import {browser, expect} from '@wdio/globals';

const mp4Url = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/sample.mp4`;
// An HLS source: its setup goes through without its manifest, which then never loads. A
// missing MP4 fails inside setSource, so the part that seeks to its time never runs.
const missingUrl = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/missing/stream.m3u8`;

/**
 * Opens the player with no source, and with autoplay and remembered positions off, so
 * that nothing but the case itself moves the video.
 * @return {Promise<void>}
 */
async function openEmptyPlayer() {
  await browser.url(`/player/index.html?t=${Date.now()}`);
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream),
      {timeout: 30000, timeoutMsg: 'the player never started'});
  // setOptions() runs after the client exists (main.mjs loads its options from
  // storage) and would clobber the overrides below when it lands; main.mjs sets
  // optionsApplied when it has run. preload.mjs also sets a theme early, so the
  // page's dataset is not a reliable sign here.
  await browser.waitUntil(async () => browser.execute(() => !!(
    window.fastStream && window.fastStream.optionsApplied)),
      {timeout: 30000, timeoutMsg: 'the player options never loaded'});
  await browser.execute(() => {
    window.fastStream.options.autoPlay = false;
    window.fastStream.options.storeProgress = false;
  });
}

/**
 * Hands the player a source, as main.mjs does for a URL in the page's hash.
 * @param {string} url - The source.
 * @return {Promise<void>}
 */
async function addSource(url) {
  const error = await browser.executeAsync((url, done) => {
    Promise.all([import('/player/VideoSource.mjs'), import('/player/utils/URLUtils.mjs')])
        .then(([{VideoSource}, {URLUtils}]) => {
          window.fastStream.addSource(new VideoSource(url, {}, URLUtils.getModeFromURL(url)), true);
          done(null);
        }).catch((e) => done(String(e)));
  }, url);
  expect(error).toBe(null);
}

/**
 * Waits until the video the player shows has a frame to show.
 * @return {Promise<void>}
 */
async function waitForPicture() {
  await browser.waitUntil(async () => browser.execute(() => {
    const client = window.fastStream;
    return !!client.player && client.duration > 0 && client.currentVideo?.readyState >= 2;
  }), {timeout: 30000, timeoutMsg: 'the video never loaded'});
}

describe('FastStreamClient setup', function() {
  it('finishes setting up a video whose seek preview fails to build', async function() {
    // The rest of the setup came after the preview's, so a preview that failed took the
    // time in the URL, the video analyzer and autoplay with it, and showed an error.
    await openEmptyPlayer();
    await browser.execute(() => {
      const loader = window.fastStream.playerLoader;
      const createPlayer = loader.createPlayer.bind(loader);
      loader.createPlayer = (mode, client, options) => options?.isPreview ?
        Promise.reject(new Error('no preview here')) : createPlayer(mode, client, options);
    });
    await addSource(`${mp4Url()}?faststream-timestamp=4`);
    await waitForPicture();

    let state;
    await browser.waitUntil(async () => {
      state = await browser.execute(() => ({
        currentTime: window.fastStream.currentTime,
        failed: !!window.fastStream.interfaceController.failed,
        alert: !!document.querySelector('.swal2-popup'),
      }));
      return state.currentTime >= 3.9;
    }, {timeout: 10000, interval: 250}).catch(() => {});
    console.log('      state:', JSON.stringify(state));

    expect(state.currentTime).toBeGreaterThanOrEqual(3.9);
    expect(state.alert).toBe(false);
    expect(state.failed).toBe(false);
  });

  it('does not seek a video to the time of the source before it', async function() {
    // The first source never gets a picture. Its wait for one used to outlive it and to
    // end when the next source had one, which was then sought to the first one's time.
    await openEmptyPlayer();
    await addSource(`${missingUrl()}?faststream-timestamp=8`);
    await browser.pause(1500);
    await addSource(mp4Url());
    await waitForPicture();
    // The wait checks once a second.
    await browser.pause(2500);

    const currentTime = await browser.execute(() => window.fastStream.currentTime);
    console.log('      currentTime:', currentTime);
    expect(currentTime).toBeLessThan(1);
  });

  it('moves a separate audio track along with an undone or redone seek', async function() {
    // Undo and redo set the video's time without the client's setter, which is what moves
    // the synced audio player too; it caught up only on its next check.
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();

    const moves = await browser.execute(() => {
      const client = window.fastStream;
      const audio = [];
      const setCurrentTime = client.syncedAudioPlayer.setCurrentTime.bind(client.syncedAudioPlayer);
      client.syncedAudioPlayer.setCurrentTime = (time) => {
        audio.push(time);
        setCurrentTime(time);
      };
      client.currentTime = 5;
      client.undoSeek();
      const afterUndo = {audio: audio.slice(), state: client.state.currentTime};
      client.redoSeek();
      return {afterUndo, afterRedo: {audio, state: client.state.currentTime}};
    });
    console.log('      moves:', JSON.stringify(moves));

    expect(moves.afterUndo.audio).toEqual([5, 0]);
    expect(moves.afterUndo.state).toBe(0);
    expect(moves.afterRedo.audio).toEqual([5, 0, 5]);
    expect(moves.afterRedo.state).toBe(5);
  });
});
