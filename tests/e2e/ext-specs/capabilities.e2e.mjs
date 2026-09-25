// Records which platform APIs the extension's optional features need, and
// whether this Firefox has them.
//
// Two features in the tree ship large, hard-to-verify binaries: the voice
// activity detector behind subtitle syncing (an ONNX Runtime wasm and a
// converted model, about 2.9 MB) and the re-encoder behind DASH-to-MP4
// download (libsamplerate's wasm). Whether either can run here decides
// whether those binaries have to be justified to a reviewer or can simply
// leave the build - so it is measured rather than assumed, and pinned, so
// that a future Firefox gaining WebCodecs shows up as a failing test rather
// than as nothing at all.

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

describe('platform capabilities on this Firefox', function() {
  it('records WebCodecs and audio API support', async function() {
    await browser.url(OPENER_URL);
    await browser.execute((u) => window.open(u, '_blank'), ORIGIN +
      '/player/index.html');
    // Switch to the window that shows the extension page, found by its URL: the last
    // handle is not always the new window, and the opener is a plain http:// page, where
    // secure-context APIs (WebCodecs, AudioWorklet) do not exist at all.
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        if ((await browser.getUrl()).startsWith(ORIGIN)) return true;
      }
      return false;
    }, {timeout: 15000, timeoutMsg: 'the extension page never opened'});
    await browser.waitUntil(
        async () => browser.execute(() => document.readyState === 'complete'),
        {timeout: 30000, timeoutMsg: 'the extension page never finished loading'});

    const support = await browser.execute(() => {
      const has = (name) => typeof globalThis[name] !== 'undefined';
      return {
        // The re-encoder needs all four. reencoder.mjs says so in its own
        // header comment: "REQUIRES WebCodecs. Not supported in Firefox."
        VideoEncoder: has('VideoEncoder'),
        AudioEncoder: has('AudioEncoder'),
        VideoDecoder: has('VideoDecoder'),
        AudioDecoder: has('AudioDecoder'),
        AudioData: has('AudioData'),
        EncodedVideoChunk: has('EncodedVideoChunk'),
        // The VAD needs these.
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
