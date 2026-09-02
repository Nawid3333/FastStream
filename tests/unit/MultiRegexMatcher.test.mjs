import {describe, expect, it} from 'vitest';
import {MultiRegexMatcher} from '../../chrome/background/MultiRegexMatcher.mjs';

// The background script uses this to decide which player mode a request URL
// belongs to. It compiles many patterns into one alternation per flag set,
// so the group-numbering logic in match() is the fragile part.

const build = (entries) => {
  const m = new MultiRegexMatcher();
  for (const [regex, flags, output] of entries) m.addRegex(regex, flags, output);
  m.compile();
  return m;
};

describe('addRegex', () => {
  it('rejects an invalid pattern instead of failing later at compile time', () => {
    const m = new MultiRegexMatcher();
    expect(() => m.addRegex('([unclosed', '', 'x')).toThrow(/Invalid regex/);
  });

  it('deduplicates identical regex/flags/output triples', () => {
    const m = new MultiRegexMatcher();
    m.addRegex('\\.m3u8', '', 'hls');
    m.addRegex('\\.m3u8', '', 'hls');
    expect(m.uncompiledRegexes).toHaveLength(1);
  });

  it('keeps the same pattern when the output differs', () => {
    const m = new MultiRegexMatcher();
    m.addRegex('\\.m3u8', '', 'hls');
    m.addRegex('\\.m3u8', '', 'other');
    expect(m.uncompiledRegexes).toHaveLength(2);
  });
});

describe('match', () => {
  it('returns the output bound to the matching pattern', () => {
    const m = build([
      ['\\.m3u8', '', 'hls'],
      ['\\.mpd', '', 'dash'],
      ['\\.mp4', '', 'mp4'],
    ]);
    expect(m.match('https://e.com/master.m3u8')).toBe('hls');
    expect(m.match('https://e.com/manifest.mpd')).toBe('dash');
    expect(m.match('https://e.com/movie.mp4')).toBe('mp4');
  });

  it('returns null when nothing matches', () => {
    const m = build([['\\.m3u8', '', 'hls']]);
    expect(m.match('https://e.com/page.html')).toBeNull();
  });

  it('groups several patterns under one output correctly', () => {
    // hls.js accepts both extensions; they must resolve to the same mode
    // even though they are merged into a single alternation group.
    const m = build([
      ['\\.m3u8', '', 'hls'],
      ['\\.m3u', '', 'hls'],
      ['\\.mpd', '', 'dash'],
    ]);
    expect(m.match('https://e.com/a.m3u8')).toBe('hls');
    expect(m.match('https://e.com/a.m3u')).toBe('hls');
    expect(m.match('https://e.com/a.mpd')).toBe('dash');
  });

  it('honours flags, compiling each flag set into its own alternation', () => {
    const m = build([
      ['\\.M3U8', 'i', 'hls-insensitive'],
      ['\\.mpd', '', 'dash-sensitive'],
    ]);
    expect(m.match('https://e.com/a.m3u8')).toBe('hls-insensitive');
    expect(m.match('https://e.com/a.MPD')).toBeNull();
  });

  it('is empty and inert after clear()', () => {
    const m = build([['\\.m3u8', '', 'hls']]);
    m.clear();
    m.compile();
    expect(m.match('https://e.com/a.m3u8')).toBeNull();
  });

  it('resolves outputs positionally, so patterns must not add capture groups', () => {
    // Documents a real constraint: match() maps the first non-empty capture
    // group back to an output by index. A capturing group inside a caller's
    // own pattern shifts that numbering. Use (?:...) in stored patterns.
    const safe = build([
      ['\\.(?:m3u8|m3u)', '', 'hls'],
      ['\\.mpd', '', 'dash'],
    ]);
    expect(safe.match('https://e.com/a.m3u8')).toBe('hls');
    expect(safe.match('https://e.com/a.mpd')).toBe('dash');
  });
});
