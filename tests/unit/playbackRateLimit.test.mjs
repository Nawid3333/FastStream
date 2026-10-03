import {describe, expect, it, vi} from 'vitest';

// options.maxPlaybackRate (8: Firefox plays no audio above it) was enforced only by the
// speed menu. Holding the mouse on the video doubles the speed, so at 5x the video ran
// at 10x with no sound while the menu showed 8x; a rate saved by a build with a higher
// cap, and the silence skipper's saved speed, went to the video as they were. The
// client's setter clamps now, for every caller. FastStreamClient is imported with its UI
// and players stubbed out, and its setter called on a stand-in client.

const stub = (name) => ({[name]: class {}});
vi.mock('../../chrome/player/ui/InterfaceController.mjs', () => stub('InterfaceController'));
vi.mock('../../chrome/player/ui/KeybindManager.mjs', () => stub('KeybindManager'));
vi.mock('../../chrome/player/ui/FrameStepper.mjs', () => stub('FrameStepper'));
vi.mock('../../chrome/player/network/DownloadManager.mjs', () => stub('DownloadManager'));
vi.mock('../../chrome/player/modules/analyzer/VideoAnalyzer.mjs', () => stub('VideoAnalyzer'));
vi.mock('../../chrome/player/ui/SourcesBrowser.mjs', () => stub('SourcesBrowser'));
vi.mock('../../chrome/player/players/PlayerLoader.mjs', () => stub('PlayerLoader'));
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/ui/audio/AudioConfigManager.mjs', () => stub('AudioConfigManager'));
vi.mock('../../chrome/player/modules/SecureMemory.mjs', () => stub('SecureMemory'));
vi.mock('../../chrome/player/modules/analyzer/AudioAnalyzer.mjs', () => stub('AudioAnalyzer'));
vi.mock('../../chrome/player/modules/analyzer/PreviewFrameExtractor.mjs', () => stub('PreviewFrameExtractor'));
vi.mock('../../chrome/player/ui/StatusManager.mjs', () => ({StatusTypes: {}}));
vi.mock('../../chrome/player/utils/InterfaceUtils.mjs', () => stub('InterfaceUtils'));
vi.mock('../../chrome/player/ui/audio/VirtualAudioNode.mjs', () => stub('VirtualAudioNode'));
vi.mock('../../chrome/player/players/SyncedAudioPlayer.mjs', () => stub('SyncedAudioPlayer'));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => stub('AlertPolyfill'));
vi.mock('../../chrome/player/utils/CSSFilterUtils.mjs', () => stub('CSSFilterUtils'));
vi.stubGlobal('window', {});

const {FastStreamClient} = await import('../../chrome/player/FastStreamClient.mjs');
const setRate = Object.getOwnPropertyDescriptor(FastStreamClient.prototype, 'playbackRate').set;

/**
 * A client playing a video, with a separate audio track.
 * @return {Object}
 */
function client() {
  return {
    options: {maxPlaybackRate: 8},
    state: {playbackRate: 1},
    player: {playbackRate: 1},
    syncedAudioPlayer: {setPlaybackRate: vi.fn()},
    interfaceController: {updatePlaybackRate: vi.fn()},
  };
}

describe('FastStreamClient.playbackRate', () => {
  it('never runs faster than options.maxPlaybackRate, whoever sets it', () => {
    const fake = client();
    // Hold-to-double at the 5x preset.
    setRate.call(fake, 5 * 2);
    expect(fake.player.playbackRate).toBe(8);
    expect(fake.state.playbackRate).toBe(8);
    expect(fake.syncedAudioPlayer.setPlaybackRate).toHaveBeenLastCalledWith(8);

    // A rate saved by a build that allowed 16x.
    setRate.call(fake, 16);
    expect(fake.player.playbackRate).toBe(8);
  });

  it('follows the cap the options give', () => {
    const fake = client();
    fake.options.maxPlaybackRate = 4;
    setRate.call(fake, 5);
    expect(fake.player.playbackRate).toBe(4);
  });

  it('never goes below 0.1, the menu\'s lowest step', () => {
    const fake = client();
    setRate.call(fake, 0);
    expect(fake.player.playbackRate).toBe(0.1);
  });

  it('leaves a rate within the limits as it is', () => {
    const fake = client();
    for (const rate of [0.1, 0.5, 1, 1.7, 2.5, 8]) {
      setRate.call(fake, rate);
      expect(fake.player.playbackRate).toBe(rate);
      expect(fake.state.playbackRate).toBe(rate);
    }
    expect(fake.interfaceController.updatePlaybackRate).toHaveBeenCalledTimes(6);
  });
});

describe('PlaybackRateChanger.loadState', () => {
  it('keeps a saved silence-skip speed within the cap', async () => {
    const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
    const {PlaybackRateChanger} = await import('../../chrome/player/ui/menus/PlaybackRateChanger.mjs');
    const getConfig = vi.spyOn(Utils, 'getConfig').mockResolvedValue(JSON.stringify({playbackRate: 1, silenceSkipSpeed: 16}));
    const fake = {client: {options: {maxPlaybackRate: 8}}};
    Object.defineProperty(fake, 'maxPlaybackRate', {get: () => fake.client.options.maxPlaybackRate});
    await PlaybackRateChanger.prototype.loadState.call(fake);
    expect(fake.silenceSkipSpeed).toBe(8);
    expect(fake.client.playbackRate).toBe(1);
    getConfig.mockRestore();
  });
});
