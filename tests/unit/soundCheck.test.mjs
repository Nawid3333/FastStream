import {afterEach, describe, expect, it, vi} from 'vitest';

import {soundRequired, withoutSound} from '../e2e/soundCheck.mjs';

// The e2e specs that listen to the player skip where Firefox has no sound device, and
// fail where the e2e setup gave it one: Linux CI (#265).

describe('soundRequired', () => {
  it('is Linux CI only', () => {
    expect(soundRequired({CI: 'true'}, 'linux')).toBe(true);
    expect(soundRequired({}, 'linux')).toBe(false);
    expect(soundRequired({CI: ''}, 'linux')).toBe(false);
    expect(soundRequired({CI: 'true'}, 'win32')).toBe(false);
    expect(soundRequired({CI: 'true'}, 'darwin')).toBe(false);
  });
});

describe('withoutSound', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const state = {context: 'suspended', machine: 'suspended'};

  it('skips the case where nothing gave Firefox a sound device', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const [env, platform] of [[{}, 'linux'], [{CI: 'true'}, 'win32']]) {
      const test = {skip: vi.fn()};
      withoutSound(test, 'no sound on this machine', state, env, platform);
      expect(test.skip).toHaveBeenCalledTimes(1);
    }
    expect(log).toHaveBeenCalledWith('      no sound on this machine, skipping:', JSON.stringify(state));
  });

  it('fails it on Linux CI, saying what the page reported and which sink it had', () => {
    const test = {skip: vi.fn()};
    const env = {CI: 'true', E2E_SOUND_SINK: 'faststream_e2e', PULSE_SERVER: 'unix:/run/user/1001/pulse/native'};
    expect(() => withoutSound(test, 'cannot hear the tone at 1x on this machine', state, env, 'linux'))
        .toThrow('cannot hear the tone at 1x on this machine, on Linux CI, where the e2e setup gives Firefox a ' +
          'sound device (PulseAudio sink faststream_e2e, PULSE_SERVER unix:/run/user/1001/pulse/native): ' +
          JSON.stringify(state));
    expect(test.skip).not.toHaveBeenCalled();
  });

  it('says so when the setup gave it no sink at all', () => {
    expect(() => withoutSound({skip: vi.fn()}, 'no sound', state, {CI: 'true'}, 'linux'))
        .toThrow('(PulseAudio sink not set up, PULSE_SERVER not set)');
  });
});
