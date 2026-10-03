import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {FakeAudioContext} from './fakeWebAudio.mjs';

// The crosstalk cancellation filter (CrosstalkNode -> ConvolutionXTC), on a stand-in Web
// Audio graph. Each change of its settings builds a new impulse response into the idle one
// of two convolvers and switches to it; the retired convolver was never taken off the
// input, so both ran from the second change on. The colour gain knob's top (20 dB) meant
// no limit at all, over 50 dB of boost with the decay near 0 dB.

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/ui/components/Knob.mjs', () => ({createKnob: () => ({})}));

const {CrosstalkNode} = await import('../../chrome/player/modules/crosstalk/crosstalk.mjs');
const {ConvolutionXTC} = await import('../../chrome/player/modules/crosstalk/convolution.mjs');
const {AudioCrosstalk} = await import('../../chrome/player/ui/audio/AudioCrosstalk.mjs');

const N = 4096; // the filter's frequency grid

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
