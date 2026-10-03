import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {FakeAudioContext} from './fakeWebAudio.mjs';

// The crosstalk cancellation filter (CrosstalkNode -> ConvolutionXTC), on a stand-in Web
// Audio graph. Each change of its settings builds a new impulse response into the idle one
// of two convolvers and switches to it; the retired convolver was never taken off the
// input, so both ran from the second change on. The colour gain knob's top (20 dB) meant
// no limit at all, over 50 dB of boost with the decay near 0 dB; and the microdelay was
// rounded to whole samples, so most of its range changed nothing.

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/ui/components/Knob.mjs', () => ({createKnob: () => ({})}));

const {CrosstalkNode} = await import('../../chrome/player/modules/crosstalk/crosstalk.mjs');
const {ConvolutionXTC} = await import('../../chrome/player/modules/crosstalk/convolution.mjs');
const {AudioCrosstalk} = await import('../../chrome/player/ui/audio/AudioCrosstalk.mjs');

const N = 4096; // the filter's frequency grid
const SHIFT = 256; // how far the impulse response is delayed to make it causal

/**
 * The response of a filter's impulse response at one frequency bin, the shift taken off.
 * @param {Float32Array} h - The impulse response (N samples).
 * @param {number} k - The bin.
 * @return {number[]} re, im
 */
function dft(h, k) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < N; i++) {
    const x = h[(i + SHIFT) % N];
    re += x * Math.cos(2 * Math.PI * k * i / N);
    im -= x * Math.sin(2 * Math.PI * k * i / N);
  }
  return [re, im];
}

/**
 * The largest gain of a filter's cis and cross responses, in dB.
 * @param {ConvolutionXTC} xtc
 * @return {number}
 */
function peakDb(xtc) {
  let peak = 0;
  for (const H of [xtc.H_CIS, xtc.H_CROSS]) {
    for (let k = 0; k < N; k++) {
      peak = Math.max(peak, Math.hypot(H[2 * k], H[2 * k + 1]));
    }
  }
  return 20 * Math.log10(peak);
}

describe('ConvolutionXTC: the filter', () => {
  const ctx = {sampleRate: 48000};
  const g = Math.pow(10, -3 / 20);

  it('has the response asked for with a delay that is not a whole number of samples', () => {
    const tc = 4.5;
    const xtc = new ConvolutionXTC(ctx, {g, tc, y: Infinity});
    for (const k of [10, 85, 170, 341, 500, 1023]) {
      const [a, b, c, d] = xtc.calculateH(g, 2 * Math.PI * k / N * tc, 0);
      const [re, im] = dft(xtc.h_CIS, k);
      const [reX, imX] = dft(xtc.h_CROSS, k);
      expect(Math.hypot(re - a, im - b)).toBeLessThan(1e-3 * Math.hypot(a, b) + 1e-4);
      expect(Math.hypot(reX - c, imX - d)).toBeLessThan(1e-3 * Math.hypot(c, d) + 1e-4);
    }
  });

  it('keeps the filter it had for a delay of whole samples', () => {
    const tc = 6;
    const xtc = new ConvolutionXTC(ctx, {g, tc, y: Infinity});
    // What the formula gave over the whole grid before.
    for (let k = 0; k < N; k += 7) {
      const [a, b, c, d] = xtc.calculateH(g, 2 * Math.PI * k / N * tc, 0);
      expect(xtc.H_CIS[2 * k]).toBeCloseTo(a, 5);
      expect(xtc.H_CIS[2 * k + 1]).toBeCloseTo(b, 5);
      expect(xtc.H_CROSS[2 * k]).toBeCloseTo(c, 5);
      expect(xtc.H_CROSS[2 * k + 1]).toBeCloseTo(d, 5);
    }
  });
});

describe('AudioCrosstalk: the settings the filter gets', () => {
  it('boosts no frequency by more than the colour gain knob\'s top, 20 dB', () => {
    const crosstalk = Object.create(AudioCrosstalk.prototype);
    crosstalk.speakerDistance = 30;
    crosstalk.headDistance = 60;
    crosstalk.crosstalkConfig = {enabled: true, decay: -0.01, colorgain: 20, microdelay: 125, lowbypass: 200, highbypass: 6000};
    const options = crosstalk.getCrosstalkConfigObj();
    const xtc = new ConvolutionXTC({sampleRate: 48000}, {g: options.decay, tc: options.microdelay * 48000 * 1e-6, y: options.colorgain});
    expect(peakDb(xtc)).toBeLessThanOrEqual(20);
  });
});

describe('CrosstalkNode: switching convolvers', () => {
  let ctx;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = new FakeAudioContext();
    // Built with `new IIRFilterNode(ctx, options)`; a constructor that returns an object
    // gives that object.
    vi.stubGlobal('IIRFilterNode', function(context, options) {
      return context.node('iir', options);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const settings = (colorgain) => ({microdelay: 90, decay: 0.9, colorgain, lowbypass: 250, highbypass: 5000});

  it('feeds only the convolver in use, after any number of changes', async () => {
    const node = new CrosstalkNode(ctx, settings(3));
    await node.init();
    node.getOutputNode().connect(ctx.destination);
    vi.advanceTimersByTime(500);
    const convolvers = node.xtc.convolvers_XTC;
    const fed = () => convolvers.filter((convolver) => ctx.inputsOf(convolver).length > 0);
    const heard = () => convolvers.filter((convolver) => ctx.outputsOf(convolver).length > 0);

    for (const colorgain of [4, 5, 6]) {
      node.configure(settings(colorgain));
      vi.advanceTimersByTime(500);
      expect(fed()).toEqual([convolvers[node.xtc.currentConvolver]]);
      expect(heard()).toEqual([convolvers[node.xtc.currentConvolver]]);
    }

    node.destroy();
    expect(convolvers.flatMap((convolver) => ctx.inputsOf(convolver))).toEqual([]);
  });
});
