// Diagnostic probe for the save/download transport on the real installed
// extension (moz-extension:// origin).
//
// The web-build suite (specs/save-video.e2e.mjs) proves the player-side save
// logic, but it bypasses everything that only exists under the extension
// origin: SaveManager's real filename prompt, the streamSaver writable, and
// the background DOWNLOAD handler. This spec probes exactly those, so a
// "Save button freezes the player" report can be pinned to a layer instead
// of guessed at.
//
// Probes:
//   1. Environment: is the page an extension page, does a ServiceWorker
//      container exist, does getRegistration('./') find anything. StreamSaver
//      selects its service-worker transport vs blob fallback purely off
//      `!EnvUtils.isExtension() || navigator.serviceWorker === undefined`, so
//      a browser where the property exists but no SW can ever be registered
//      on this origin would silently pick the transport that can never work.
//   2. streamSaver.createWriteStream: write + close, each raced against a
//      timeout, so a hung transport shows as {stage: 'write'|'close',
//      timedOut: true} instead of a suite-wide timeout.
//   3. The background DOWNLOAD handler: Utils.downloadURL on a blob URL,
//      which is the exact final step of every non-streamed save (DASH muxes
//      to a blob first). Firefox partitioned-iframe blob isolation is a known
//      failure mode here (Bugzilla 1917842).
//
// NOTE: runInPage bodies are stringified with fn.toString() and evaluated in
// the page, so they must be self-contained - they see nothing from this
// module's scope. Timeouts inside them are therefore hardcoded.

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

/**
 * Opens an extension page and focuses it - same dance as extension.e2e.mjs
 * (geckodriver refuses direct moz-extension:// navigation).
 * @param {string} pagePath path under the extension origin
 * @return {Promise<void>}
 */
async function openExtensionPage(pagePath) {
  const handlesBefore = await browser.getWindowHandles();
  for (const h of handlesBefore.slice(1)) {
    await browser.switchToWindow(h);
    await browser.closeWindow();
  }
  await browser.switchToWindow(handlesBefore[0]);
  await browser.url(OPENER_URL);
  await browser.execute((u) => window.open(u, '_blank'), ORIGIN + pagePath);
  await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length > 1,
      {timeout: 15000, timeoutMsg: 'the extension page never opened'});
  const handles = await browser.getWindowHandles();
  await browser.switchToWindow(handles[handles.length - 1]);
  await browser.waitUntil(
      async () => (await browser.getUrl()).startsWith('moz-extension://'),
      {timeout: 15000, timeoutMsg: 'the new window is not the extension page'});
  await browser.waitUntil(
      async () => browser.execute(() => document.readyState === 'complete'),
      {timeout: 30000, timeoutMsg: 'the extension page never finished loading'});
}

/**
 * Runs an async snippet in the page and waits for it to settle, surfacing
 * page-side errors - same shape as extension.e2e.mjs's runInPage.
 * @param {Function} fn async function to run in the page
 * @param {number} [timeout] how long to allow, in ms
 * @return {Promise<any>} whatever fn resolved with
 */
async function runInPage(fn, timeout = 60000) {
  await browser.execute((body) => {
    window.__out = undefined;
    window.____err = undefined;
    (0, eval)(`(${body})()`)
        .then((v) => {
          window.__out = v;
        })
        .catch((e) => {
          window.__err = (e && e.stack) || String(e);
        });
  }, fn.toString());

  await browser.waitUntil(
      async () => browser.execute(
          () => window.__out !== undefined || window.__err !== undefined),
      {timeout, interval: 250, timeoutMsg: 'the page never settled'},
  );

  const {out, err} = await browser.execute(
      () => ({out: window.__out, err: window.__err}));
  if (err) throw new Error('page-side failure: ' + err);
  return out;
}

/**
 * Navigates to the harness /embed page (an ordinary http page embedding the
 * extension player in a cross-origin iframe) and switches the driver into
 * that frame - the partitioned context real sites put the player in.
 * @return {Promise<void>}
 */
async function openEmbeddedPlayer() {
  await browser.url(globalThis.__EXT_OPENER_URL__ + 'embed?t=' + Date.now());
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
}

