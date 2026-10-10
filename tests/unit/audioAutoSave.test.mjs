import {describe, expect, it, vi} from 'vitest';

// The audio tools' changes were kept only by a Save button: without a click, the equalizer,
// compressor and mixer settings were gone when the player closed, and nothing said so. They
// are saved by themselves now (AudioConfigManager.saveChanges, on the player's tick).

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));

// Its imports reach a module that listens on window as it loads (IndexedDBManager).
vi.stubGlobal('window', {addEventListener: () => {}});
const {AudioConfigManager} = await import('../../chrome/player/ui/audio/AudioConfigManager.mjs');
const {AudioProfile} = await import('../../chrome/player/ui/audio/config/AudioProfile.mjs');

/**
 * A manager with two saved profiles, the first being worked on.
 * @return {Object}
 */
function manager() {
  const first = new AudioProfile(1);
  first.label = 'Movies';
  const second = new AudioProfile(2);
  second.label = 'Music';
  const config = Object.create(AudioConfigManager.prototype);
  config.profiles = [first, second];
  config.currentProfile = first.copy();
  config.saveProfilesToStorage = vi.fn(async () => {});
  return config;
}

describe('the audio tools\' changes', () => {
  it('are saved into the profile they were made in', async () => {
    const config = manager();
    config.currentProfile.master.gain = 0.5;
    await config.saveChanges();

    expect(config.saveProfilesToStorage).toHaveBeenCalledTimes(1);
    expect(config.profiles[0].master.gain).toBe(0.5);
    expect(config.profiles[0].label).toBe('Movies');
    expect(config.profiles[1].master.gain).not.toBe(0.5);
  });

  it('are not saved again while nothing changes', async () => {
    const config = manager();
    expect(config.saveChanges()).toBe(null);
    config.currentProfile.master.gain = 0.5;
    await config.saveChanges();
    expect(config.saveChanges()).toBe(null);
    expect(config.saveProfilesToStorage).toHaveBeenCalledTimes(1);
  });

  it('keep a name given to the saved profile meanwhile', async () => {
    const config = manager();
    config.profiles[0].label = 'Films';
    config.currentProfile.master.gain = 0.5;
    await config.saveChanges();
    expect(config.profiles[0].label).toBe('Films');
  });
});
