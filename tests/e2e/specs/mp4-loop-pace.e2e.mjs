// How often an MP4 player wakes the page while there is nothing for it to do.
//
// MP4Player's main loop ran every 50 ms while paused - in each of its players: the seek preview
// is a second one, always paused - and every 1 ms (4 in Firefox) once the video had ended, its
// readyState below 3 with nothing ahead to load: about 40 and 250 timer rounds a second, for as
// long as the tab stayed open (tools/bench-ab.mjs, 2026-11-13). Paused or ended it runs every
// 250 ms now, and a seek or a play runs its next round at once: this spec counts the page's
// timer and frame callbacks, and checks that a seek and a play still answer at once.

import {browser, expect} from '@wdio/globals';

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
 *   readyState: number, duration: number}|null>}
 */
function videoState() {
  return browser.execute(() => {
    const video = /** @type {any} */ (window).fastStream?.player?.getVideo?.();
    if (!video) return null;
    return {time: video.currentTime, paused: video.paused, ended: video.ended, seeking: video.seeking,
      readyState: video.readyState, duration: video.duration};
  });
}

// Paused, the main player and the seek preview at 4 rounds a second and the client's own
// one-second loop make about 9; before, about 41. Ended, before: about 250.
const MAX_IDLE_WAKE_UPS = 20;

describe('An MP4 player with nothing to do', function() {
  /** @type {{remove: () => Promise<void>}|undefined} */
  let script;

  before(async function() {
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
    // A review (2026-11-13): the client sets the start right after setSource, before the
    // element has data; no seek runs then and no seeked ever came, and that mark made the
    // element's own seek to 0 at the replay look like the player's. The test above sought
    // before its end, which hid it.
    const source = globalThis.__E2E_FIXTURES_ORIGIN__ + `/fixtures/long-av.mp4?unsought=${Date.now()}`;
    await browser.url(`/player/index.html?t=${Date.now()}#${source}`);
    await browser.waitUntil(async () => ((await videoState())?.readyState ?? 0) >= 2,
        {timeout: 20000, interval: 100, timeoutMsg: 'the video did not load'});
    // Fast, to its end, without a seek.
    await browser.execute(() => {
      const client = /** @type {any} */ (window).fastStream;
      client.player.getVideo().playbackRate = 8;
      client.play();
    });
    await browser.waitUntil(async () => !!(await videoState())?.ended,
        {timeout: 60000, interval: 200, timeoutMsg: 'the video did not reach its end at 8x'});
    await browser.execute(() => {
      const client = /** @type {any} */ (window).fastStream;
      client.player.getVideo().playbackRate = 1;
      client.play().catch(() => {});
    });
    let state;
    await browser.waitUntil(async () => {
      state = await videoState();
      return !!state && !state.paused && !state.ended && state.time > 0.5 && state.time < 30;
    }, {timeout: 10000, interval: 100}).catch(() => {
      throw new Error(`play after an unsought end did not start it over: ${JSON.stringify(state)}`);
    });
  });

  it('wakes the page rarely for an audio-only MP4, whose seek preview has nothing to show', async function() {
    // A review (2026-11-13): the preview made no SourceBuffer for a file without a picture,
    // its element stayed at HAVE_NOTHING, and its loop ran every 4 ms for the tab's life.
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
