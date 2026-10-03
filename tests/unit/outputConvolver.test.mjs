import {describe, expect, it, vi} from 'vitest';

import {FakeAudioContext} from './fakeWebAudio.mjs';

// The output convolver (impulse responses for the output device), on a stand-in Web Audio
// graph. Every quality switch and every checkbox rebuilt its settings and gave each
// convolver its impulse response again, which restarts the convolution (a click); and a
// stored impulse length that was not a number kept the whole file as the impulse response.

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({AlertPolyfill: {}}));
vi.mock('../../chrome/player/network/IndexedDBManager.mjs', () => ({IndexedDBManager: class {}}));
vi.mock('../../chrome/player/ui/components/Dropdown.mjs', () => ({}));

const {OutputConvolver} = await import('../../chrome/player/ui/audio/OutputConvolver.mjs');
const {AbstractAudioModule} = await import('../../chrome/player/ui/audio/AbstractAudioModule.mjs');
const {AudioConvolverControl, AudioConvolverProfile} = await import('../../chrome/player/ui/audio/config/AudioConvolverControl.mjs');

/**
 * An output convolver on a stereo stand-in graph with an impulse response on both
 * channels, its UI left out.
 * @return {{convolver: OutputConvolver, ctx: FakeAudioContext}}
 */
function stereoConvolver() {
  const ctx = new FakeAudioContext();
  const convolver = Object.create(OutputConvolver.prototype);
  AbstractAudioModule.prototype.setupNodes.call(convolver, ctx);
  convolver.getInputNode().connect(convolver.getOutputNode());
  convolver.configManager = {getChannelCount: async () => 2};
  convolver.config = AudioConvolverControl.default();
  convolver.config.enabled = true;
  convolver.currentProfile = convolver.config.profiles[0];
  convolver.currentProfile.channels[0].enabled = true;
  convolver.currentProfile.channels[1].enabled = true;
  convolver.convolverChannels = Array.from({length: 6}, (_, id) => ({
    id,
    label: {classList: {add() {}, remove() {}}},
    impulseBuffer: id < 2 ? ctx.createBuffer(1, 512, 48000) : null,
  }));
  return {convolver, ctx};
}

describe('OutputConvolver', () => {
  it('gives each convolver its impulse response only when it changes', async () => {
    const {convolver, ctx} = stereoConvolver();
    await convolver.updateNodes();
    await convolver.updateNodes();
    await convolver.updateChannelCount();
    const nodes = ctx.nodes.filter((node) => node.kind === 'convolver');
    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.bufferSets)).toEqual([1, 1]);

    // A new setting takes effect.
    convolver.currentProfile.channels[0].normalize = true;
    await convolver.updateNodes();
    expect(nodes.map((node) => node.bufferSets)).toEqual([2, 1]);
    expect(nodes[0].normalize).toBe(true);
  });

  it('keeps a stored impulse length within what the field allows', () => {
    const length = (bufferSize) => AudioConvolverProfile.fromObj({id: 0, label: 'P', bufferSize}).bufferSize;
    expect(length('abc')).toBe(4096);
    expect(length(null)).toBe(4096);
    expect(length(10)).toBe(128);
    expect(length(1e9)).toBe(16384);
    expect(length(2048)).toBe(2048);
  });
});
