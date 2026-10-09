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

  // The options page: "applied in order, and the first match is used". The joined regex
  // answered with the pattern matching earliest in the URL, and grouped patterns by flags.
  it('answers with the first pattern in order that matches, wherever it matches', () => {
    const m = build([
      ['\\.m3u8', '', 'hls'],
      ['cdn', '', 'dash'],
    ]);
    expect(m.match('https://cdn.example/a.m3u8')).toBe('hls');
    expect(m.match('https://cdn.example/a.mpd')).toBe('dash');
    const flagged = build([
      ['^x', 'i', 'X'],
      ['^a', '', 'Y'],
      ['^a.*', 'i', 'X'],
    ]);
    expect(flagged.match('abc')).toBe('Y');
  });

  it('returns null when nothing matches', () => {
    const m = build([['\\.m3u8', '', 'hls']]);
    expect(m.match('https://e.com/page.html')).toBeNull();
  });

  it('groups several patterns under one output correctly', () => {
    // hls.js accepts both extensions; they must resolve to the same mode.
    const m = build([
      ['\\.m3u8', '', 'hls'],
      ['\\.m3u', '', 'hls'],
      ['\\.mpd', '', 'dash'],
    ]);
    expect(m.match('https://e.com/a.m3u8')).toBe('hls');
    expect(m.match('https://e.com/a.m3u')).toBe('hls');
    expect(m.match('https://e.com/a.mpd')).toBe('dash');
  });

  it('honours the flags of each pattern', () => {
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

  it('still resolves the right output when a pattern has its own capturing group', () => {
    // Regression test: match() used to map the first non-empty capture group
    // back to an output by POSITION. A capturing group inside a caller's own
    // pattern (e.g. a custom source pattern with (\d+) in it) shifted every
    // later output's index, silently returning the wrong output - or
    // undefined - for real, user-authored regexes. Named groups fixed this;
    // patterns are no longer required to avoid capturing groups.
    const m = build([
      ['\\/video\\/(\\d+)\\.mp4', '', 'mp4'],
      ['\\.m3u8', '', 'hls'],
    ]);
    expect(m.match('https://e.com/video/123.mp4')).toBe('mp4');
    expect(m.match('https://e.com/master.m3u8')).toBe('hls');
  });

  it('resolves correctly regardless of capturing-group count or nesting', () => {
    const m = build([
      ['(a)(b)(c)', '', 'triple-group'],
      ['\\.mpd', '', 'dash'],
      ['x(y(z))', '', 'nested-group'],
    ]);
    expect(m.match('abc')).toBe('triple-group');
    expect(m.match('manifest.mpd')).toBe('dash');
    expect(m.match('xyz')).toBe('nested-group');
  });
});

// Two ways a pattern went wrong without a word. With the `g` flag String.prototype.match
// returns all matches and no groups, so match() never found the output. And the empty
// regex matches everything, routing every URL to its output.
describe('flags and empty patterns', () => {
  it('matches a pattern added with the g flag', () => {
    const m = build([['\\.m3u8', 'g', 'hls']]);
    expect(m.match('https://example.com/a.m3u8')).toBe('hls');
    expect(m.match('https://example.com/b.m3u8')).toBe('hls');
  });

  it('gives the same answer every time with the y flag', () => {
    const m = build([['https', 'y', 'web']]);
    expect(m.match('https://a/')).toBe('web');
    expect(m.match('https://b/')).toBe('web');
  });

  it('refuses the empty regex', () => {
    expect(() => new MultiRegexMatcher().addRegex('', '', 'hls')).toThrow(/Empty regex/);
  });
});

// A pattern that is valid on its own has to work the same once joined with the others. Two
// ways it did not: a group of its own named like the joined form's (o0) made compile() throw,
// so the background kept the patterns from before with no word; and a named group in
// patterns of two outputs gave no output at all. A backreference meant another group.
describe('patterns with groups of their own', () => {
  it('compiles a pattern whose group is named like the matcher\'s own', () => {
    const m = build([
      ['\\/live\\/(?<o0>\\d+)', '', 'hls'],
      ['\\.mpd', '', 'dash'],
    ]);
    expect(m.match('https://e.com/live/12')).toBe('hls');
    expect(m.match('https://e.com/a.mpd')).toBe('dash');
  });

  it('routes a named group used by patterns of two outputs to each one\'s output', () => {
    const m = build([
      ['\\/a\\/(?<id>\\d+)', '', 'hls'],
      ['\\/b\\/(?<id>\\d+)', '', 'dash'],
    ]);
    expect(m.match('https://e.com/a/1')).toBe('hls');
    expect(m.match('https://e.com/b/2')).toBe('dash');
  });

  it('matches a pattern with a backreference as it does on its own', () => {
    const m = build([
      ['\\.mpd', '', 'dash'],
      ['\\/(x+)-\\1\\.m3u8', '', 'hls'],
    ]);
    expect(m.match('https://e.com/xx-xx.m3u8')).toBe('hls');
    expect(m.match('https://e.com/x-xx.m3u8')).toBeNull();
    expect(m.match('https://e.com/a.mpd')).toBe('dash');
  });
});
