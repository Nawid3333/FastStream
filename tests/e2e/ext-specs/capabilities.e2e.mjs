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
    await browser.waitUntil(
        async () => (await browser.getWindowHandles()).length > 1,
        {timeout: 15000, timeoutMsg: 'the extension page never opened'});
    const handles = await browser.getWindowHandles();
    await browser.switchToWindow(handles[handles.length - 1]);

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
