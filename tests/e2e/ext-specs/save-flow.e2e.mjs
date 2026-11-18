// End-to-end save as the user does it: the player in a site's partitioned iframe, an
// accelerated-MP4 source, Save, the prompt, a full save.
//
// Each wait ends within 75 s, inside mocha's 120 s cap (testTimeout.mjs), so a hang fails with the
// page's state.

import {browser, expect} from '@wdio/globals';

import {confirmPrompt} from '../confirmPrompt.mjs';
import {addSourceInPlayer} from '../extension-page.mjs';

/**
 * Opens the harness /embed page (ordinary http page with the player in a
 * cross-origin iframe) pointed at the given media URL, and switches the
 * driver into the frame.
 * @param {string} mediaUrl the media the player should load
 * @return {Promise<void>}
 */
async function openEmbeddedPlayer(mediaUrl) {
  await browser.url(globalThis.__EXT_OPENER_URL__ + 'embed?t=' + Date.now() +
      '#embed-target');

  await browser.waitUntil(
      async () => browser.execute(() => {
        const f = document.querySelector('iframe#fs');
        return !!f && f.src.startsWith('moz-extension://');
      }),
      {timeout: 15000, timeoutMsg: 'embed page never got its player iframe'});

  await browser.switchFrame(await browser.$('iframe#fs'));
  await browser.waitUntil(
      async () => browser.execute(() => document.readyState === 'complete'),
      {timeout: 30000, timeoutMsg: 'player iframe never finished loading'});

  // An embedded player holds predownloading until the user interacts (needsUserInteraction): a
  // trusted click here.
  await browser.waitUntil(
      async () => browser.execute(() => !!window.fastStream),
      {timeout: 30000, timeoutMsg: 'window.fastStream never appeared'});
  // Not through the iframe's #hash: a player inside a page ignores it.
  await addSourceInPlayer(mediaUrl);
  await browser.execute(() => {
    window.fastStream.userInteracted();
    document.body.click();
  });

  // Wait for the player to create its <video> and reach playable data,
  // diagnosing rather than blind-waiting so a stall says WHERE it stalled.
  let lastState = null;
  try {
    await browser.waitUntil(
        async () => {
          const state = await browser.execute(() => ({
            addSourceError: window.__addSourceError ?? null,
            sourceUrl: window.fastStream?.source?.url ??
                       window.fastStream?.player?.source?.url ?? null,
            playerType: window.fastStream?.player?.constructor?.name ?? null,
            hasVideo: !!document.querySelector('video'),
            readyState: document.querySelector('video')?.readyState ?? -1,
            hasPlayer: !!window.fastStream?.player,
            needsInteraction: window.fastStream?.needsUserInteraction() ?? null,
            currentTime: window.fastStream?.currentTime ?? null,
            storageSize: window.fastStream?.downloadManager?.getStorageByteCount() ?? -1,
          }));
          if (state.hasVideo && state.readyState >= 2) return true;
          lastState = state;
          return false;
        },
        {timeout: 60000, interval: 1000, timeoutMsg: 'video never reached HAVE_CURRENT_DATA'});
  } catch (e) {
    // Deeper diagnosis: can THIS frame fetch the fixture at all, with and
    // without the Range header the accelerated players use?
    const fixtureUrl = globalThis.__EXT_FIXTURE_MP4__;
    const fetchDiag = await browser.execute(async (u) => {
      const tryFetch = async (headers) => {
        try {
          const r = await fetch(u, {headers});
          return {ok: r.ok, status: r.status};
        } catch (e) {
          return {error: String(e)};
        }
      };
      return {
        plain: await tryFetch({}),
        ranged: await tryFetch({Range: 'bytes=0-99'}),
      };
    }, fixtureUrl);
    console.log('      embedded player stalled with state:', JSON.stringify(lastState));
    console.log('      fetch diagnostics:', JSON.stringify(fetchDiag));
    throw e;
  }
}

describe('faithful save flow (UI + embedded iframe)', function() {
  // lazily: the config's before() sets the opener URL after describe bodies run
  const mp4 = () => globalThis.__EXT_FIXTURE_MP4__;

  it('saves an accelerated MP4 through the real UI in the embedded iframe', async function() {
    await openEmbeddedPlayer(mp4());

    await browser.execute(() => document.querySelector('video').play().catch(() => {}));
    // Let a few fragments land behind the playhead, like the web suite does.
    await new Promise((r) => setTimeout(r, 6000));

    // Click the real Save button.
    await browser.waitUntil(
        async () => browser.execute(() => !!document.querySelector('#download, .main_download')),
        {timeout: 15000, timeoutMsg: 'save button never appeared'});
    await browser.execute(() => {
      const btn = document.querySelector('.main_download') || document.querySelector('#download');
      btn.click();
    });

    // The filename prompt appears (SaveManager asks before saving).
    await browser.waitUntil(
        async () => browser.execute(() => !!document.querySelector('.fs-dialog .fs-dialog-input')),
        {timeout: 15000, timeoutMsg: 'filename prompt never appeared'});
    // OK once the player's document has its size, as a user can click it.
    await confirmPrompt(null);

    // Polled once a second: one executeAsync waiting in the page ran into WebDriver's 30 s script
    // timeout.
    const started = performance.now();
    let outcome;
    for (;;) {
      const page = await browser.execute(() => {
        const banner = document.querySelector('#save_notif_banner');
        return {
          bannerVisible: !!banner && banner.style.display !== 'none',
          status: document.querySelector('.status_text')?.textContent ?? null,
        };
      });
      const elapsedMs = performance.now() - started;
      if (!page.bannerVisible && elapsedMs > 3000) {
        outcome = {settled: true, elapsedMs, status: page.status};
        break;
      }
      if (elapsedMs > 75000) {
        outcome = {settled: false, timedOut: true, elapsedMs, ...page};
        break;
      }
      await browser.pause(1000);
    }

    console.log('      mp4 UI save outcome:', JSON.stringify(outcome));
    expect(outcome.settled).toBe(true);
  });
});

// long-av.mp4 needs many ranges, and a seek 100 s in starts far past the first: a range answered
// with the file's start shows.
describe('an accelerated MP4 of many ranges (embedded iframe)', function() {
  it('plays on after a seek far past its first range', async function() {
    // The test before ends inside the player's frame, and browser.url() navigates the frame
    // the driver is in.
    await browser.switchFrame(null);
    await openEmbeddedPlayer(globalThis.__EXT_OPENER_URL__ + 'fixtures/long-av.mp4');
    expect(await browser.execute(() => window.fastStream.player?.constructor?.name)).toBe('MP4Player');

    await browser.execute(() => {
      window.fastStream.currentTime = 100;
    });
    let state = {};
    await browser.waitUntil(async () => {
      state = await browser.execute(() => {
        const video = window.fastStream?.currentVideo;
        if (!video) return {};
        if (video.paused) video.play().catch(() => {});
        return {currentTime: video.currentTime, readyState: video.readyState,
          error: video.error?.message || null, failed: !!window.fastStream.interfaceController?.failed};
      });
      return (state.currentTime > 101 && state.readyState >= 2) || state.failed || !!state.error;
    }, {timeout: 45000, interval: 500}).catch(() => {});
    console.log('      after the seek to 100 s:', JSON.stringify(state));
    expect(state.error).toBe(null);
    expect(state.failed).toBe(false);
    expect(state.currentTime).toBeGreaterThan(101);
  });
});
