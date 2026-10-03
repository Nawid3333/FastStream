import {describe, expect, it, vi} from 'vitest';

import {FakeAudioContext} from './fakeWebAudio.mjs';

// The audio mixer's channel strips, on stand-in elements. The mute button's lit state was
// toggled from `channel.mute`, a field that does not exist: classList.toggle(name,
// undefined) flips, so it only matched while nothing else changed `muted`.
// The meters: each frame set the size of all seven canvases, which clears a canvas and
// resets its context even when the size is the same; and the clip check read half of the
// analyser's window, the older half, so a clip in the newer half went unseen.

const {el} = vi.hoisted(() => {
  const el = () => {
    const classes = new Set();
    const listeners = {};
    return {
      listeners,
      style: {},
      dataset: {},
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
          const on = force === undefined ? !classes.has(name) : !!force;
          if (on) classes.add(name); else classes.delete(name);
          return on;
        },
      },
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      appendChild() {},
      replaceChildren() {},
      getContext: () => ({}),
    };
  };
  return {el};
});

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {playerContainer: el()}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/utils/WebUtils.mjs', () => ({WebUtils: {create: () => el(), setupTabIndex() {}, setLabels() {}}}));
vi.mock('../../chrome/player/ui/components/Knob.mjs', () => ({createKnob: () => ({container: el(), knob: {val() {}}})}));
// The equalizers' drawing is not what these tests are about: a pass-through stand-in.
vi.mock('../../chrome/player/ui/audio/AudioEqualizer.mjs', async () => {
  const {AbstractAudioModule} = await import('../../chrome/player/ui/audio/AbstractAudioModule.mjs');
  return {AudioEqualizer: class extends AbstractAudioModule {
    setupNodes(ctx) {
      super.setupNodes(ctx);
      this.getInputNode().connect(this.getOutputNode());
    }
    setConfig(config) {
      this.config = config;
    }
    hasNodes() {
      return false;
    }
    getElement() {
      return el();
    }
    render() {}
  }};
});

const {AudioChannelMixer} = await import('../../chrome/player/ui/audio/AudioChannelMixer.mjs');
const {AudioChannelControl} = await import('../../chrome/player/ui/audio/config/AudioChannelControl.mjs');
const {AudioUtils} = await import('../../chrome/player/utils/AudioUtils.mjs');
const {AudioProfile} = await import('../../chrome/player/ui/audio/config/AudioProfile.mjs');

describe('AudioChannelMixer: a channel strip', () => {
  it('lights the mute button when, and only when, the channel is muted', () => {
    const mixer = Object.create(AudioChannelMixer.prototype);
    mixer.updateNodes = vi.fn();
    const channel = AudioChannelControl.default(0);
    const els = mixer.createMixerChannel(channel);
    const click = () => els.muteButton.listeners.click.forEach((fn) => fn({}));

    click();
    expect(channel.muted).toBe(true);
    expect(els.muteButton.classList.contains('active')).toBe(true);

    // Unmuted elsewhere while the strip is shown, then muted with the button.
    channel.muted = false;
    click();
    expect(channel.muted).toBe(true);
    expect(els.muteButton.classList.contains('active')).toBe(true);
  });
});

/**
 * An AnalyserNode of 256 samples holding the given window, as the browser hands it out:
 * an array shorter than the window gets its first (oldest) samples.
 * @param {Float32Array} samples - The last 256 samples, oldest first.
 * @return {Object}
 */
function analyser(samples = new Float32Array(256)) {
  return {
    fftSize: 256,
    frequencyBinCount: 128,
    minDecibels: -100,
    maxDecibels: -30,
    context: {sampleRate: 48000},
    getFloatTimeDomainData: (array) => array.set(samples.subarray(0, array.length)),
    getByteFrequencyData: (array) => array.fill(100),
  };
}

/**
 * A canvas of 10.5 x 100 CSS pixels that counts how often its size is set.
 * @return {Object}
 */
