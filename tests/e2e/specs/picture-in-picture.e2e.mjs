// Picture-in-picture from the player tab: Firefox's Document Picture-in-Picture (151+) takes the
// player's elements into the PiP window, the playing video with them, and gives them back when
// it closes. The video plays on through both moves, from where it was.
import {browser, expect} from '@wdio/globals';

const mp4Url = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/sample.mp4`;

/** @return {Promise<{time: number, paused: boolean, inPip: boolean, moved: boolean, api: string}>} */
const state = () => browser.execute(() => {
  const client = window.fastStream;
  const video = client.currentVideo;
  return {time: video.currentTime, paused: video.paused, inPip: client.interfaceController.isInPip(),
    moved: video.ownerDocument !== document,
    api: (window.documentPictureInPicture ? 'document ' : '') + typeof video.requestPictureInPicture};
});

describe('picture-in-picture', () => {
  it('plays on from where it was, into the PiP window and back', async function() {
    await browser.url(`/player/index.html?t=${Date.now()}`);
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.optionsApplied),
        {timeout: 30000, timeoutMsg: 'the player never started'});
    const error = await browser.execute((url) => new Promise((done) => {
      window.fastStream.options.storeProgress = false;
      Promise.all([import('/player/VideoSource.mjs'), import('/player/utils/URLUtils.mjs')])
          .then(([{VideoSource}, {URLUtils}]) => {
            window.fastStream.addSource(new VideoSource(url, {}, URLUtils.getModeFromURL(url)), true);
            done(null);
          }).catch((e) => done(String(e)));
    }), mp4Url());
    expect(error).toBe(null);
    await browser.waitUntil(async () => browser.execute(() => window.fastStream.currentVideo?.readyState >= 2),
        {timeout: 30000, timeoutMsg: 'the video never loaded'});
    await browser.execute(() => {
      window.fastStream.currentVideo.muted = true;
      window.fastStream.play();
    });
    await browser.waitUntil(async () => (await state()).time > 1, {timeout: 30000, timeoutMsg: 'the video never played'});

    const before = await state();
    console.log('PiP API here:', before.api);
    // A key press: the PiP window needs the user's activation, which a script has none of.
    await browser.keys('p');
    await browser.waitUntil(async () => (await state()).inPip, {timeout: 10000, timeoutMsg: 'no PiP window opened'});
    await browser.pause(1500);
    const inPip = await state();
    console.log('In PiP:', JSON.stringify(inPip));
    expect(inPip.paused).toBe(false);
    expect(inPip.time).toBeGreaterThan(before.time);

    await browser.execute(() => window.fastStream.interfaceController.pipToggle(false));
    await browser.waitUntil(async () => !(await state()).inPip, {timeout: 10000, timeoutMsg: 'the PiP window never closed'});
    await browser.pause(1500);
    const back = await state();
    console.log('Back:', JSON.stringify(back));
    expect(back.moved).toBe(false);
    expect(back.paused).toBe(false);
    expect(back.time).toBeGreaterThan(inPip.time);
  });
});
