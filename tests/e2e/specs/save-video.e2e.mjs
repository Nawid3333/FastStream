// Regression coverage for the "Save video" (download) feature.
//
// Nawid reported the download button "behaving weird" -- the saved file
// would not play, and the save-progress percentage stopped showing. Neither
// SaveManager.mjs, StatusManager.mjs, DownloadManager.mjs nor any of the four
// per-format saveVideo() implementations have changed from upstream (only
// the MPV feature touches the first two, and that only adds new code paths).
// The regression is one directory over: chrome/player/modules/hls2mp4/
// transmuxer.mjs drives hls.js's TSDemuxer/MP4Remuxer classes directly, on
// already-downloaded fragments, to remux HLS into a single MP4 for saving --
// and hls.js 1.7.2 (this fork upgraded from 1.6.9; upstream is still on
// 1.6.9) added a `chunkMeta` parameter to resetInitSegment/demux/remux that
// is read unconditionally (`chunkMeta.iframe`) at the top of each. hls.js's
// own pipeline always supplies a real one; transmuxer.mjs, written against
// the old signatures, supplied none, so it arrived as undefined and threw
// the moment a discontinuity was reset for a source with an out-of-band init
// segment -- which fMP4/CMAF-packaged HLS (increasingly the common case) has.
//
// This only affects HLS saves that go through transmuxer.mjs. DASH
// (dash2mp4/mp4merger.mjs) and plain MP4 do not import it and were
// unaffected -- kept here as one quick confirming case, not because either
// was ever suspected.

import {browser, expect} from '@wdio/globals';

/**
 * Opens the web player at a given source, same seam as playback.e2e.mjs.
 * @param {string} source - Media URL to load, passed via the page's hash.
 * @return {Promise<void>}
 */
async function openPlayer(source) {
  const bust = `?t=${Date.now()}`;
  await browser.url('/player/index.html' + bust + '#' + source);
}

/**
 * Waits for playable data, nudges playback so fragments actually download,
 * then drives player.saveVideo() directly -- bypassing the UI's filename
 * prompt and file-save dialog, neither of which WebDriver can drive -- and
 * validates the resulting blob by loading it into a fresh, disconnected
 * <video> element.
 *
 * A partial save (partialSave: true) is used throughout: waiting for an
 * entire clip to finish downloading before saving would make this suite
 * slow without adding coverage - the bug reproduces on the very first
 * fragment already in hand.
 *
 * @return {Promise<Object>} {saveError, blobSize, blobType, decodeOk,
 *   decodeError, duration}
 */
async function saveAndValidate() {
  await browser.waitUntil(
      async () => browser.execute(() => !!document.querySelector('video')),
      {timeout: 30000, timeoutMsg: 'no <video> element was created'});
  await browser.waitUntil(
      async () => browser.execute(() => document.querySelector('video').readyState >= 2),
      {timeout: 60000, timeoutMsg: 'video never reached HAVE_CURRENT_DATA'});

  await browser.execute(() => document.querySelector('video').play().catch(() => {}));
  // Long enough for several fragments to actually download -- saveVideo can
  // run with just the one fragment behind the playhead, but a save that
  // starts before any fragment has fully landed exercises less of the path.
  await new Promise((r) => setTimeout(r, 6000));

  return browser.executeAsync((done) => {
    const info = {
      saveError: null, blobSize: null, blobType: null,
      decodeOk: null, decodeError: null, duration: null,
    };
    window.fastStream.player.saveVideo({
      onProgress: () => {},
      registerCancel: () => {},
      partialSave: true,
    }).then((result) => {
      info.blobSize = result.blob.size;
      info.blobType = result.blob.type;
      const url = URL.createObjectURL(result.blob);
      const testVideo = document.createElement('video');
      testVideo.src = url;
      const finish = () => {
        URL.revokeObjectURL(url);
        done(info);
      };
      testVideo.onloadedmetadata = () => {
        info.decodeOk = true;
        info.duration = testVideo.duration;
        finish();
      };
      testVideo.onerror = () => {
        info.decodeOk = false;
        info.decodeError = testVideo.error ?
          {code: testVideo.error.code, message: testVideo.error.message} : null;
        finish();
      };
      setTimeout(() => {
        if (info.decodeOk === null) {
          info.decodeOk = false;
          info.decodeError = 'timeout waiting for loadedmetadata';
          finish();
        }
      }, 15000);
    }).catch((e) => {
      info.saveError = (e && e.stack) || String(e);
      done(info);
    });
  });
}

describe('Save video (download)', function() {
  it('mux + saves an HLS clip into a file that actually decodes', async function() {
    await openPlayer('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
    const result = await saveAndValidate();

    console.log('      result:', JSON.stringify(result));
    // Before the fix: saveError carried hls.js's own stack --
    // "TypeError: chunkMeta is undefined" thrown from demux(), reached via
    // transmuxer.mjs's resetInitSegment() the moment the first discontinuity
    // with an init segment was processed. Confirmed by reverting the fix and
    // observing exactly that stack here.
    expect(result.saveError).toBe(null);
    expect(result.decodeOk).toBe(true);
    expect(result.duration).toBeGreaterThan(0);
    expect(result.blobSize).toBeGreaterThan(0);
  });

  it('mux + saves a DASH clip into a file that actually decodes', async function() {
    // Confirms the unrelated format still works -- dash2mp4/mp4merger.mjs
    // does not import transmuxer.mjs and was never suspected, but this is
    // cheap insurance against a future dash.js upgrade breaking the same way.
    await openPlayer('https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd');
    const result = await saveAndValidate();

    console.log('      result:', JSON.stringify(result));
    expect(result.saveError).toBe(null);
    expect(result.decodeOk).toBe(true);
    expect(result.duration).toBeGreaterThan(0);
  });
});
