import {describe, expect, it} from 'vitest';
import {StringUtils} from '../../chrome/player/utils/StringUtils.mjs';

// Times as the player shows them, and HTTP Range headers.

describe('formatTime', () => {
  it('omits the hour component below an hour', () => {
    expect(StringUtils.formatTime(0)).toBe('00:00');
    expect(StringUtils.formatTime(5)).toBe('00:05');
    expect(StringUtils.formatTime(65)).toBe('01:05');
    expect(StringUtils.formatTime(599)).toBe('09:59');
  });

  it('adds hours once past 3600s', () => {
    expect(StringUtils.formatTime(3600)).toBe('1:00:00');
    expect(StringUtils.formatTime(3661)).toBe('1:01:01');
  });

  // A DASH live stream's length is Infinity: the player showed "00:12 / Infinity:aN:aN".
  it('shows no length for one that has none', () => {
    expect(StringUtils.formatTime(Infinity)).toBe('--:--');
    expect(StringUtils.formatTime(NaN)).toBe('--:--');
  });
});

describe('formatDuration', () => {
  it('drops empty leading units', () => {
    expect(StringUtils.formatDuration(5)).toBe('5s');
    expect(StringUtils.formatDuration(61)).toBe('1m 1s');
    expect(StringUtils.formatDuration(3661)).toBe('1h 1m 1s');
  });
});

describe('parseHTTPRange', () => {
  it('parses a closed range', () => {
    expect(StringUtils.parseHTTPRange('bytes=0-1023')).toEqual([0, 1023]);
    expect(StringUtils.parseHTTPRange('bytes=1024-2047')).toEqual([1024, 2047]);
  });

  it('reports NaN for an open-ended range end', () => {
    const [start, end] = StringUtils.parseHTTPRange('bytes=100-');
    expect(start).toBe(100);
    expect(Number.isNaN(end)).toBe(true);
  });

  it('returns a pair of undefined when there is no range at all', () => {
    expect(StringUtils.parseHTTPRange('bytes=')).toEqual([undefined, undefined]);
  });
});

describe('levenshteinDistance', () => {
  it('is zero for identical strings', () => {
    expect(StringUtils.levenshteinDistance('abc', 'abc')).toBe(0);
  });

  it('equals the other length when one side is empty', () => {
    expect(StringUtils.levenshteinDistance('', 'abc')).toBe(3);
    expect(StringUtils.levenshteinDistance('abc', '')).toBe(3);
  });

  it('matches the textbook kitten/sitting distance', () => {
    // Used for fuzzy subtitle-track matching; three edits is the known answer.
    expect(StringUtils.levenshteinDistance('kitten', 'sitting')).toBe(3);
  });

  it('is symmetric', () => {
    expect(StringUtils.levenshteinDistance('flaw', 'lawn'))
        .toBe(StringUtils.levenshteinDistance('lawn', 'flaw'));
  });
});
