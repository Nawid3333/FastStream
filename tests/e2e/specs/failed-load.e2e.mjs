// A stream that cannot be loaded ends in the player's error message, not in a spinner that
// never stops.
//
// The local server answers 404 for a fixture that does not exist, so each case opens the
// player at a manifest or file that is not there and waits for the client's failedToLoad.

import {browser, expect} from '@wdio/globals';

const DEAD = [
  {name: 'HLS manifest', path: '/fixtures/missing/stream.m3u8'},
  {name: 'DASH manifest', path: '/fixtures/missing/stream.mpd'},
  {name: 'MP4 file', path: '/fixtures/missing/video.mp4'},
];

/**
 * Opens the web player at a source. The query makes every case a real page load (see
 * playback.e2e.mjs).
 * @param {string} source - Media URL.
 * @return {Promise<void>}
 */
async function openPlayer(source) {
  await browser.url(`/player/index.html?t=${Date.now()}#${source}`);
}

describe('A stream that cannot be loaded', function() {
  for (const stream of DEAD) {
    it(`shows the load error for a missing ${stream.name}`, async function() {
      await openPlayer(globalThis.__E2E_FIXTURES_ORIGIN__ + stream.path);
      const started = Date.now();
      let state = {};
      await browser.waitUntil(async () => {
        state = await browser.execute(() => ({
          failed: !!window.fastStream?.interfaceController?.failed,
          buffering: !!window.fastStream?.interfaceController?.state?.buffering,
        }));
        return state.failed;
      }, {timeout: 90000, interval: 500}).catch(() => {});
      console.log(`      ${stream.name}: ${JSON.stringify(state)} after ${Date.now() - started} ms`);
      expect(state.failed).toBe(true);
    });
  }
});
