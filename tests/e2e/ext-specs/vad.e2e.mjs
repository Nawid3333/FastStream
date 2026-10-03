// Runs the voice activity detector end to end.
//
// Four pieces have to agree here:
//
//   ort.wasm.mjs                  onnxruntime-web's loader, from the npm release
//                                 (tools/sync-vendor.mjs strips its source map)
//   ort-wasm-simd-threaded.mjs    the emscripten glue, from the same release
//   ort-wasm-simd-threaded.wasm   the runtime, from the same release
//   silero_vad_half.onnx          snakers4/silero-vad's published model, byte
//                                 for byte; see pnpm run verify:vad
//
// Until 1.3.82.44 the glue and the wasm were a custom build from a commit two
// months before the loader's release, and a newer loader on them failed (#23).
// The VAD is reached only from AudioAnalyzerNode, behind subtitle syncing, so a
// failure would surface as a feature that silently does nothing - and every
// onnxruntime-web update Dependabot proposes has to pass this.
//
// This runs on the extension origin deliberately: ORT resolves its glue and
// wasm relative to its own modules, and the extension CSP is what actually
// applies when a user hits this code.

import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage, openExtensionPage} from '../extension-page.mjs';
const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

// The scores the runtime shipped until 1.3.82.44 gave for the signal sequence below:
// onnxruntime-web 1.20.0's loader driving a custom build of ONNX Runtime at
// 5c74539ab7, recorded in Firefox before that runtime was replaced by the stock
// onnxruntime-web files. VAD_WRITE_REFERENCE=1 rewrites the file from whatever
// runtime the build now ships - only do that on purpose.
const REFERENCE = path.join(__dirname, '../vad-reference.json');

describe('the voice activity detector', function() {
  it('loads ONNX Runtime and runs the silero model', async function() {
    // Found by its URL, not as the newest handle: that can be the welcome page.
    await openExtensionPage('/player/index.html');

    await browser.execute(() => {
      window.__out = undefined;
      window.__err = undefined;
      (async () => {
        const base = location.origin + '/player/modules/vad/';
        const ort = (await import(base + 'ort.wasm.mjs')).default;
        const model =
          await fetch(base + 'silero_vad_half.onnx').then((r) => {
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
        // Firefox's stack holds only the frames, not the message. ONNX Runtime
        // runs threads only on a cross-origin isolated page, up to half the
        // cores, so say what the page had.
        window.__err = `${String(e)}\n${(e && e.stack) || ''}` +
          `hardwareConcurrency ${navigator.hardwareConcurrency}, ` +
          `crossOriginIsolated ${window.crossOriginIsolated}, ` +
          `SharedArrayBuffer ${typeof SharedArrayBuffer}`;
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

  it('scores a fixed signal sequence the way the reference runtime did', async function() {
    const {out, err} = await inExtensionPage((_, done) => {
      (async () => {
        // The path AudioNodeVAD takes: vad.mjs fetches the model and loads it on
        // ONNX Runtime, then scores 512-sample frames, carrying the recurrent state.
        const {VadJS} = await import(location.origin + '/player/modules/vad/vad.mjs');
        const start = performance.now();
        const model = await VadJS.createModel();
        const initMs = performance.now() - start;

        // 600 frames at 16 kHz, 100 of each kind: silence, noise, a tone sweep,
        // a tremolo tone, a harmonic buzz with a 3 Hz envelope (the kind the model
        // scores as speech) and loud noise. A fixed seed keeps every run identical.
        let seed = 12345;
        const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
        const scores = [];
        let processMs = 0;
        for (let f = 0; f < 600; f++) {
          const kind = Math.floor(f / 100);
          const frame = new Float32Array(512);
          for (let i = 0; i < 512; i++) {
            const t = (f * 512 + i) / 16000;
            const tau = 2 * Math.PI * t;
            if (kind === 1) {
              frame[i] = random() * 0.3;
            } else if (kind === 2) {
              frame[i] = Math.sin(tau * (150 + (f % 100) * 20)) * 0.5;
            } else if (kind === 3) {
              frame[i] = Math.sin(tau * 200) * Math.sin(tau * 4) * 0.7 + random() * 0.05;
            } else if (kind === 4) {
              frame[i] = (Math.sin(tau * 120) + 0.5 * Math.sin(tau * 240) +
                0.3 * Math.sin(tau * 360)) * (0.5 + 0.5 * Math.sin(tau * 3)) * 0.4;
            } else if (kind === 5) {
              frame[i] = random() * 0.9;
            }
          }
          const t0 = performance.now();
          const {isSpeech} = await model.process(frame);
          processMs += performance.now() - t0;
          scores.push(isSpeech);
        }
        done({out: {initMs, msPerFrame: processMs / scores.length, scores}});
      })().catch((e) => done({err: `${String(e)}\n${(e && e.stack) || ''}`}));
    });
    if (err) throw new Error('page-side failure: ' + err);

    const speech = out.scores.filter((s) => s >= 0.5).length;
    console.log(`      vad: model ready in ${out.initMs.toFixed(0)} ms, ` +
      `${out.msPerFrame.toFixed(3)} ms per frame, ${speech} of ${out.scores.length} frames speech`);

    if (process.env.VAD_WRITE_REFERENCE) {
      fs.writeFileSync(REFERENCE, JSON.stringify({scores: out.scores}) + '\n');
      console.log(`      vad: wrote ${REFERENCE}`);
      return;
    }

    const reference = JSON.parse(fs.readFileSync(REFERENCE, 'utf8')).scores;
    expect(out.scores.length).toBe(reference.length);
    let maxDiff = 0;
    let flips = 0;
    out.scores.forEach((score, i) => {
      maxDiff = Math.max(maxDiff, Math.abs(score - reference[i]));
      if ((score >= 0.5) !== (reference[i] >= 0.5)) flips++;
    });
    console.log(`      vad: largest difference from the reference ${maxDiff}, ${flips} decisions changed`);
    // A newer runtime may round differently (1.30.0 against the reference: 3.4e-6
    // at most, measured over 3000 frames), but no frame may change its speech decision.
    // The reference frame nearest the 0.5 threshold is 5.3e-4 away, so a runtime
    // within 1e-4 cannot flip one, and a broken model misses by far more.
    expect(maxDiff).toBeLessThanOrEqual(1e-4);
    expect(flips).toBe(0);
    // The sequence must hold both answers, or it could not catch a model stuck on one.
    expect(speech).toBeGreaterThan(50);
    expect(speech).toBeLessThan(550);
  });
});
