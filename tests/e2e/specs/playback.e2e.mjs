// End-to-end playback checks.
//
// These replace the manual checklist in tests/manual-playback-urls.txt. That
// checklist required a person to open three URLs and watch for video after
// every change to a player, a loader or a vendored media library - which
// meant it was skipped, and it never ran on CI.
//
// The player is driven through `player/index.html#<url>`, which main.mjs
// treats as a source and loads with the mode implied by the extension. That
// seam exercises the real players and the real vendored libraries (hls.js,
// dash.js, mp4box) without depending on the page-interception UI, which is
// far more brittle to drive and is not what these changes touch.
//
// What counts as a pass is deliberately strict: not "a video element exists"
// but "currentTime advanced past zero while readyState reported decodable
// data". A player that loads its manifest and then stalls fails here, which
// is exactly the failure a library swap causes.

import {browser, expect} from '@wdio/globals';

/** Streams chosen for stability and for exercising one library each. */
const STREAMS = [
  {
    name: 'HLS (hls.js + hls.worker.js)',
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  },
  {
    name: 'DASH (dash.js)',
    url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd',
  },
  {
    name: 'MP4 (mp4box)',
    // Served by the local test server: same-origin, so no CORS, and no
    // network dependency once fetched. See wdio.conf.mjs.
    url: 'http://127.0.0.1:41879/fixtures/sample.mp4',
  },
];

/**
 * Opens the web player at a given source.
 *
 * main.mjs treats the page hash as a source URL and picks the player mode
 * from its extension, so this one entry point reaches the HLS, DASH and MP4
 * paths - and therefore hls.js, dash.js and mp4box - without any UI driving.
 *
 * @param {string} [source] media URL to load, passed via the page's hash
 * @return {Promise<void>}
 */
async function openPlayer(source) {
  // The cache-busting query is load-bearing, not cosmetic. Navigating from
  // `index.html#a` to `index.html#b` changes only the fragment, so Firefox
  // does not reload - main.mjs reads the hash once at startup, and every test
  // after the first would silently re-measure the first stream and pass.
  // Making the path differ forces a real document load per case.
  const bust = `?t=${Date.now()}`;
  await browser.url(
      '/player/index.html' + bust + (source ? '#' + source : ''));
}

describe('FastStream playback', function() {
  it('serves the player page from the extension', async function() {
    // Guards the rest of the suite: if the pinned uuid mapping ever stops
    // working, every playback test would fail with a confusing "no <video>"
    // rather than "the page did not load".
    await openPlayer();
    expect(await browser.getUrl()).toContain('/player/index.html');
  });

  for (const stream of STREAMS) {
    it(`plays ${stream.name}`, async function() {
      await openPlayer(stream.url);

      // The player mounts its own <video>; wait for one to exist at all
      // before asking anything about it, or the first poll races the module
      // graph loading.
      await browser.waitUntil(
          async () => browser.execute(() => !!document.querySelector('video')),
          {timeout: 30000, timeoutMsg: 'no <video> element was created'},
      );

      // readyState >= 2 (HAVE_CURRENT_DATA) means the decoder produced a
      // frame for the current position - a manifest parsed but undecodable
      // does not reach this.
      await browser.waitUntil(
          async () => browser.execute(
              () => document.querySelector('video').readyState >= 2),
          {timeout: 60000, timeoutMsg: 'video never reached HAVE_CURRENT_DATA'},
      );

      const start = await browser.execute(
          () => document.querySelector('video').currentTime);

      // Advancing currentTime is the part that distinguishes real playback
      // from a loaded-but-stalled player.
      //
      // play() is re-issued on every poll rather than called once: FastStream
      // drives the element through its own state machine and can pause it
      // back while it finishes setting up, so a single call made at the wrong
      // moment is silently undone and the clip never starts.
      await browser.waitUntil(
          async () => browser.execute((t) => {
            const v = document.querySelector('video');
            if (v.paused) v.play().catch(() => {});
            return v.currentTime > t;
          }, start),
          {
            timeout: 30000,
            interval: 500,
            timeoutMsg: 'currentTime never advanced',
          },
      );

      const state = await browser.execute(() => {
        const v = document.querySelector('video');
        return {
          videos: document.querySelectorAll('video').length,
          src: (v.currentSrc || v.src || '').slice(0, 60),
          readyState: v.readyState,
          currentTime: v.currentTime,
          duration: v.duration,
          error: v.error ? {code: v.error.code, message: v.error.message} : null,
        };
      });
      console.log('      state:', JSON.stringify(state));
      expect(state.error).toBe(null);
    });
  }
});
