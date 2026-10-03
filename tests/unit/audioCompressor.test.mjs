import {describe, expect, it, vi} from 'vitest';

import {FakeAudioContext} from './fakeWebAudio.mjs';

// The master compressor on a video with more than two channels, on a stand-in Web Audio
// graph. A DynamicsCompressorNode takes two channels at most, so the front pair goes
// through it and the other channels around it; but the compressor delays what it compresses
// by its 6 ms look-ahead, and the channels around it were not delayed: the centre and the
// surrounds reached the speakers 6 ms before the front pair.

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
 * How long each channel takes from the compressor's splitter to its merger: every path,
 * as [channel in, channel out, seconds].
 * @param {FakeAudioContext} ctx
 * @param {AudioCompressor} compressor
 * @return {Array<number[]>}
 */
function latencies(ctx, compressor) {
  // Firefox's compressor holds back whole frames of its 6 ms look-ahead.
  const lookAhead = Math.floor(0.006 * ctx.sampleRate) / ctx.sampleRate;
  const found = [];
  const walk = (node, channel, delay, start) => {
    for (const edge of ctx.outputsOf(node)) {
      // A splitter passes one channel on each output.
      if (node.kind === 'splitter' && channel !== null && edge.output !== channel) continue;
      let next = node.kind === 'splitter' ? null : channel;
      if (edge.to.kind === 'merger') next = edge.input;
      if (edge.to === compressor.mergerNode) {
        found.push([start, edge.input, delay]);
        continue;
      }
      const added = edge.to.kind === 'delay' ? edge.to.delayTime.value : edge.to.kind === 'compressor' ? lookAhead : 0;
      walk(edge.to, next, delay + added, start);
    }
  };
  for (const edge of ctx.outputsOf(compressor.splitterNode)) {
    const added = edge.to.kind === 'delay' ? edge.to.delayTime.value : 0;
    const channel = edge.to.kind === 'merger' ? edge.input : null;
    if (edge.to === compressor.mergerNode) {
      found.push([edge.output, edge.input, 0]);
    } else {
      walk(edge.to, channel, added, edge.output);
    }
  }
  return found.sort((a, b) => a[0] - b[0]);
}

describe('AudioCompressor: the master compressor on 5.1', () => {
  for (const sampleRate of [48000, 44100]) {
    it(`keeps all six channels in time at ${sampleRate} Hz`, async () => {
      const ctx = new FakeAudioContext({sampleRate, maxChannelCount: 6});
      const compressor = new AudioCompressor('Master ', async () => 6);
      compressor.setupNodes(ctx);
      const config = AudioCompressionControl.default();
      config.enabled = true;
      compressor.setConfig(config);
      await settle();

      const paths = latencies(ctx, compressor);
      expect(paths.map(([from, to]) => [from, to])).toEqual([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
      const front = paths[0][2];
      expect(front).toBeGreaterThan(0.005);
      for (const [, , delay] of paths) {
        expect(delay).toBeCloseTo(front, 9);
      }
    });
  }
});
