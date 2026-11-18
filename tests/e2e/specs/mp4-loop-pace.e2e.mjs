// How often an MP4 player wakes the page while there is nothing for it to do.
//
// MP4Player's loop runs every 250 ms while paused or ended (each player, the seek preview too), and
// a seek or play runs at once.

import {browser, expect} from '@wdio/globals';

import {ensureLongAudioOnly} from '../mp4Shapes.mjs';

/**
 * Counts every timer, interval, animation-frame and idle callback the page runs while
 * window.__wake.counting is set. Runs before the page's own scripts (addInitScript).
 */
function countWakeUps() {
  const wake = /** @type {any} */ (window).__wake = {counting: false, count: 0};
  /**
   * @param {Function} schedule
   * @return {Function}
   */
  const counted = (schedule) => (callback, ...rest) => {
    if (typeof callback !== 'function') return schedule(callback, ...rest);
    return schedule((...args) => {
      if (wake.counting) wake.count++;
      return callback(...args);
    }, ...rest);
  };
  window.setTimeout = /** @type {any} */ (counted(window.setTimeout.bind(window)));
  window.setInterval = /** @type {any} */ (counted(window.setInterval.bind(window)));
  window.requestAnimationFrame = /** @type {any} */ (counted(window.requestAnimationFrame.bind(window)));
  if (window.requestIdleCallback) {
    window.requestIdleCallback = /** @type {any} */ (counted(window.requestIdleCallback.bind(window)));
  }
}

/**
 * Callbacks a second the page runs over the next `ms`.
 * @param {number} ms
 * @return {Promise<number>}
 */
async function wakeUpsPerSecond(ms) {
  await browser.execute(() => {
    const wake = /** @type {any} */ (window).__wake;
    wake.count = 0;
    wake.since = performance.now();
    wake.counting = true;
  });
  await browser.pause(ms);
  return browser.execute(() => {
    const wake = /** @type {any} */ (window).__wake;
    wake.counting = false;
    return wake.count / ((performance.now() - wake.since) / 1000);
  });
}

/**
 * The player's video state.
 * @return {Promise<{time: number, paused: boolean, ended: boolean, seeking: boolean,
 *   readyState: number, duration: number, rate: number}|null>}
 */
function videoState() {
  return browser.execute(() => {
    const video = /** @type {any} */ (window).fastStream?.player?.getVideo?.();
    if (!video) return null;
    return {time: video.currentTime, paused: video.paused, ended: video.ended, seeking: video.seeking,
      readyState: video.readyState, duration: video.duration, rate: video.playbackRate};
  });
}

// paused: about 9 rounds a second in all
const MAX_IDLE_WAKE_UPS = 20;

