// The "Save video" feature: HLS saves go through transmuxer.mjs, which drives hls.js's demuxer and
// remuxer directly.
//
// DASH and plain MP4 do not use it; save-fmp4.e2e.mjs saves DASH and decodes what it saves.
//
// Every stream is local (wdio.conf.mjs's fixtures): this suite gates CI and the release.

import {browser, expect} from '@wdio/globals';
import {pageState, phaseTimer} from './diagnostics.mjs';

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
 * Waits for playable data, plays so fragments download, calls player.saveVideo() directly
 * (WebDriver cannot drive the save dialog), and loads the blob into a fresh <video>.
 * A partial save: the first fragment in hand is enough.
 *
 * @return {Promise<Object>} {saveError, blobSize, blobType, decodeOk,
 *   decodeError, duration}
 */
async function saveAndValidate() {
  // Each phase is logged and each wait bounded, so a hang fails with its phase and pageState before
  // the test's timeout.
  const phase = phaseTimer();
  let reached = 'start';
  try {
    return await saveAndValidatePhases((name) => {
      reached = name;
      phase(name);
    });
  } catch (e) {
    throw new Error(`${e.message} (last phase: ${reached}) ${JSON.stringify(await pageState())}`);
  }
}

async function saveAndValidatePhases(phase) {
  await browser.waitUntil(
      async () => browser.execute(() => !!document.querySelector('video')),
      {timeout: 20000, timeoutMsg: 'no <video> element was created'});
  await browser.waitUntil(
      async () => browser.execute(() => document.querySelector('video').readyState >= 2),
      {timeout: 40000, timeoutMsg: 'video never reached HAVE_CURRENT_DATA'});
  phase('ready');

  await browser.execute(() => document.querySelector('video').play().catch(() => {}));
  // several fragments in: a save before any landed exercises less of the path
  await new Promise((r) => setTimeout(r, 6000));
  phase('played');

  const saved = await browser.execute(() => new Promise((done) => {
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
      info.saveError = ((e && e.message) ? e.message + '\n' : '') + ((e && e.stack) || String(e));
      done(info);
    });
  }));
  phase('saved');
  return saved;
}

/**
 * As saveAndValidate, for canStream players (MP4Player, DirectVideoPlayer): they write into a
 * WritableStream collected in the page.
 * @return {Promise<Object>} {saveError, blobSize, blobType, decodeOk,
 *   decodeError, duration}
 */
async function saveAndValidateStreamed() {
  await browser.waitUntil(
      async () => browser.execute(() => !!document.querySelector('video')),
      {timeout: 30000, timeoutMsg: 'no <video> element was created'});
  await browser.waitUntil(
      async () => browser.execute(() => document.querySelector('video').readyState >= 2),
      {timeout: 60000, timeoutMsg: 'video never reached HAVE_CURRENT_DATA'});

  await browser.execute(() => document.querySelector('video').play().catch(() => {}));
  await new Promise((r) => setTimeout(r, 3000));

  return browser.execute(() => new Promise((done) => {
    const info = {
      saveError: null, blobSize: null, blobType: null,
      decodeOk: null, decodeError: null, duration: null,
    };
    const chunks = [];
    const filestream = new WritableStream({
      write(chunk) {
        chunks.push(chunk);
      },
    });

    window.fastStream.player.saveVideo({
      onProgress: () => {},
      registerCancel: () => {},
      filestream,
    }).then(() => {
      const blob = new Blob(chunks, {type: 'video/webm'});
      info.blobSize = blob.size;
      info.blobType = blob.type;
      const url = URL.createObjectURL(blob);
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
  }));
}

describe('Save video (download)', function() {
  // fMP4 with an init segment puts transmuxer.mjs on its init path; a separate audio rendition
  // muxes two tracks; TS is the muxed case.
  for (const [fixture, playlist, kind] of [
    ['hls-ts', 'index.m3u8', 'MPEG-TS'],
    ['hls-fmp4', 'index.m3u8', 'fMP4'],
    ['hls-audio', 'master.m3u8', 'separate-audio'],
  ]) {
    it(`mux + saves a local ${kind} HLS clip into a file that actually decodes`, async function() {
      await openPlayer(globalThis.__E2E_FIXTURES_ORIGIN__ + `/fixtures/${fixture}/${playlist}`);
      const result = await saveAndValidate();

      console.log('      result:', JSON.stringify(result));
      expect(result.saveError).toBe(null);
      expect(result.decodeOk).toBe(true);
      expect(result.duration).toBeGreaterThan(0);
      expect(result.blobSize).toBeGreaterThan(0);
    });
  }

  it('saves a DIRECT/webm source into a file that actually decodes', async function() {
    // .webm: DirectVideoPlayer fetches the whole resource and saves it streamed.
    //
    // the local same-origin fixture: DirectVideoPlayer.saveVideo() fetches the source itself and
    // needs CORS
    await openPlayer(globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/sample.webm');
    const result = await saveAndValidateStreamed();

    console.log('      result:', JSON.stringify(result));
    expect(result.saveError).toBe(null);
    expect(result.decodeOk).toBe(true);
    expect(result.duration).toBeGreaterThan(0);
    expect(result.blobSize).toBeGreaterThan(0);
  });

  it('cancels a DIRECT/webm save promptly instead of completing or hanging', async function() {
    await openPlayer(globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/sample.webm');
    await browser.waitUntil(
        async () => browser.execute(() => !!document.querySelector('video')),
        {timeout: 30000, timeoutMsg: 'no <video> element was created'});
    await browser.waitUntil(
        async () => browser.execute(() => document.querySelector('video').readyState >= 2),
        {timeout: 60000, timeoutMsg: 'video never reached HAVE_CURRENT_DATA'});

    const result = await browser.execute(() => new Promise((done) => {
      let cancel;
      const filestream = new WritableStream({
        write() {},
      });
      const start = performance.now();
      const savePromise = window.fastStream.player.saveVideo({
        onProgress: () => {},
        registerCancel: (c) => {
          cancel = c;
        },
        filestream,
      });
      // registerCancel() runs before saveVideo()'s first await, so `cancel` is set: aborted before
      // the fetch, deterministically.
      if (cancel) cancel();
      savePromise.then(() => {
        done({rejected: false, message: null, elapsed: performance.now() - start});
      }).catch((e) => {
        done({rejected: true, message: (e && e.message) || String(e), elapsed: performance.now() - start});
      });
    }));

    console.log('      result:', JSON.stringify(result));
    expect(result.rejected).toBe(true);
    expect(result.message).toBe('Cancelled');
    expect(result.elapsed).toBeLessThan(5000);
  });
});