describe('save transport on the installed extension', function() {
  beforeEach(async function() {
    await openExtensionPage('/player/index.html?t=' + Date.now());
  });

  it('reports the service-worker environment the stream transport depends on', async function() {
    const env = await runInPage(async () => {
      const {EnvUtils} = await import('/player/utils/EnvUtils.mjs');
      let registration = 'unset';
      let getRegError = null;
      try {
        registration = await navigator.serviceWorker?.getRegistration('./');
      } catch (e) {
        getRegError = String(e);
      }
      return {
        isExtension: EnvUtils.isExtension(),
        isFirefox: EnvUtils.isFirefox(),
        isChrome: EnvUtils.isChrome(),
        swContainerType: typeof navigator.serviceWorker,
        registrations: registration === 'unset' ? 'unset' :
          (registration ? registration.map((r) => r.scope) : null),
        getRegError,
        // What StreamSaver.mjs's useBlobFallback evaluates to:
        useBlobFallback: !EnvUtils.isExtension() || navigator.serviceWorker === undefined,
      };
    });

    console.log('      env:', JSON.stringify(env, null, 2));
    expect(env.isExtension).toBe(true);
  });

  it('writes a chunk through streamSaver without hanging', async function() {
    const result = await runInPage(async () => {
      const {streamSaver} = await import('/player/modules/StreamSaver.mjs');

      // Raced against a 6s timer so a hung transport becomes data instead of
      // a suite-wide timeout.
      const raced = (p) => Promise.race([
        p.then((v) => ({settled: true, value: v === undefined ? null : v})),
        new Promise((r) => setTimeout(() => r({settled: false, timedOut: true}), 6000)),
      ]);

      const ws = streamSaver.createWriteStream('probe-' + Date.now() + '.bin');
      const writer = ws.getWriter();

      const write = await raced(writer.write(new Uint8Array([1, 2, 3, 4])));
      let close = {settled: false, timedOut: true};
      if (write.settled) {
        close = await raced(writer.close());
      } else {
        await writer.abort().catch(() => {});
      }
      return {
        writeSettled: write.settled,
        writeTimedOut: !!write.timedOut,
        closeSettled: close.settled,
        closeTimedOut: !!close.timedOut,
      };
    });

    console.log('      streamSaver write/close:', JSON.stringify(result));
    // A hung transport (stream handed to a service worker that can never
    // read it) shows up as write or close never settling.
    expect(result.writeTimedOut).toBe(false);
    if (result.writeSettled) {
      expect(result.closeTimedOut).toBe(false);
    }
  });

  it('downloads a blob URL through the background DOWNLOAD handler', async function() {
    const result = await runInPage(async () => {
      const {Utils} = await import('/player/utils/Utils.mjs');
      const {EnvUtils} = await import('/player/utils/EnvUtils.mjs');
      const blob = new Blob(['faststream probe'], {type: 'text/plain'});
      const url = URL.createObjectURL(blob);
      try {
        const id = await Utils.downloadURL(url, 'faststream-probe.txt');
        return {
          viaBackground: EnvUtils.isExtension() && !EnvUtils.isChrome(),
          downloadId: id === undefined ? 'undefined' : id,
        };
      } catch (e) {
        return {error: String(e)};
      }
    });

    console.log('      background download:', JSON.stringify(result));
    if (result.viaBackground) {
      // null is what the background sends when chrome.downloads.download
      // rejected - the silent-failure mode blob partitioning produces.
      expect(result.downloadId).not.toBe(null);
    }
  });

  // The real-world embedding: content.js replaces a page's <video> with a
  // moz-extension:// iframe inside the SITE'S page - a partitioned context.
  // Firefox's blob-isolation bug (bugzilla 1917842) makes blob URLs created
  // in such a frame inaccessible to chrome.downloads.download, with the
  // error 'Cannot access blob URL ... with a different partition key'. The
  // top-level probes above pass precisely because they are NOT partitioned.
  //
  // This probe is fully self-contained (no imports): it creates a blob URL
  // inside the iframe and sends the raw DOWNLOAD message - exactly what
  // Utils.downloadURL does for a non-streamed save.
  it('downloads a blob URL created inside a partitioned player iframe', async function() {
    await openEmbeddedPlayer();

    const result = await browser.executeAsync((done) => {
      const blob = new Blob(['faststream iframe probe'], {type: 'text/plain'});
      const url = URL.createObjectURL(blob);
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD',
        url: url,
        filename: 'faststream-iframe-probe.txt',
      }, (resp) => {
        done({
          inFrame: window.self !== window.top,
          origin: location.origin,
          lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null,
          downloadId: resp === undefined ? 'undefined' : resp,
        });
      });
    });

    await browser.switchToParentFrame();
    console.log('      iframe download:', JSON.stringify(result));
    expect(result.inFrame).toBe(true);
    expect(result.origin.startsWith('moz-extension://')).toBe(true);
    // null is what the background sends when chrome.downloads.download
    // rejected - the silent-failure mode blob partitioning produces.
    expect(result.lastError).toBe(null);
    expect(result.downloadId).not.toBe(null);
  });

  // NOTE: a "click the Save button in the iframe" probe would live here, but
  // without a source loaded the player renders no Save control at all, and
  // the faithful version of that flow - embedded iframe + real accelerated
  // MP4 + real prompt + full save - is exactly what save-flow.e2e.mjs
  // already drives end to end. Duplicating it with a fake source would test
  // less and flake more.
});