describe('An MP4 player with nothing to do', function() {
  /** @type {{remove: () => Promise<void>}|undefined} */
  let script;

  before(async function() {
    // The audio-only test's file: written here, not by the spec that writes it too
    // (mp4-loading.e2e.mjs), which a fresh checkout or a CI shard may not have run first.
    ensureLongAudioOnly();
    script = await browser.addInitScript(countWakeUps);
  });

  after(async function() {
    await script?.remove();
    await browser.url('about:blank');
  });

  it('wakes the page rarely while paused and once ended, and still answers a seek and a play', async function() {
    const source = globalThis.__E2E_FIXTURES_ORIGIN__ + `/fixtures/long-av.mp4?pace=${Date.now()}`;
    await browser.url(`/player/index.html?t=${Date.now()}#${source}`);
    await browser.waitUntil(async () => ((await videoState())?.readyState ?? 0) >= 2,
        {timeout: 20000, interval: 100, timeoutMsg: 'the video did not load'});
    await browser.execute(() => /** @type {any} */ (window).fastStream.play());
    await browser.waitUntil(async () => ((await videoState())?.time ?? 0) > 1,
        {timeout: 20000, interval: 100, timeoutMsg: 'the video did not play'});

    // Paused.
    await browser.execute(() => /** @type {any} */ (window).fastStream.pause());
    await browser.pause(1000);
    const paused = await wakeUpsPerSecond(3000);
    console.log(`      paused: ${paused.toFixed(1)} wake-ups a second`);
    expect(paused).toBeLessThan(MAX_IDLE_WAKE_UPS);

    // A seek while paused still loads and lands at once: the loop is woken, not waited for.
    const seekStart = Date.now();
    await browser.execute(() => {
      /** @type {any} */ (window).fastStream.currentTime = 100;
    });
    await browser.waitUntil(async () => {
      const state = await videoState();
      return !!state && !state.seeking && state.readyState >= 2 && Math.abs(state.time - 100) < 0.5;
    }, {timeout: 10000, interval: 50, timeoutMsg: 'the seek while paused did not land'});
    console.log(`      seek while paused landed after ${Date.now() - seekStart} ms`);

    // Played to its end.
    await browser.execute(() => {
      const client = /** @type {any} */ (window).fastStream;
      client.currentTime = client.duration - 1.5;
      client.play();
    });
    await browser.waitUntil(async () => !!(await videoState())?.ended,
        {timeout: 20000, interval: 100, timeoutMsg: 'the video did not reach its end'});
    await browser.pause(1000);
    const ended = await wakeUpsPerSecond(3000);
    console.log(`      ended: ${ended.toFixed(1)} wake-ups a second`);
    expect(ended).toBeLessThan(MAX_IDLE_WAKE_UPS);

    // Played again from the end: it starts over at once.
    await browser.execute(() => {
      /** @type {any} */ (window).fastStream.play().catch(() => {});
    });
    let state;
    await browser.waitUntil(async () => {
      state = await videoState();
      return !!state && !state.paused && !state.ended && state.time > 0.5 && state.time < 30;
    }, {timeout: 10000, interval: 100}).catch(() => {
      throw new Error(`play after the end did not start it over: ${JSON.stringify(state)}`);
    });
  });

  it('plays again after its end when it was never sought', async function() {
    // The client's start mark before the element has data is no seek: the replay's own seek to 0 is
    // the element's.
    const source = globalThis.__E2E_FIXTURES_ORIGIN__ + `/fixtures/long-av.mp4?unsought=${Date.now()}`;
    await browser.url(`/player/index.html?t=${Date.now()}#${source}`);
    await browser.waitUntil(async () => ((await videoState())?.readyState ?? 0) >= 2,
        {timeout: 20000, interval: 100, timeoutMsg: 'the video did not load'});
    // Through the client: a rate set on the element alone goes back to 1x at the next canplay.
    await browser.execute(() => {
      const client = /** @type {any} */ (window).fastStream;
      client.setPlaybackRate(8);
      client.play();
    });
    let state;
    await browser.waitUntil(async () => {
      state = await videoState();
      return !!state?.ended;
    }, {timeout: 60000, interval: 200}).catch(() => {
      throw new Error(`the video did not reach its end at 8x: ${JSON.stringify(state)}`);
    });
    await browser.execute(() => {
      const client = /** @type {any} */ (window).fastStream;
      client.setPlaybackRate(1);
      client.play().catch(() => {});
    });
    await browser.waitUntil(async () => {
      state = await videoState();
      return !!state && !state.paused && !state.ended && state.time > 0.5 && state.time < 30;
    }, {timeout: 10000, interval: 100}).catch(() => {
      throw new Error(`play after an unsought end did not start it over: ${JSON.stringify(state)}`);
    });
  });

  it('wakes the page rarely for an audio-only MP4, whose seek preview has nothing to show', async function() {
    // A file without a picture: the preview's loop does not run every 4 ms.
    const source = globalThis.__E2E_FIXTURES_ORIGIN__ + `/fixtures/mp4-shapes/long-audio-only.mp4?pace=${Date.now()}`;
    await browser.url(`/player/index.html?t=${Date.now()}#${source}`);
    await browser.waitUntil(async () => ((await videoState())?.readyState ?? 0) >= 2,
        {timeout: 20000, interval: 100, timeoutMsg: 'the audio did not load'});
    await browser.pause(1500);
    const paused = await wakeUpsPerSecond(3000);
    console.log(`      audio only, paused: ${paused.toFixed(1)} wake-ups a second`);
    expect(paused).toBeLessThan(MAX_IDLE_WAKE_UPS);
  });
});
