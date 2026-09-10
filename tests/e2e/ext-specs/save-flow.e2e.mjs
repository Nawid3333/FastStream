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
// #download -> accept the prompt -> wait for the save to settle, raced
// against a generous timeout so a hang becomes a result instead of a
// suite-wide stall.

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID} from '../wdio.extension.conf.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

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

  // Point the player at the source by rewriting the iframe src's hash.
  // main.mjs reads location.hash substring(1) RAW - no decodeURIComponent -
  // so the URL must go in unencoded (same as the web suite's openPlayer).
  await browser.execute((origin, url) => {
    const f = document.querySelector('iframe#fs');
    f.src = origin + '/player/index.html?t=' + Date.now() + '#' + url;
  }, ORIGIN, mediaUrl);

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
            hash: location.hash,
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
    // eslint-disable-next-line no-invalid-this
    this.timeout(180000);
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

    // Now the save runs. Race it: watch for either the completion status or
    // the banner disappearing, with progress polling as a liveness signal.
    const outcome = await browser.executeAsync((done) => {
      const started = performance.now();
      const banner = document.querySelector('#save_notif_banner');
      const poll = setInterval(() => {
        const elapsed = performance.now() - started;
        const bannerVisible = banner && banner.style.display !== 'none';
        // SaveManager hides the banner when the save settles (success or
        // failure) and sets a status message either way.
        if (!bannerVisible && elapsed > 3000) {
          clearInterval(poll);
          done({settled: true, elapsedMs: elapsed,
            status: document.querySelector('.status_text')?.textContent ?? null});
        }
        if (elapsed > 120000) {
          clearInterval(poll);
          done({settled: false, timedOut: true, elapsedMs: elapsed,
            bannerVisible: bannerVisible,
            status: document.querySelector('.status_text')?.textContent ?? null});
        }
      }, 1000);
    });

    console.log('      mp4 UI save outcome:', JSON.stringify(outcome));
    expect(outcome.settled).toBe(true);
  });
});
