import {describe, expect, it, vi} from 'vitest';

import {FakeAudioContext} from './fakeWebAudio.mjs';

// Audio profiles come from storage and from imported .fsprofile.json files, and nothing
// checked them. A value that was not a number reached an AudioParam, which throws on NaN:
// the equalizer had already taken its old filters out, so the channel went silent; a
// channel ID out of range left the mixer without a channel and it threw; an unknown filter
// type stayed a lowpass. The default profiles load exactly as before.

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));

const {AudioProfile, MAX_AUDIO_CHANNELS} = await import('../../chrome/player/ui/audio/config/AudioProfile.mjs');
const {AudioCrosstalkControl} = await import('../../chrome/player/ui/audio/config/AudioCrosstalkControl.mjs');
const {AudioEQNode} = await import('../../chrome/player/ui/audio/config/AudioEQNode.mjs');
const {DefaultProfilesData} = await import('../../chrome/player/ui/audio/config/DefaultProfiles.mjs');
const {AudioEqualizer} = await import('../../chrome/player/ui/audio/AudioEqualizer.mjs');
const {AbstractAudioModule} = await import('../../chrome/player/ui/audio/AbstractAudioModule.mjs');

/**
 * An equalizer on a stand-in graph, between a source and the destination, its UI left out.
 * @return {{equalizer: AudioEqualizer, ctx: FakeAudioContext, source: Object}}
 */
function equalizerOnGraph() {
  const ctx = new FakeAudioContext();
  const equalizer = Object.create(AudioEqualizer.prototype);
  AbstractAudioModule.prototype.setupNodes.call(equalizer, ctx);
  equalizer.equalizerNodes = [];
  equalizer.renderEqualizerResponse = () => {};
  equalizer.updateEqualizerNodeMarkers = () => {};
  const source = ctx.node('source');
  equalizer.getInputNode().connectFrom(source);
  equalizer.getOutputNode().connect(ctx.destination);
  equalizer.getInputNode().connect(equalizer.getOutputNode());
  return {equalizer, ctx, source};
}

/**
 * Whether sound gets from one node to another on the stand-in graph.
 * @param {FakeAudioContext} ctx
 * @param {Object} from
 * @param {Object} to
 * @return {boolean}
 */
function reaches(ctx, from, to) {
  if (from === to) return true;
  return ctx.outputsOf(from).some((edge) => reaches(ctx, edge.to, to));
}

const broken = {
  id: 5,
  label: 'Broken',
  channels: [
    {id: 0, gain: 'loud', equalizerNodes: [
      {type: 'peaking', frequency: 'abc', gainDb: 3, q: 1},
      {type: 'bogus', frequency: 1000, gainDb: 3, q: 1},
      {type: 'lowshelf', frequency: 100, q: 1},
      {type: 'highshelf', frequency: 8000, gainDb: 2, q: 'wide'},
    ]},
    {id: 1, gain: 0.5},
    {id: 1, gain: 2},
    {id: 3, gain: 1e9, muted: 'yes'},
    {id: 4, gain: -1},
    {id: 7, gain: 1},
  ],
  master: {gain: null, mono: 1, equalizerNodes: 'none', compressor: {enabled: true, threshold: 'x', ratio: 50, attack: null, gain: 1e6}},
  crosstalk: {enabled: true, decay: null, colorgain: null, microdelay: 'far', lowbypass: 'x', highbypass: 1e9},
};

