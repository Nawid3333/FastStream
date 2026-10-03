import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {FakeAudioContext} from './fakeWebAudio.mjs';

// How the audio settings learn the video's channel count: a small worklet counts them, and
// every video and every quality switch asks again. A recount that came while the previous
// counter's worklet was still loading left that counter connected and running for the life
// of the audio context; a counter that could not start answered null to the next caller;
// and a missing convolver (no IndexedDB) threw, into a catch that swallowed everything.

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
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({AlertPolyfill: {}}));
vi.mock('../../chrome/player/utils/InterfaceUtils.mjs', () => ({InterfaceUtils: {}}));
vi.mock('../../chrome/player/ui/components/Dropdown.mjs', () => ({}));
vi.mock('../../chrome/player/ui/audio/AudioChannelMixer.mjs', () => ({AudioChannelMixer: class {}}));
vi.mock('../../chrome/player/ui/audio/AudioCrosstalk.mjs', () => ({AudioCrosstalk: class {}}));
vi.mock('../../chrome/player/ui/audio/OutputConvolver.mjs', () => ({OutputConvolver: class {}}));
vi.mock('../../chrome/player/ui/audio/OutputMeter.mjs', () => ({OutputMeter: class {}}));

const {AudioConfigManager} = await import('../../chrome/player/ui/audio/AudioConfigManager.mjs');
const {ChannelUpmixer} = await import('../../chrome/player/ui/audio/ChannelUpmixer.mjs');
const {VirtualAudioNode} = await import('../../chrome/player/ui/audio/VirtualAudioNode.mjs');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The audio settings' channel counting, on a stand-in graph fed by a source node: the
 * rest of the settings (their UI) left out.
 * @return {{manager: AudioConfigManager, ctx: FakeAudioContext, source: Object}}
 */
function setup() {
  const ctx = new FakeAudioContext({maxChannelCount: 6});
  const manager = Object.create(AudioConfigManager.prototype);
  manager.audioContext = ctx;
  manager.inputNode = new VirtualAudioNode('AudioConfigManager input');
  manager.outputNode = new VirtualAudioNode('AudioConfigManager output');
  const source = ctx.node('source');
  manager.inputNode.connectFrom(source);
  manager.audioUpmixer = {updateChannelCount: vi.fn()};
  manager.audioChannelMixer = {updateChannelCount: vi.fn()};
  return {manager, ctx, source};
}

describe('AudioConfigManager: counting the channels', () => {
  let warn;

  beforeEach(() => {
    counters.length = 0;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('leaves no counter running when a recount comes while the last one starts', async () => {
    const {manager, ctx, source} = setup();
    manager.outputConvolver = {updateChannelCount: vi.fn()};
    manager.updateChannelCount();
    manager.updateChannelCount();
    expect(counters).toHaveLength(2);
    const [first, second] = counters;

    first.finishInit();
    second.finishInit();
    await settle();

    // The first, discarded before it started, is not wired in, and stopped.
    expect(first.destroyed).toBe(true);
    expect(manager.inputNode.outputNodes.map(([node]) => node)).not.toContain(first.getNode());
    expect(ctx.outputsOf(source).map((edge) => edge.to.kind)).toEqual(['counter']);

    // The second counts, and is removed once it has.
    second.emit('channelcount', 6);
    await settle();
    expect(second.destroyed).toBe(true);
    expect(ctx.outputsOf(source)).toEqual([]);
    expect(await manager.getInputChannelCount()).toBe(6);
    expect(manager.audioChannelMixer.updateChannelCount).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers 2 every time when the counter cannot start', async () => {
    const {manager} = setup();
    const count = manager.getInputChannelCount();
    counters[0].failInit(new Error('no AudioWorklet'));
    expect(await count).toBe(2);
    expect(await manager.getInputChannelCount()).toBe(2);
  });

  it('updates the channels with no convolver, where IndexedDB is not available', async () => {
    const {manager} = setup();
    manager.outputConvolver = undefined;
    manager.updateChannelCount();
    counters[0].finishInit();
    await settle();
    counters[0].emit('channelcount', 2);
    await settle();
    expect(manager.audioChannelMixer.updateChannelCount).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('ChannelUpmixer', () => {
  it('sets a new output channel count once', () => {
    const ctx = new FakeAudioContext({maxChannelCount: 6});
    const upmixer = new ChannelUpmixer();
    upmixer.setupNodes(ctx);
    upmixer.updateChannelCount(1, 2);
    const mixer = upmixer.mixerNode;
    let sets = 0;
    let channelCount = mixer.channelCount;
    Object.defineProperty(mixer, 'channelCount', {
      get: () => channelCount,
      set: (v) => {
        sets++;
        channelCount = v;
      },
    });

    upmixer.updateChannelCount(2, 6);
    upmixer.updateChannelCount(2, 6);
    expect(channelCount).toBe(6);
    expect(sets).toBe(1);
  });
});
