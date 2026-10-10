import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {FakeAudioContext} from './fakeWebAudio.mjs';

// How the audio output learns the video's channel count: a small worklet counts them, and
// every video and every quality switch asks again. A recount that came while the previous
// counter's worklet was still loading left that counter connected and running for the life
// of the audio context, and a counter that could not start answered null to the next caller.
// The count sets the output's channels: 5.1 stays 5.1 where the device takes it.

const counters = [];

vi.mock('../../chrome/player/modules/channelcounter/channelcounter.mjs', () => ({
  ChannelCounterNode: class {
    constructor(ctx) {
      this.ctx = ctx;
      this.listeners = {};
      this.destroyed = false;
      this.started = new Promise((resolve, reject) => {
        this.finishInit = () => {
          this.counterNode = ctx.node('counter');
          resolve(this);
        };
        this.failInit = reject;
      });
      counters.push(this);
    }
    init() {
      return this.started;
    }
    getNode() {
      return this.counterNode;
    }
    destroy() {
      if (!this.counterNode) return;
      this.destroyed = true;
      this.counterNode.disconnect();
      this.counterNode = undefined;
    }
    once(name, fn) {
      (this.listeners[name] ||= []).push(fn);
    }
    emit(name, ...args) {
      const fns = this.listeners[name] || [];
      this.listeners[name] = [];
      fns.forEach((fn) => fn(...args));
    }
  },
}));

const {AudioOutput} = await import('../../chrome/player/ui/audio/AudioOutput.mjs');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The audio output on a stand-in graph fed by a source node. Setting it up asks for a
 * count already (counters[0]).
 * @param {number} maxChannelCount - What the output device takes.
 * @return {{output: AudioOutput, ctx: FakeAudioContext, source: Object}}
 */
function setup(maxChannelCount = 6) {
  const ctx = new FakeAudioContext({maxChannelCount});
  const source = ctx.node('source');
  const output = new AudioOutput();
  output.setupNodes(ctx);
  output.getInputNode().connectFrom(source);
  output.getOutputNode().connect(ctx.destination);
  return {output, ctx, source};
}

/**
 * Lets a counter start and report.
 * @param {Object} counter - The stand-in counter.
 * @param {number} count - The channels it counts.
 */
async function count(counter, count) {
  counter.finishInit();
  await settle();
  counter.emit('channelcount', count);
  await settle();
}

describe('AudioOutput: counting the channels', () => {
  let warn;

  beforeEach(() => {
    counters.length = 0;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('gives the output as many channels as the video has', async () => {
    const {ctx} = setup();
    expect(counters).toHaveLength(1);
    await count(counters[0], 6);
    expect(ctx.destination.channelCount).toBe(6);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps 2 channels for mono, and no more than the device takes', async () => {
    const mono = setup();
    await count(counters[0], 1);
    expect(mono.ctx.destination.channelCount).toBe(2);

    counters.length = 0;
    const stereoDevice = setup(2);
    await count(counters[0], 6);
    expect(stereoDevice.ctx.destination.channelCount).toBe(2);
  });

  it('leaves no counter running when a recount comes while the last one starts', async () => {
    const {output, ctx, source} = setup();
    output.updateChannelCount();
    expect(counters).toHaveLength(2);
    const [first, second] = counters;

    first.finishInit();
    second.finishInit();
    await settle();

    // The first, discarded before it started, is not wired in, and stopped.
    expect(first.destroyed).toBe(true);
    expect(output.inputNode.outputNodes.map(([node]) => node)).not.toContain(first.getNode());
    expect(ctx.outputsOf(source).map((edge) => edge.to.kind)).toContain('counter');
    expect(ctx.outputsOf(source).filter((edge) => edge.to.kind === 'counter')).toHaveLength(1);

    // The second counts, and is removed once it has.
    second.emit('channelcount', 6);
    await settle();
    expect(second.destroyed).toBe(true);
    expect(ctx.outputsOf(source).map((edge) => edge.to.kind)).not.toContain('counter');
    expect(await output.getInputChannelCount()).toBe(6);
    expect(ctx.destination.channelCount).toBe(6);
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers 2 every time when the counter cannot start', async () => {
    const {output} = setup();
    const answer = output.getInputChannelCount();
    counters[0].failInit(new Error('no AudioWorklet'));
    expect(await answer).toBe(2);
    expect(await output.getInputChannelCount()).toBe(2);
  });
});

describe('AudioOutput: the volume', () => {
  it('puts a gain in the path only above or below 100 %', () => {
    const {output, ctx, source} = setup();
    const kinds = () => ctx.outputsOf(source).map((edge) => edge.to.kind);
    expect(kinds()).toContain('destination');
    output.updateVolume(2.5);
    expect(kinds()).toContain('gain');
    expect(kinds()).not.toContain('destination');
    expect(output.gain.gainNode.gain.value).toBe(2.5);
  });
});
