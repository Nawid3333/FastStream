import {describe, expect, it} from 'vitest';
import {audioTrackLabel, audioTrackMime, pickAudioTrack} from '../../chrome/player/players/mp4/AudioTracks.mjs';

// MP4Player played an MP4's first audio track, always: a film whose first track is Dolby
// (which Firefox does not decode) failed outright next to a playable AAC track, and no other
// language could be chosen (#665). AudioTracks.mjs says which track to start with and what
// each is called.

/**
 * @param {string} id
 * @param {string} language
 * @param {boolean} [enabled]
 * @return {{id: string, language: string, enabled: boolean}}
 */
function level(id, language, enabled = false) {
  return {id, language, enabled};
}

const isEnabled = (l) => l.enabled;
const noPreference = (levels) => levels;
const prefer = (language) => (levels) => {
  const matching = levels.filter((l) => l.language === language);
  return matching.length ? matching : levels;
};

describe('pickAudioTrack', () => {
  it('takes the track chosen before for this video, if it is still there', () => {
    const levels = [level('1:0', 'jpn', true), level('1:1', 'eng')];
    expect(pickAudioTrack(levels, isEnabled, '1:1', prefer('jpn')).id).toBe('1:1');
    expect(pickAudioTrack(levels, isEnabled, '1:7', noPreference).id).toBe('1:0');
  });

  it('takes the preferred language, in file order', () => {
    const levels = [level('1:0', 'jpn', true), level('1:1', 'eng'), level('1:2', 'eng')];
    expect(pickAudioTrack(levels, isEnabled, null, prefer('eng')).id).toBe('1:1');
  });

  it('takes the track the file enables when no language is preferred', () => {
    const levels = [level('1:0', 'eng'), level('1:1', 'fra', true)];
    expect(pickAudioTrack(levels, isEnabled, null, noPreference).id).toBe('1:1');
  });

  it('takes the first track when the file enables none', () => {
    const levels = [level('1:1', 'eng'), level('1:2', 'fra')];
    expect(pickAudioTrack(levels, isEnabled, null, noPreference).id).toBe('1:1');
  });

  it('has none to take when no track plays', () => {
    expect(pickAudioTrack([], isEnabled, null, noPreference)).toBe(null);
  });
});

describe('audioTrackMime', () => {
  it('is the type a SourceBuffer takes, with Opus as the MediaSource names it', () => {
    expect(audioTrackMime('mp4a.40.2')).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(audioTrackMime('Opus')).toBe('audio/mp4; codecs="opus"');
    expect(audioTrackMime('ac-3')).toBe('audio/mp4; codecs="ac-3"');
  });
});

describe('audioTrackLabel', () => {
  it('keeps a name someone gave the track', () => {
    expect(audioTrackLabel('Commentary')).toBe('Commentary');
    expect(audioTrackLabel('English 5.1\u0000')).toBe('English 5.1');
  });

  it('drops the names muxers write by default', () => {
    for (const name of ['SoundHandler', 'Sound Media Handler', 'Core Media Audio', 'GPAC ISO Audio Handler',
      'L-SMASH Audio Handler', 'ISO Media file produced by Google Inc.', '', null, undefined]) {
      expect(audioTrackLabel(name)).toBe('');
    }
  });
});
