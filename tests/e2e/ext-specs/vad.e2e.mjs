// Runs the voice activity detector end to end, for the first time.
//
// Four pieces have to agree here and none of them came from the same place:
//
//   ort.wasm.mjs                  generated from onnxruntime-web@1.20.0, the
//                                 published npm release
//   ort-wasm-simd-threaded.mjs    emscripten glue from an ONNX Runtime build
//                                 off main at 5c74539ab7 (2024-09-03), two
//                                 months before the 1.20.0 tag
//   ort-wasm-simd-threaded.wasm   the matching custom MinSizeRel minimal
//                                 build, 1 MB against the 11 MB npm ships
//   silero_vad_half.ort           silero_vad_half.onnx converted to ORT
//                                 format; see pnpm run verify:vad
//
// A release loader driving a pre-release runtime is exactly the pairing that
// breaks quietly, and nothing in the tree had ever executed it. The VAD is
// reached only from AudioAnalyzerNode, behind subtitle syncing, so a failure
// would surface as a feature that silently does nothing.
//
// This runs on the extension origin deliberately: ORT resolves its wasm
// relative to its own module, and the extension CSP is what actually applies
// when a user hits this code.

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

describe('the voice activity detector', function() {
  it('loads ONNX Runtime and runs the silero model', async function() {
    await browser.url(OPENER_URL);
    await browser.execute(
        (u) => window.open(u, '_blank'), ORIGIN + '/player/index.html');
    await browser.waitUntil(
        async () => (await browser.getWindowHandles()).length > 1,
        {timeout: 15000, timeoutMsg: 'the extension page never opened'});
    const handles = await browser.getWindowHandles();
    await browser.switchToWindow(handles[handles.length - 1]);
    await browser.waitUntil(
        async () => browser.execute(() => document.readyState === 'complete'),
        {timeout: 30000, timeoutMsg: 'the page never finished loading'});

    await browser.execute(() => {
      window.__out = undefined;
      window.__err = undefined;
      (async () => {
        const base = location.origin + '/player/modules/vad/';
        const ort = (await import(base + 'ort.wasm.mjs')).default;
        const model =
          await fetch(base + 'silero_vad_half.ort').then((r) => {
            if (!r.ok) throw new Error('model fetch: ' + r.status);
            return r.arrayBuffer();
          });
        const session = await ort.InferenceSession.create(model);

        // The same call AudioAnalyzerNode makes: 512 samples at 16 kHz, and a
        // zeroed [2,1,128] state. `sr` is commented out in vad.mjs because
        // this model has the rate baked in.
        const run = async (frame, state) => {
          const out = await session.run({
            input: new ort.Tensor('float32', frame, [1, frame.length]),
            state,
          });
          return out;
        };

        const zeroState = () => new ort.Tensor(
            'float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);

        const silence = new Float32Array(512);
        const quiet = await run(silence, zeroState());

        // Noise is not speech either, but it must not produce the identical
        // score - an inference that ignores its input would.
        const noise = new Float32Array(512);
        for (let i = 0; i < noise.length; i++) {
          noise[i] = Math.sin(i * 0.7) * 0.8;
        }
        const loud = await run(noise, zeroState());

        window.__out = {
          inputNames: session.inputNames,
          outputNames: session.outputNames,
          silence: quiet.output.data[0],
          noise: loud.output.data[0],
          stateShape: quiet.stateN ? quiet.stateN.dims : null,
        };
      })().catch((e) => {
        window.__err = (e && e.stack) || String(e);
      });
    });

    await browser.waitUntil(
        async () => browser.execute(
            () => window.__out !== undefined || window.__err !== undefined),
        {timeout: 90000, interval: 500, timeoutMsg: 'the VAD never settled'});

    const {out, err} = await browser.execute(
        () => ({out: window.__out, err: window.__err}));
    if (err) throw new Error('page-side failure: ' + err);

    console.log('      vad:', JSON.stringify(out));

    expect(out.inputNames).toContain('input');
    expect(out.inputNames).toContain('state');
    expect(out.outputNames).toContain('output');
    // A probability, not NaN and not a stuck constant.
    expect(Number.isFinite(out.silence)).toBe(true);
    expect(out.silence).toBeGreaterThanOrEqual(0);
    expect(out.silence).toBeLessThanOrEqual(1);
    // Silence must read as not-speech, or the analyzer would mark the whole
    // track as speech and subtitle syncing would have nothing to align to.
    expect(out.silence).toBeLessThan(0.5);
    // The model must actually look at its input.
    expect(out.noise).not.toBe(out.silence);
    // The recurrent state comes back for the next frame.
    expect(out.stateShape).toEqual([2, 1, 128]);
  });
});
