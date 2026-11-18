// Probes the save transport on the installed extension: the filename prompt, the streamSaver
// writable, the DOWNLOAD handler.
//
// 1. Environment: an extension page, a ServiceWorker container, a registration (streamSaver picks
// its transport by these).
//   2. streamSaver.createWriteStream: write and close, each raced against a timeout.
//   3. The DOWNLOAD handler on a blob URL, the last step of a non-streamed save (Bugzilla 1917842).
//
// runInPage bodies are stringified and run in the page: self-contained, timeouts hardcoded.

import {browser, expect} from '@wdio/globals';
import {pageState} from '../specs/diagnostics.mjs';

import {openExtensionPage} from '../extension-page.mjs';
import {runInPage} from '../runInPage.mjs';

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
      const {FSBlob} = await import('/player/modules/FSBlob.mjs');
      const {OPFSManager} = await import('/player/network/OPFSManager.mjs');

      // what the save's own blob store did and when, printed with the result
      const trace = [];
      const start = performance.now();
      const note = (what) => trace.push(`${Math.round(performance.now() - start)} ms ${what}`);
      for (const [proto, name] of [[FSBlob.prototype, 'ready'], [OPFSManager.prototype, 'setup'], [OPFSManager.prototype, 'call']]) {
        const original = proto[name];
        proto[name] = function(...args) {
          const label = name + (typeof args[0] === 'string' ? ' ' + args[0] : '');
          note(label + ' started');
          const result = original.apply(this, args);
          Promise.resolve(result).then(() => note(label + ' settled'), (e) => note(label + ' failed: ' + e));
          return result;
        };
      }

      // Raced against a timer; 20 s, as the first write starts the save's OPFS worker, slow to init
      // in a fresh profile.
      const raced = (p) => Promise.race([
        p.then((v) => ({settled: true, value: v === undefined ? null : v})),
        new Promise((r) => setTimeout(() => r({settled: false, timedOut: true}), 20000)),
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
        trace,
      };
    });

    const {trace, ...outcome} = result;
    console.log('      streamSaver write/close:', JSON.stringify(outcome));
    if (result.writeTimedOut || result.closeTimedOut) {
      // Saves have hung on the Windows runner on an OPFS worker call that never answered.
      console.log('      storage state:', JSON.stringify(await pageState()));
      console.log('      the save\'s blob store:\n        ' + trace.join('\n        '));
    }
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
          viaBackground: EnvUtils.isExtension(),
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

  // In a partitioned iframe blob URLs are refused to downloads.download (bugzilla 1917842): this
  // probe sends the raw DOWNLOAD from one.
  it('downloads a blob URL created inside a partitioned player iframe', async function() {
    await openEmbeddedPlayer();

    const result = await browser.execute(() => new Promise((done) => {
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
    }));

    await browser.switchToParentFrame();
    console.log('      iframe download:', JSON.stringify(result));
    expect(result.inFrame).toBe(true);
    expect(result.origin.startsWith('moz-extension://')).toBe(true);
    // null is what the background sends when chrome.downloads.download
    // rejected - the silent-failure mode blob partitioning produces.
    expect(result.lastError).toBe(null);
    expect(result.downloadId).not.toBe(null);
  });

  // A Save-button probe is save-flow.e2e.mjs's: it drives the whole save end to end.
});
