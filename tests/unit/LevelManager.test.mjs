import {afterEach, describe, expect, it, vi} from 'vitest';
import {LevelManager} from '../../chrome/player/players/LevelManager.mjs';

// matchQuality() is the "which resolution actually gets picked" logic - a
// regression here silently changes what every user's "default quality"
// setting does. It doesn't reference `this`, so it can be exercised directly
// off the prototype without constructing a real LevelManager (whose
// constructor touches localStorage/navigator, which belong in the
// WebdriverIO e2e suite instead - see vitest.config.mjs's own comment).
const matchQuality = (levels, desiredHeight) =>
  LevelManager.prototype.matchQuality(levels, desiredHeight);

// getDesiredVideoHeight() only reads client.options.defaultQuality, so a
// bare object stand-in for `this` is enough - no need for a real client.
const getDesiredVideoHeight = (defaultQuality) =>
  LevelManager.prototype.getDesiredVideoHeight.call({client: {options: {defaultQuality}}});

const level = (height, bitrate) => ({height, bitrate});

describe('matchQuality', () => {
  it('picks the exact match when the target height is available', () => {
    const levels = [level(720, 2e6), level(1080, 4e6), level(1440, 8e6)];
    expect(matchQuality(levels, 1080)[0]).toBe(levels[1]);
  });

  it('picks the next resolution up, not the numerically nearer one below the target', () => {
    // The reported case: 1440p target with 1080p and 4K (2160p) available.
    // 1080p is numerically closer (diff 360 vs 720), but it's below target,
    // so 4K must win - never settle for less than requested when something
    // higher is on offer.
    const levels = [level(1080, 4e6), level(2160, 16e6)];
    expect(matchQuality(levels, 1440)[0].height).toBe(2160);
  });

  it('falls back to the highest available level when nothing meets the target', () => {
    // 1440 target, only 1080p/720p available - neither meets it, so the
    // closest-below (1080p) is the best that's actually possible.
    const levels = [level(720, 2e6), level(1080, 4e6)];
    expect(matchQuality(levels, 1440)[0].height).toBe(1080);
  });

  it('picks the lowest level that still meets the target, not just any that does', () => {
    // 1080 target with 1440p and 4K both meeting it - 1440p is the smaller
    // of the two qualifying levels, so it wins over jumping straight to 4K.
    const levels = [level(2160, 16e6), level(1440, 8e6), level(720, 2e6)];
    expect(matchQuality(levels, 1080)[0].height).toBe(1440);
  });

  it('breaks a tie between equal-height levels at or above target by preferring the higher bitrate', () => {
    const levels = [level(1440, 4e6), level(1440, 8e6)];
    expect(matchQuality(levels, 1080)[0].bitrate).toBe(8e6);
  });

  it('breaks a tie between equal-height levels below target by preferring the higher bitrate', () => {
    const levels = [level(720, 4e6), level(720, 8e6)];
    expect(matchQuality(levels, 1440)[0].bitrate).toBe(8e6);
  });

  it('returns levels sorted best-match-first: qualifying levels ascending, then shortfalls descending', () => {
    const levels = [level(2160, 16e6), level(720, 2e6), level(1080, 4e6)];
    const sorted = matchQuality(levels, 1080).map((l) => l.height);
    expect(sorted).toEqual([1080, 2160, 720]);
  });

  it('handles an empty level list without throwing', () => {
    expect(matchQuality([], 1080)).toEqual([]);
  });
});

describe('getDesiredVideoHeight', () => {
  it('resolves Auto to the highest available resolution, not the screen size', () => {
    expect(getDesiredVideoHeight('Auto')).toBe(Infinity);
  });

  it('parses an explicit quality setting into a target height', () => {
    expect(getDesiredVideoHeight('1440p')).toBe(1440);
  });

  // replace() of undefined threw: options without it (saved before it existed, or set by a
  // page) are Auto, as the players read them.
  it('reads no quality setting as Auto', () => {
    expect(getDesiredVideoHeight(undefined)).toBe(Infinity);
  });
});

describe('the preferred language', () => {
  // Levels are ranked by how well their language matches, then sorted by quality or
  // bitrate, which threw that rank away: with an en-GB preference, en-US 1080p beat
  // en-GB 720p. Only the best-matching levels go on to the quality sort.
  const levels = [
    {id: 'us-1080', language: 'en-US', height: 1080, bitrate: 8e6},
    {id: 'gb-720', language: 'en-GB', height: 720, bitrate: 3e6},
    {id: 'de-1080', language: 'de', height: 1080, bitrate: 8e6},
  ];

  it('keeps only the video levels of the best-matching dialect', () => {
    const filtered = LevelManager.prototype.filterVideoLevelsByLanguage.call({getVideoLanguage: () => 'en-GB'}, levels);
    expect(filtered.map((l) => l.id)).toEqual(['gb-720']);
  });

  it('keeps only the audio levels of the best-matching dialect', () => {
    const filtered = LevelManager.prototype.filterAudioLevelsByLanguage.call({getAudioLanguage: () => 'en-GB'}, levels);
    expect(filtered.map((l) => l.id)).toEqual(['gb-720']);
  });

  it('keeps every dialect of a language when the preference names none', () => {
    const filtered = LevelManager.prototype.filterVideoLevelsByLanguage.call({getVideoLanguage: () => 'en'}, levels);
    expect(filtered.map((l) => l.id)).toEqual(['us-1080', 'gb-720']);
  });

  it('keeps every level when none matches', () => {
    const filtered = LevelManager.prototype.filterVideoLevelsByLanguage.call({getVideoLanguage: () => 'ja'}, levels);
    expect(filtered).toEqual(levels);
  });
});

describe('Prefer DRC audio, loaded', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const load = (saved) => {
    vi.stubGlobal('localStorage', {getItem: () => JSON.stringify(saved)});
    const manager = {};
    LevelManager.prototype.loadPreferences.call(manager);
    return manager.shouldPreferDRCAudio;
  };

  it('is on for settings saved before it existed, as its default is', () => {
    // `|| false` loaded it as off.
    expect(load({videoLanguage: 'en'})).toBe(true);
  });

  it('stays off when it was turned off', () => {
    expect(load({shouldPreferDRCAudio: false})).toBe(false);
  });
});