describe('AudioProfile.fromObj: profiles from storage and files', () => {
  it('loads the default profiles as they are', () => {
    for (const data of DefaultProfilesData.profiles) {
      const profile = AudioProfile.fromObj(data);
      expect(AudioProfile.fromObj(profile.toObj()).toObj()).toEqual(profile.toObj());
      if (data.master) {
        expect(profile.master.toObj()).toEqual({...data.master, id: 'master'});
      }
    }
  });

  it('gives a broken profile one channel per ID with usable values', () => {
    const profile = AudioProfile.fromObj(broken);
    expect(profile.channels.map((channel) => channel.id)).toEqual(Array.from({length: MAX_AUDIO_CHANNELS}, (_, i) => i));
    expect(profile.channels.map((channel) => channel.gain)).toEqual([1, 0.5, 1, Math.pow(10, 10 / 20), 0, 1]);
    expect(profile.channels[3].muted).toBe(true);
    expect(profile.channels[0].equalizerNodes.map((node) => node.toObj())).toEqual([
      {type: 'lowshelf', frequency: 100, gainDb: 0, q: 1},
      {type: 'highshelf', frequency: 8000, gainDb: 2, q: 1},
    ]);

    expect(profile.master.isMaster()).toBe(true);
    expect(profile.master.gain).toBe(1);
    expect(profile.master.mono).toBe(true);
    expect(profile.master.equalizerNodes).toEqual([]);
    expect(profile.master.compressor.toObj()).toEqual({
      enabled: true, attack: 0.003, knee: 30, ratio: 20, release: 0.25, threshold: -24, gain: 10,
    });

    const crosstalk = profile.crosstalk;
    expect(Number.isNaN(crosstalk.decay)).toBe(true);
    expect(Number.isNaN(crosstalk.microdelay)).toBe(true);
    expect([crosstalk.colorgain, crosstalk.lowbypass, crosstalk.highbypass]).toEqual([5, 200, 20000]);
  });

  // A file edited by hand, or from an older version: what it has is kept (review).
  it('keeps what a profile from a file has: more channels, no label, an EQ gain by its old name', () => {
    const channels = Array.from({length: 8}, (_, i) => ({id: i, gain: 0.5}));
    const profile = AudioProfile.fromObj({id: 3, channels,
      equalizerNodes: [{type: 'peaking', frequency: 1000, gain: 5, gainDb: null}]});
    expect(profile.channels.map((channel) => channel.gain)).toEqual(Array(MAX_AUDIO_CHANNELS).fill(0.5));
    expect(profile.label).toBe('Profile 3');
    expect(profile.master.equalizerNodes.map((node) => node.toObj().gainDb)).toEqual([5]);
  });

  it('takes the seventh mixer channel of an old profile as its master', () => {
    const mixerChannels = Array.from({length: 7}, (_, i) => ({id: i, gain: 1}));
    mixerChannels[6].mono = true;
    const profile = AudioProfile.fromObj({id: 1, mixerChannels});
    expect(profile.master.isMaster()).toBe(true);
    expect(profile.master.mono).toBe(true);
    expect(profile.channels.map((channel) => channel.id)).toEqual(Array.from({length: MAX_AUDIO_CHANNELS}, (_, i) => i));
  });

  it('builds every equalizer of a broken profile without a value the browser refuses', () => {
    const profile = AudioProfile.fromObj(broken);
    for (const channel of [...profile.channels, profile.master]) {
      const {equalizer} = equalizerOnGraph();
      equalizer.equalizerConfig = channel.equalizerNodes;
      expect(() => equalizer.refreshEQNodes()).not.toThrow();
    }
  });

  it('keeps the crosstalk decay and microdelay worked out from the distances through a save', () => {
    const control = AudioCrosstalkControl.default();
    control.enabled = true;
    const saved = JSON.parse(JSON.stringify(control.toObj()));
    expect(saved.decay).toBeNull();
    const loaded = AudioCrosstalkControl.fromObj(saved);
    expect(Number.isNaN(loaded.decay)).toBe(true);
    expect(Number.isNaN(loaded.microdelay)).toBe(true);
  });
});

describe('AudioEqualizer.refreshEQNodes', () => {
  it('leaves the sound on when a filter value is refused', () => {
    const {equalizer, ctx, source} = equalizerOnGraph();
    equalizer.equalizerConfig = [new AudioEQNode('peaking', 1000, 3, 1)];
    equalizer.refreshEQNodes();
    expect(reaches(ctx, source, ctx.destination)).toBe(true);

    equalizer.equalizerConfig = [new AudioEQNode('peaking', NaN, 3, 1)];
    expect(() => equalizer.refreshEQNodes()).toThrow(TypeError);
    expect(reaches(ctx, source, ctx.destination)).toBe(true);
  });
});
