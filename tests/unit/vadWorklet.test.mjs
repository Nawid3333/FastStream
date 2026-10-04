import vm from 'node:vm';
import {describe, expect, it} from 'vitest';

// The worklet's text, as a module of this repository (vite's ?raw): running what a file read
// returned is CodeQL's js/code-injection.
import source from '../../chrome/player/modules/vad/vad.worklet.mjs?raw';

// vad.worklet.mjs runs on the audio thread: it brings 128-sample blocks at the output's rate
// down to the 16 kHz the voice model takes, in frames of 512, and posts each frame. It
// averaged each output sample's span of input (a box filter), so a tone above 8 kHz came
// out as a lower one at a third of its level (#202).

const FRAME = 512;

/**
 * Runs the worklet's processor at a sample rate on a signal, block by block.
 * @param {number} rate - The audio context's sample rate.
 * @param {function(number): number} signal - The input at a time, in seconds.
 * @param {number} seconds - How long to run.
 * @return {Float32Array} Every 16 kHz sample it posted, in order.
 */
function run(rate, signal, seconds) {
  let Processor;
  const context = {
    sampleRate: rate,
    console,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {posted: [], postMessage(message) {
          this.posted.push(message);
        }};
      }
    },
    registerProcessor: (name, processor) => {
      Processor = processor;
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  // The processor takes the audio thread's Float32Arrays, of its own realm.
  const Float32ArrayThere = vm.runInContext('Float32Array', context);
  const processor = new Processor({processorOptions: {frameSamples: FRAME}});
  const blocks = Math.floor(seconds * rate / 128);
  for (let b = 0; b < blocks; b++) {
    const block = new Float32ArrayThere(128);
    for (let i = 0; i < 128; i++) {
      block[i] = signal((b * 128 + i) / rate);
    }
    expect(processor.process([[block]], [], {})).toBe(true);
  }
  const frames = processor.port.posted.map((message) => new Float32Array(message.data));
  for (const frame of frames) {
    expect(frame).toHaveLength(FRAME);
  }
  const out = new Float32Array(frames.length * FRAME);
  frames.forEach((frame, i) => out.set(frame, i * FRAME));
  return out;
}

/**
 * @param {Float32Array} samples
 * @param {number} from - The first sample to count.
 * @return {number} Their root mean square.
 */
function rms(samples, from) {
  let sum = 0;
  for (let i = from; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length - from));
}

const tone = (hz, level = 0.5) => (t) => level * Math.sin(2 * Math.PI * hz * t);

describe('the voice detector\'s resampler', () => {
  it.each([48000, 44100, 96000])('makes 16000 samples a second at %i Hz, in frames of 512', (rate) => {
    const out = run(rate, tone(1000), 2);
    // Two seconds, less the filter's reach and the frame not yet full.
    expect(out.length).toBeGreaterThanOrEqual(32000 - 2 * FRAME);
    expect(out.length).toBeLessThanOrEqual(32000);
  });

  it.each([48000, 44100])('keeps a 1 kHz tone at %i Hz as it was, in level and in time', (rate) => {
    const out = run(rate, tone(1000), 1);
    expect(out.length).toBeGreaterThan(15000);
    // Each output sample is the input at its own time: 16 kHz sample k is time k / 16000.
    let worst = 0;
    for (let k = 100; k < out.length; k++) {
      worst = Math.max(worst, Math.abs(out[k] - tone(1000)(k / 16000)));
    }
    expect(worst).toBeLessThan(0.01);
  });

  it.each([[48000, 12000], [48000, 10000], [44100, 10000], [96000, 20000]])(
      'does not fold a tone above 8 kHz back into the speech band (%i Hz, a %i Hz tone)', (rate, hz) => {
        // The box filter let a 12 kHz tone at 48 kHz through at a third of its level, as 4 kHz.
        const out = run(rate, tone(hz), 1);
        expect(out.length).toBeGreaterThan(15000);
        // Under 1% of the tone's own level (0.5 / sqrt 2).
        expect(rms(out, 100)).toBeLessThan(0.01 * 0.5 / Math.SQRT2);
      });

  it('starts from silence, not from what its buffer held', () => {
    const out = run(48000, () => 0, 0.2);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((sample) => sample === 0)).toBe(true);
  });
});