function canvas() {
  const c = {clientWidth: 10.5, clientHeight: 100, sets: 0, w: 300, h: 150};
  Object.defineProperty(c, 'width', {
    get: () => c.w,
    set: (v) => {
      c.sets++;
      c.w = Math.trunc(v);
    },
  });
  Object.defineProperty(c, 'height', {
    get: () => c.h,
    set: (v) => {
      c.sets++;
      c.h = Math.trunc(v);
    },
  });
  return c;
}

const context2d = () => ({clearRect() {}, fillRect() {}});

describe('AudioChannelMixer: the meters', () => {
  it('sizes each meter canvas once, not every frame', () => {
    vi.stubGlobal('window', {devicePixelRatio: 1});
    try {
      const mixer = Object.create(AudioChannelMixer.prototype);
      const els = {volumeMeter: canvas(), volumeMeterCtx: context2d()};
      const nodes = {analyzer: analyser()};
      const master = {volumeMeter: canvas(), volumeMeterCtx: context2d()};
      mixer.outputMeterCache = [];
      mixer.configManager = {getOutputMeter: () => ({
        getMeterData: () => [{volume: -60, isClipping: false}, {volume: -50, isClipping: false}],
        minDecibels: -100,
        maxDecibels: -30,
      })};
      for (let frame = 0; frame < 3; frame++) {
        mixer.renderChannel(nodes, els, true);
        mixer.renderMaster(master);
      }
      expect([els.volumeMeter.w, els.volumeMeter.h]).toEqual([10, 100]);
      expect(els.volumeMeter.sets).toBe(2);
      // The master meter is drawn at twice the width.
      expect([master.volumeMeter.w, master.volumeMeter.h]).toEqual([21, 100]);
      expect(master.volumeMeter.sets).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sees a clip anywhere in the analyser\'s window', () => {
    const samples = new Float32Array(256);
    samples[200] = 1.2;
    expect(AudioUtils.isClipping(analyser(samples))).toBe(true);
    samples[200] = 0.9;
    samples[20] = -1.2;
    expect(AudioUtils.isClipping(analyser(samples))).toBe(true);
    samples[20] = 0;
    expect(AudioUtils.isClipping(analyser(samples))).toBe(false);
  });
});

describe('AudioChannelMixer: channels with and without a compressor', () => {
  /**
   * A mixer on a 5.1 stand-in graph, between a source and the destination.
   * @return {{mixer: AudioChannelMixer, ctx: FakeAudioContext}}
   */
  function mixerOn51() {
    const ctx = new FakeAudioContext({maxChannelCount: 6});
    const mixer = new AudioChannelMixer({
      getChannelCount: async () => 6,
      getOutputMeter: () => ({updateChannelCount() {}, createAnalysers() {}, destroyAnalysers() {}}),
    });
    mixer.setupUI(el(), el());
    // Hidden: no meters.
    mixer.ui.mixer.offsetParent = null;
    mixer.setupNodes(ctx);
    mixer.getInputNode().connectFrom(ctx.node('source'));
    mixer.getOutputNode().connect(ctx.destination);
    return {mixer, ctx};
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('keeps every channel in time when only the centre is compressed', async () => {
    const {mixer, ctx} = mixerOn51();
    const profile = new AudioProfile(1);
    profile.channels[2].compressor.enabled = true;
    mixer.setConfig(profile);
    await settle();

    const paths = ctx.channelPaths(mixer.channelSplitter, mixer.channelMerger);
    expect(paths.map((path) => [path.from, path.to])).toEqual([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
    expect(paths.map((path) => path.compressors.length)).toEqual([0, 0, 1, 0, 0, 0]);
    for (const path of paths) {
      expect(path.delay).toBe(ctx.compressorLookAhead);
    }

    // With no compressor on, no channel waits.
    profile.channels[2].compressor.enabled = false;
    await mixer.channelNodes[2].compressor.updateCompressor();
    mixer.channelNodes[2].compressor.emit('change');
    await settle();
    expect(ctx.edges.some((edge) => edge.to.kind === 'delay' || edge.from.kind === 'delay')).toBe(false);
  });
});
