// Faithful end-to-end save reproduction on the installed extension.
//
// Every layer probed so far works in isolation: streamSaver's blob fallback,
// the background DOWNLOAD handler, and blob downloads from inside the
// partitioned player iframe (Firefox 155 fixed bugzilla 1917842). The web
// suite proves the muxer paths with a fake WritableStream. What none of that
// covers is the flow the user actually does: player embedded in a site's
// page (partitioned iframe), a real accelerated-MP4 source, clicking the
// real Save button, the real filename prompt, and the full (non-partial)
// save path - which is the only one the Save button ever uses.
//
// This spec drives exactly that: embed -> wait for playable video -> click
// #download -> accept the prompt -> wait for the save to settle, for at most
// 75 s: inside mocha's 120 s cap on the test (testTimeout.mjs; a test's own
// this.timeout() does not lift it under WebdriverIO), so a hang fails with the
// page's state in the log instead of a bare timeout.

import {browser, expect} from '@wdio/globals';

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

  // An embedded player (window.self !== window.top) holds fragment
  // predownloading until the user interacts with it (needsUserInteraction).
  // On a real site that interaction is a click on the player; here the
  // driver provides one via a trusted click on the player surface.
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
  // Lazily: the config's before() hook sets the opener URL global, and a
  // describe body runs BEFORE that hook - evaluating it here produced
  // 'undefinedfixtures/sample.mp4' (a garbage URL) in every earlier run.
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
        async () => browser.execute(() => !!document.querySelector('.swal2-container .swal2-input')),
        {timeout: 15000, timeoutMsg: 'filename prompt never appeared'});
    await browser.execute(() => {
      const confirm = document.querySelector('.swal2-confirm');
      confirm.click();
    });

    // Now the save runs. SaveManager hides the banner when the save settles
    // (success or failure) and sets a status message either way. Polled from
    // here, once a second: a single executeAsync that waited in the page ran
    // into WebDriver's 30 s script timeout, and its own 120 s budget into
    // mocha's cap, so neither outcome below was ever logged.
    const started = Date.now();
    let outcome;
    for (;;) {
      const page = await browser.execute(() => {
        const banner = document.querySelector('#save_notif_banner');
        return {
          bannerVisible: !!banner && banner.style.display !== 'none',
          status: document.querySelector('.status_text')?.textContent ?? null,
        };
      });
      const elapsedMs = Date.now() - started;
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

// The harness served every fixture whole, with 200, whatever range was asked for (#257).
// sample.mp4 fits MP4Player's first 1 MB range, so the save above never asks for a second
// one: a range answered with the file's start would have gone unseen. long-av.mp4 (17 MB,
// 160 s) needs many, and a seek 100 s in starts far past the first.
describe('an accelerated MP4 of many ranges (embedded iframe)', function() {
  it('plays on after a seek far past its first range', async function() {
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
