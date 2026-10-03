import {describe, expect, it, vi} from 'vitest';

import {FakeAudioContext} from './fakeWebAudio.mjs';

// The master compressor on a video with more than two channels, on a stand-in Web Audio
// graph. A DynamicsCompressorNode takes two channels at most, so only the front pair went
// through it: the centre, the LFE and the surrounds were not compressed at all, and as the
// compressor delays what it compresses by its 6 ms look-ahead, they also reached the
// speakers 6 ms before the front pair. Every channel now has a compressor (a pair of
// speakers shares one, the centre and the LFE have one each). A channel compressor that is
// off can wait as long as one that is on (setLatencyMatch, for the mixer). Stereo is built
// as before.

const el = () => ({
  style: {},
  classList: {add() {}, remove() {}, toggle() {}},
  appendChild() {},
  replaceChildren() {},
  addEventListener() {},
  getContext: () => ({}),
});
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/utils/WebUtils.mjs', () => ({WebUtils: {create: () => el(), setupTabIndex() {}}}));
vi.mock('../../chrome/player/ui/components/Knob.mjs', () => ({createKnob: () => ({container: el(), knob: {val() {}}})}));

const {AudioCompressor} = await import('../../chrome/player/ui/audio/AudioCompressor.mjs');
const {AudioCompressionControl} = await import('../../chrome/player/ui/audio/config/AudioCompressionControl.mjs');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A compressor between a source and the destination of a stand-in graph.
 * @param {number} channels - What its channel count getter answers.
 * @param {number} [sampleRate=48000]
 * @return {Promise<{compressor: AudioCompressor, ctx: FakeAudioContext, source: Object}>}
 */
async function compressorOn(channels, sampleRate = 48000) {
  const ctx = new FakeAudioContext({sampleRate, maxChannelCount: 8});
  const compressor = new AudioCompressor('Master ', async () => channels);
  compressor.setupNodes(ctx);
  const source = ctx.node('source');
  compressor.getInputNode().connectFrom(source);
  compressor.getOutputNode().connect(ctx.destination);
  const config = AudioCompressionControl.default();
  config.enabled = true;
  config.threshold = -30;
  config.gain = 2;
  compressor.setConfig(config);
  await settle();
  return {compressor, ctx, source};
}

describe('AudioCompressor: the master compressor on more than two channels', () => {
  it('compresses every channel of 5.1, the centre and the LFE on their own', async () => {
    const {compressor, ctx} = await compressorOn(6);
    const paths = ctx.channelPaths(compressor.splitterNode, compressor.mergerNode);
    expect(paths.map((path) => [path.from, path.to])).toEqual([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
    expect(paths.every((path) => path.compressors.length === 1)).toBe(true);
    // Which channels share a compressor.
    const compressors = ctx.nodes.filter((node) => node.kind === 'compressor');
    const groups = compressors.map((node) => paths.filter((path) => path.compressors[0] === node).map((path) => path.from));
    expect(groups).toEqual([[0, 1], [2], [3], [4, 5]]);
  });

  for (const [channels, groups] of [[3, [[0, 1], [2]]], [4, [[0, 1], [2, 3]]], [5, [[0, 1], [2], [3, 4]]]]) {
    it(`compresses every channel of a ${channels}-channel source`, async () => {
      const {compressor, ctx} = await compressorOn(channels);
      const paths = ctx.channelPaths(compressor.splitterNode, compressor.mergerNode);
      expect(paths.map((path) => [path.from, path.to])).toEqual(Array.from({length: channels}, (_, i) => [i, i]));
      const compressors = ctx.nodes.filter((node) => node.kind === 'compressor');
      expect(compressors.map((node) => paths.filter((path) => path.compressors.includes(node)).map((path) => path.from))).toEqual(groups);
    });
  }

  for (const sampleRate of [48000, 44100]) {
    it(`keeps all six channels in time at ${sampleRate} Hz`, async () => {
      const {compressor, ctx} = await compressorOn(6, sampleRate);
      const paths = ctx.channelPaths(compressor.splitterNode, compressor.mergerNode);
      expect(paths).toHaveLength(6);
      for (const path of paths) {
        expect(path.delay).toBe(ctx.compressorLookAhead);
      }
    });
  }

  it('gives every compressor the settings', async () => {
    const {ctx} = await compressorOn(6);
    const compressors = ctx.nodes.filter((node) => node.kind === 'compressor');
    expect(compressors.map((node) => node.threshold.value)).toEqual([-30, -30, -30, -30]);
    const gains = ctx.nodes.filter((node) => node.kind === 'gain' && ctx.inputsOf(node).some((edge) => edge.from.kind === 'compressor'));
    expect(gains.map((node) => node.gain.value)).toEqual([2, 2, 2, 2]);
  });

  it('goes back to a straight path when it is switched off', async () => {
    const {compressor, ctx, source} = await compressorOn(6);
    compressor.compressorConfig.enabled = false;
    await compressor.updateCompressor();
    expect(ctx.outputsOf(source).map((edge) => edge.to)).toEqual([ctx.destination]);
  });
});

describe('AudioCompressor: stereo', () => {
  it('is built as before: source, compressor, gain, out', async () => {
    const {ctx, source} = await compressorOn(2);
    const kinds = (edges) => edges.map((edge) => `${edge.from.kind}:${edge.output} -> ${edge.to.kind}:${edge.input}`).sort();
    expect(kinds(ctx.edges)).toEqual([
      'compressor:0 -> gain:0',
      'gain:0 -> destination:0',
      'source:0 -> compressor:0',
    ]);
    expect(ctx.outputsOf(source)[0].to.threshold.value).toBe(-30);
  });
});

describe('AudioCompressor: a channel compressor that is off, next to one that is on', () => {
  it('waits as long as a compressor would, and only while asked to and off', async () => {
    // 44.1 kHz: the look-ahead is whole frames, 264, not 6 ms.
    const ctx = new FakeAudioContext({sampleRate: 44100});
    const compressor = new AudioCompressor('Center ');
    compressor.setupNodes(ctx);
    const source = ctx.node('source');
    compressor.getInputNode().connectFrom(source);
    compressor.getOutputNode().connect(ctx.destination);
    const config = AudioCompressionControl.default();
    compressor.setConfig(config);
    await settle();
    const path = () => ctx.outputsOf(source).map((edge) => edge.to.kind);

    expect(path()).toEqual(['destination']);
    compressor.setLatencyMatch(true);
    expect(path()).toEqual(['delay']);
    expect(ctx.outputsOf(source)[0].to.delayTime.value).toBe(ctx.compressorLookAhead);

    // Switched on, the compressor itself waits; switched off again, the delay is back.
    config.enabled = true;
    await compressor.updateCompressor();
    expect(path()).toEqual(['compressor']);
    config.enabled = false;
    await compressor.updateCompressor();
    expect(path()).toEqual(['delay']);

    compressor.setLatencyMatch(false);
    expect(path()).toEqual(['destination']);
  });
});
