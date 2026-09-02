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

describe('getSizeValue', () => {
  it('scales by SI prefix', () => {
    expect(StringUtils.getSizeValue('1 MB')).toBe(1e6);
    expect(StringUtils.getSizeValue('2 GB')).toBe(2e9);
    expect(StringUtils.getSizeValue('1 KB')).toBe(1e3);
  });

  it('defaults a bare number to megabytes', () => {
    expect(StringUtils.getSizeValue('5')).toBe(5);
  });

  it('returns -1 for input it cannot parse', () => {
    expect(StringUtils.getSizeValue('abc')).toBe(-1);
    expect(StringUtils.getSizeValue('-3 MB')).toBe(-1);
  });
});

describe('getSpeedValue', () => {
  it('treats a capital B as bytes', () => {
    expect(StringUtils.getSpeedValue('10 MB/s')).toBe(1e7);
  });

  it('treats a lowercase b as bits, dividing by eight', () => {
    // 10 Mbps is 1.25 MB/s - the distinction decides the real download cap.
    expect(StringUtils.getSpeedValue('10 Mbps')).toBe(1.25e6);
  });

  it('returns -1 for unparseable or negative input', () => {
    expect(StringUtils.getSpeedValue('fast')).toBe(-1);
    expect(StringUtils.getSpeedValue('-5 MB/s')).toBe(-1);
  });
});

describe('getSizeString / getSpeedString', () => {
  it('picks a readable unit', () => {
    expect(StringUtils.getSizeString(999)).toBe('999 B');
    expect(StringUtils.getSizeString(1500)).toBe('1.5 KB');
    expect(StringUtils.getSizeString(1.5e9)).toBe('1.5 GB');
  });

  it('renders the unlimited sentinel', () => {
    expect(StringUtils.getSizeString(-1)).toBe('∞ GB');
    expect(StringUtils.getSpeedString(-1)).toBe('∞ MB/s');
  });

  it('round-trips a size through string and back', () => {
    expect(StringUtils.getSizeValue(StringUtils.getSizeString(2e9))).toBe(2e9);
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
