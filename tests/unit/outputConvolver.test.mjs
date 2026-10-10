import {describe, expect, it, vi} from 'vitest';

import {FakeAudioContext} from './fakeWebAudio.mjs';

// The output convolver (impulse responses for the output device), on a stand-in Web Audio
// graph. Every quality switch and every checkbox rebuilt its settings and gave each
// convolver its impulse response again, which restarts the convolution (a click); a stored
// impulse length that was not a number kept the whole file as the impulse response; and a
// file that did not decode was reported with the window's name instead of its own.

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({AlertPolyfill: {}}));
vi.mock('../../chrome/player/network/IndexedDBManager.mjs', () => ({IndexedDBManager: class {}}));
vi.mock('../../chrome/player/ui/components/Dropdown.mjs', () => ({}));

const {OutputConvolver} = await import('../../chrome/player/ui/audio/OutputConvolver.mjs');
const {AbstractAudioModule} = await import('../../chrome/player/ui/audio/AbstractAudioModule.mjs');
const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
const {AudioConvolverControl, AudioConvolverProfile, impulseLengthOf} = await import('../../chrome/player/ui/audio/config/AudioConvolverControl.mjs');

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
  // Each output channel has a file of its own: its first channel is the impulse. A short file
  // of 6 channels was handed on whole, which a ConvolverNode refuses (review).
  it('makes an impulse of one channel of any file, trimmed or not', async () => {
    const {convolver} = stereoConvolver();
    const made = [];
    const decoded = (channels, length) => ({numberOfChannels: channels, sampleRate: 48000,
      getChannelData: () => new Float32Array(length).fill(0.5)});
    convolver.audioContext = {
      decodeAudioData: async (bytes) => decoded(new Uint8Array(bytes)[0], new Uint8Array(bytes)[1] * 100),
      createBuffer: (channels, length, rate) => {
        const buffer = {numberOfChannels: channels, length, sampleRate: rate, copyToChannel: () => {}};
        made.push(buffer);
        return buffer;
      },
    };
    convolver.currentProfile.bufferSize = 4096;
    const file = (channels, hundreds) => new Blob([new Uint8Array([channels, hundreds])]);
    expect((await convolver.getImpulseResponse(file(6, 10))).numberOfChannels).toBe(1);
    expect((await convolver.getImpulseResponse(file(2, 10))).numberOfChannels).toBe(1);
    const trimmed = await convolver.getImpulseResponse(file(6, 100));
    expect([trimmed.numberOfChannels, trimmed.length]).toEqual([1, 4096]);
    // No limit: the whole file, of one channel.
    convolver.currentProfile.bufferSize = -1;
    const whole = await convolver.getImpulseResponse(file(6, 100));
    expect([whole.numberOfChannels, whole.length]).toEqual([1, 10000]);
    expect(made).toHaveLength(4);
  });

  // A link clicked in the player's frame is refused for a blob URL, and the URL was revoked
  // at once (review): the stored impulse file is saved as every other file is.
  it('saves a stored impulse file through the downloads, its URL revoked once it is read', async () => {
    const {convolver} = stereoConvolver();
    convolver.db = {getFile: async () => new Blob([new Uint8Array([1, 2])])};
    const download = vi.spyOn(Utils, 'downloadURL').mockResolvedValue(7);
    const revoke = vi.spyOn(Utils, 'revokeWhenDownloaded').mockImplementation(() => {});
    try {
      await convolver.downloadImpulse(1, 'room.wav');
      expect(download).toHaveBeenCalledWith(expect.stringMatching(/^blob:/), 'room.wav');
      expect(revoke).toHaveBeenCalledWith(download.mock.calls[0][0], 7);
    } finally {
      vi.restoreAllMocks();
    }
  });

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

  it('keeps a stored impulse length as the field allows: the whole file, or at least 128', () => {
    const length = (bufferSize) => AudioConvolverProfile.fromObj({id: 0, label: 'P', bufferSize}).bufferSize;
    expect(length('abc')).toBe(4096);
    expect(length(null)).toBe(4096);
    expect(length(-1)).toBe(-1);
    expect(length(10)).toBe(128);
    // No upper limit any more: a room's reverb was cut at 16384 samples, a third of a second.
    expect(length(1e9)).toBe(1e9);
    expect(length(2048)).toBe(2048);
  });

  // The owner's rule (2026-10-10): an empty field is no limit, the whole file. Empty and 0
  // were both 128 samples (3 ms), the effect all but gone.
  it('reads the impulse length field: empty is the whole file, a number at least 128', () => {
    expect(impulseLengthOf('', 4096)).toBe(-1);
    expect(impulseLengthOf('0', 4096)).toBe(128);
    expect(impulseLengthOf('96000', 4096)).toBe(96000);
    expect(impulseLengthOf('abc', 2048)).toBe(2048);
  });

  it('names the file that did not decode', async () => {
    const convolver = Object.create(OutputConvolver.prototype);
    convolver.audioContext = {decodeAudioData: () => Promise.reject(new Error('EncodingError'))};
    const file = {name: 'room.wav', arrayBuffer: async () => new ArrayBuffer(4)};
    await expect(convolver.getImpulseResponse(file)).rejects.toThrow('Could not decode impulse response: room.wav');
  });
});
