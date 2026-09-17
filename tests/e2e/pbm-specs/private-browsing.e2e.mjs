// What must keep working in a Firefox private window.
//
// The regression this guards: OPFS is present and unusable in a private
// window (navigator.storage.getDirectory() throws SecurityError), and FSBlob
// used to commit to it on the strength of the API existing. Its setup then
// rejected, and clear()/deleteBlob() handed that rejection to
// DownloadManager.reset() -> FastStreamClient.setSource(), which caught it
// and never built the player - no <video>, no playback, in every private
// window, while the whole ext-specs suite stayed green.
//
// See wdio.pbm.conf.mjs for how the private session and the add-on's
// private-browsing permission are set up, and why these specs run under
// WebDriver classic.

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

/**
 * Switches to the window showing the given extension page, opening it from
 * the harness page first if it is not already up.
 *
 * Picked by URL rather than by taking the last handle: the add-on reload that
 * grants private-browsing access re-fires runtime.onInstalled, so a
 * welcome.html tab is usually sitting at the end of the handle list.
 *
 * @param {string} pagePath path under the extension origin
 * @return {Promise<void>} resolves once that page is focused and loaded
 */
async function openExtensionPage(pagePath) {
  const target = ORIGIN + pagePath;
  await browser.switchToWindow((await browser.getWindowHandles())[0]);
  await browser.url(OPENER_URL);
  await browser.execute((u) => window.open(u, '_blank'), target);

  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      if ((await browser.getUrl()).startsWith(target)) return true;
    }
    return false;
  }, {timeout: 20000, timeoutMsg: `${pagePath} never opened in the private window`});

  await browser.waitUntil(
      async () => browser.execute(() => document.readyState === 'complete'),
      {timeout: 30000, timeoutMsg: 'the extension page never finished loading'});
}

/**
 * Opens the player inside a cross-origin iframe on an ordinary http page -
 * the way content.js embeds it on a real site - pointed at a media URL.
 * @param {string} url media URL to load through the player's hash
 * @return {Promise<void>} resolves with the driver inside the player iframe
 */
async function openEmbeddedPlayer(url) {
  await browser.switchToWindow((await browser.getWindowHandles())[0]);
  await browser.url(globalThis.__EXT_OPENER_URL__ + 'embed?t=' + Date.now());
  await browser.waitUntil(
      async () => browser.execute(() => {
        const f = document.querySelector('iframe#fs');
        return !!f && f.src.startsWith('moz-extension://');
      }),
      {timeout: 15000, timeoutMsg: 'the embed page never got its player iframe'});
  await browser.execute((origin, u) => {
    const f = document.querySelector('iframe#fs');
    f.src = origin + '/player/index.html?t=' + Date.now() + '#' + u;
  }, ORIGIN, url);

  await browser.switchFrame(await browser.$('iframe#fs'));
  await browser.waitUntil(
      async () => browser.execute(() => document.readyState === 'complete'),
      {timeout: 30000, timeoutMsg: 'the player iframe never finished loading'});
  await browser.waitUntil(
      async () => browser.execute(() => !!window.fastStream),
      {timeout: 30000, timeoutMsg: 'window.fastStream never appeared'});
  await browser.execute(() => window.fastStream.userInteracted());
}

