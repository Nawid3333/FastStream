import {describe, expect, it} from 'vitest';
import {StringUtils} from '../../chrome/player/utils/StringUtils.mjs';

// These parse user-entered settings (download speed caps, buffer size caps)
// and HTTP Range headers. A regression turns a "10 MB/s" cap into a silently
// wrong number rather than an error, so the unit maths is worth pinning down.

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

describe('truncateFilename', () => {
  it('leaves a short name alone', () => {
    expect(StringUtils.truncateFilename('short.mp4', 20)).toBe('short.mp4');
  });

  it('preserves the extension when shortening', () => {
    const out = StringUtils.truncateFilename('averylongfilename.mp4', 15);
    expect(out.endsWith('.mp4')).toBe(true);
    expect(out).toContain('...');
  });

  it('handles a name with no extension', () => {
    const out = StringUtils.truncateFilename('aaaaaaaaaaaaaaaaaaaa', 10);
    expect(out).toHaveLength(10);
  });

  it('caps the extension itself at 5 chars, staying within maxLength overall', () => {
    // Regression test: the "extension" (everything after the last '.') can
    // be arbitrarily long - e.g. a dotted filename with no real extension.
    // The result must not exceed maxLength just because ext.length > 5.
    const out = StringUtils.truncateFilename('impulse_IR.stereo_44100Hz', 20);
    expect(out).toBe('impulse_IR....ster');
    expect(out.length).toBeLessThanOrEqual(20);
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
