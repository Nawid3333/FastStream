import {describe, expect, it} from 'vitest';
import {LevelManager} from '../../chrome/player/players/LevelManager.mjs';

// matchQuality() is the "which resolution actually gets picked" logic - a
// regression here silently changes what every user's "default quality"
// setting does. It doesn't reference `this`, so it can be exercised directly
// off the prototype without constructing a real LevelManager (whose
// constructor touches localStorage/navigator, which belong in the
// WebdriverIO e2e suite instead - see vitest.config.mjs's own comment).
const matchQuality = (levels, desiredHeight) =>
  LevelManager.prototype.matchQuality(levels, desiredHeight);

const level = (height, bitrate) => ({height, bitrate});

describe('matchQuality', () => {
  it('picks the exact match when the target height is available', () => {
    const levels = [level(720, 2e6), level(1080, 4e6), level(1440, 8e6)];
    expect(matchQuality(levels, 1080)[0]).toBe(levels[1]);
  });

  it('picks the level whose height is numerically closest to the target', () => {
    // 1440 target, only 1080p/720p available: diff(1080)=360 < diff(720)=720.
    const levels = [level(720, 2e6), level(1080, 4e6)];
    expect(matchQuality(levels, 1440)[0].height).toBe(1080);
  });

  it('can pick a level above the target if it is the closer option', () => {
    // 1440 target, 1600p/720p available: diff(1600)=160 < diff(720)=720.
    // matchQuality is nearest-by-difference, not nearest-below.
    const levels = [level(1600, 8e6), level(720, 2e6)];
    expect(matchQuality(levels, 1440)[0].height).toBe(1600);
  });

  it('breaks an exact tie in distance by preferring the higher bitrate', () => {
    // 1080 target, 720p and 1440p are both exactly 360 away.
    const levels = [level(720, 2e6), level(1440, 8e6)];
    expect(matchQuality(levels, 1080)[0].height).toBe(1440);
  });

  it('returns levels sorted best-match-first, not just the single best', () => {
    const levels = [level(2160, 16e6), level(720, 2e6), level(1080, 4e6)];
    const sorted = matchQuality(levels, 1080).map((l) => l.height);
    expect(sorted).toEqual([1080, 720, 2160]);
  });

  it('handles an empty level list without throwing', () => {
    expect(matchQuality([], 1080)).toEqual([]);
  });
});