describe('the extension in a private window', function() {
  it('really is running in a private context', async function() {
    await openExtensionPage('/player/index.html');
    const env = await browser.execute(() => ({
      inIncognitoContext: chrome.extension.inIncognitoContext,
      title: document.title,
    }));
    console.log('      private env:', JSON.stringify(env));
    // Guards the harness itself: every assertion below is worthless if the
    // session quietly came up non-private.
    expect(env.inIncognitoContext).toBe(true);
  });

  it('answers a background ping', async function() {
    await openExtensionPage('/player/index.html');
    const res = await browser.executeAsync((done) => {
      chrome.runtime.sendMessage({type: 'PING'}, (r) => done({
        response: r,
        lastError: chrome.runtime.lastError ?
          String(chrome.runtime.lastError.message) : null,
      }));
    });
    console.log('      background ping:', JSON.stringify(res));
    expect(res.response).toBe('PONG');
  });

  it('offloads blobs to a real backend instead of dropping to memory', async function() {
    await openExtensionPage('/player/index.html');
    const res = await browser.executeAsync(async (done) => {
      const out = {};
      try {
        const {FSBlob} = await import('/player/modules/FSBlob.mjs');
        const store = new FSBlob();
        const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const identifier = await store.saveBlobAsync(new Blob([payload]));
        out.backend = store.opfsManager ? 'opfs' :
          (store.cache ? 'cache' :
            (store.indexedDBManager ? 'indexeddb' : 'memory'));
        const readBack = new Uint8Array(
            await store.getBlob(identifier).arrayBuffer());
        out.roundTrips = readBack.length === payload.length &&
            readBack.every((b, i) => b === payload[i]);
        store.close();
      } catch (e) {
        out.err = (e && e.stack) || String(e);
      }
      done(out);
    });

    console.log('      blob backend:', JSON.stringify(res));
    expect(res.err).toBe(undefined);
    expect(res.roundTrips).toBe(true);
    // The point of the backend chain: OPFS is unusable here, so FSBlob has to
    // fall through to the Cache API, which works. Ending up on 'memory' means
    // every buffered fragment is sitting in RAM again.
    expect(res.backend).not.toBe('memory');
    expect(res.backend).not.toBe('opfs');
  });

  it('never rejects out of clear() or deleteBlob()', async function() {
    await openExtensionPage('/player/index.html');
    const res = await browser.executeAsync(async (done) => {
      const out = {};
      const {FSBlob} = await import('/player/modules/FSBlob.mjs');
      const store = new FSBlob();
      try {
        const identifier = await store.saveBlobAsync(new Blob([new Uint8Array([1])]));
        await store.deleteBlob(identifier);
        out.deleteBlob = 'resolved';
      } catch (e) {
        out.deleteBlob = 'REJECTED: ' + (e && e.message);
      }
      try {
        await store.clear();
        out.clear = 'resolved';
      } catch (e) {
        out.clear = 'REJECTED: ' + (e && e.message);
      }
      // The exact call the player makes on every new source, and the one
      // whose rejection used to abandon player creation.
      try {
        await window.fastStream.downloadManager.reset();
        out.downloadManagerReset = 'resolved';
      } catch (e) {
        out.downloadManagerReset = 'REJECTED: ' + (e && e.message);
      }
      store.close();
      done(out);
    });

    console.log('      teardown calls:', JSON.stringify(res));
    expect(res.deleteBlob).toBe('resolved');
    expect(res.clear).toBe('resolved');
    expect(res.downloadManagerReset).toBe('resolved');
  });

  it('builds a player and decodes an MP4', async function() {
    // eslint-disable-next-line no-invalid-this
    this.timeout(120000);
    await openEmbeddedPlayer(globalThis.__EXT_FIXTURE_MP4__);

    await browser.waitUntil(
        async () => browser.execute(() => {
          const v = document.querySelector('video');
          return !!v && v.readyState >= 2;
        }),
        {timeout: 60000, interval: 1000,
          timeoutMsg: 'video never reached HAVE_CURRENT_DATA in a private window'});

    const state = await browser.execute(() => {
      const v = document.querySelector('video');
      return {
        readyState: v.readyState,
        error: v.error ? {code: v.error.code, message: v.error.message} : null,
      };
    });
    console.log('      playback:', JSON.stringify(state));
    expect(state.error).toBe(null);
  });

  it('asks for a filename before saving', async function() {
    // eslint-disable-next-line no-invalid-this
    this.timeout(120000);
    await openEmbeddedPlayer(globalThis.__EXT_FIXTURE_MP4__);
    await browser.waitUntil(
        async () => browser.execute(() => {
          const v = document.querySelector('video');
          return !!v && v.readyState >= 2;
        }),
        {timeout: 60000, interval: 1000, timeoutMsg: 'video never became ready'});

    await browser.execute(() => document.querySelector('video').play().catch(() => {}));
    await new Promise((r) => setTimeout(r, 6000));

    await browser.waitUntil(
        async () => browser.execute(
            () => !!document.querySelector('.main_download, #download')),
        {timeout: 15000, timeoutMsg: 'the save button never appeared'});
    await browser.execute(() => {
      (document.querySelector('.main_download') ||
       document.querySelector('#download')).click();
    });

    // Firefox private-window downloads land in the download directory with
    // no picker of their own, so the prompt has to come from us or the user
    // never gets to name the file. SaveManager used to skip it in any
    // incognito context, which is only correct for Chrome.
    await browser.waitUntil(
        async () => browser.execute(
            () => !!document.querySelector('.swal2-container .swal2-input')),
        {timeout: 20000,
          timeoutMsg: 'the filename prompt never appeared in a private window'});

    const suggested = await browser.execute(
        () => document.querySelector('.swal2-input').value);
    console.log('      suggested filename:', JSON.stringify(suggested));
    expect(typeof suggested).toBe('string');
  });
});
