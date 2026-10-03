import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {FakeAudioContext} from './fakeWebAudio.mjs';

// The crosstalk cancellation filter (CrosstalkNode -> ConvolutionXTC), on a stand-in Web
// Audio graph. Each change of its settings builds a new impulse response into the idle one
// of two convolvers and switches to it; the retired convolver was never taken off the
// input, so both ran from the second change on.

const {CrosstalkNode} = await import('../../chrome/player/modules/crosstalk/crosstalk.mjs');

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
