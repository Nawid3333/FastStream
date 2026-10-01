// Records which platform APIs the voice activity detector needs, and whether this
// Firefox has them. It ships the largest third-party files in the tree (the stock
// onnxruntime-web 1.30.0 wasm, about 14 MB, plus the published Silero VAD .onnx), so
// that it can run here is measured rather than assumed. (Saving needs none of these:
// the remuxer copies packets with Mediabunny, in plain JavaScript.)

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';
import {hasExtensionApi} from '../extension-api.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

describe('platform capabilities on this Firefox', function() {
  it('records the audio APIs the voice detector needs', async function() {
    await browser.url(OPENER_URL);
    await browser.execute((u) => window.open(u, '_blank'), ORIGIN +
      '/player/index.html');
    // Switch to the window that shows the extension page, found by its URL: the last
    // handle is not always the new window, and the opener is a plain http:// page, where
    // secure-context APIs (WebCodecs, AudioWorklet) do not exist at all.
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        if ((await browser.getUrl()).startsWith(ORIGIN) && await hasExtensionApi()) return true;
      }
      return false;
    }, {timeout: 15000, timeoutMsg: 'the extension page never opened'});
    await browser.waitUntil(
        async () => browser.execute(() => document.readyState === 'complete'),
        {timeout: 30000, timeoutMsg: 'the extension page never finished loading'});

    const support = await browser.execute(() => {
      const has = (name) => typeof globalThis[name] !== 'undefined';
      return {
        WebAssembly: has('WebAssembly'),
        AudioWorklet: has('AudioWorklet'),
        OfflineAudioContext: has('OfflineAudioContext'),
      };
    });

    console.log('      capabilities:', JSON.stringify(support));

    // The VAD's requirements, which Firefox has had for years.
    expect(support.WebAssembly).toBe(true);
    expect(support.AudioWorklet).toBe(true);
    expect(support.OfflineAudioContext).toBe(true);
  });
});
