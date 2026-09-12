import {describe, expect, it} from 'vitest';
import {UrlMatchList} from '../../chrome/background/UrlMatchList.mjs';

// The MPV allowlist reuses the "Auto-enable URLs" entry syntax. Matching
// precedence (later lines override earlier ones) is the fragile part.

describe('parseEntry', () => {
  it('rejects empty lines and comments', () => {
    expect(UrlMatchList.parseEntry('')).toBeNull();
    expect(UrlMatchList.parseEntry('   ')).toBeNull();
    expect(UrlMatchList.parseEntry('# a comment')).toBeNull();
  });

  it('parses a plain prefix entry', () => {
    const entry = UrlMatchList.parseEntry('https://example.com/movie/');
    expect(entry).not.toBeNull();
    expect(entry.negative).toBe(false);
    expect(entry.regex).toBe(false);
    expect(entry.exclude_domain).toBe(false);
    expect(entry.match).toBe('https://example.com/movie/');
  });

  it('normalizes plain entries to lowercase', () => {
    const entry = UrlMatchList.parseEntry('https://EXAMPLE.com/Movie/');
    expect(entry.match).toBe('https://example.com/movie/');
  });

  it('parses regex entries with tilde prefix', () => {
    const entry = UrlMatchList.parseEntry('~^https:\\/\\/example\\.com\\/(movie|other)\\/');
    expect(entry.regex).toBe(true);
    expect(entry.match).toBeInstanceOf(RegExp);
  });

  it('rejects invalid regex instead of throwing', () => {
    expect(UrlMatchList.parseEntry('~([unclosed')).toBeNull();
  });

  it('parses domain entries with dash prefix', () => {
    const entry = UrlMatchList.parseEntry('-example.com');
    expect(entry.exclude_domain).toBe(true);
    expect(entry.match).toBe('example.com');
  });

  it('parses negative entries with exclamation prefix', () => {
    const entry = UrlMatchList.parseEntry('!https://example.com/ads/');
    expect(entry.negative).toBe(true);
    expect(entry.match).toBe('https://example.com/ads/');
  });

  it('combines prefixes in any order', () => {
    const entry = UrlMatchList.parseEntry('!~^https://example.com/');
    expect(entry.negative).toBe(true);
    expect(entry.regex).toBe(true);
  });

  it('rejects an empty entry that is only prefixes', () => {
    expect(UrlMatchList.parseEntry('!')).toBeNull();
  });

  it('parses a trailing @anime/@movie content-type tag', () => {
    const anime = UrlMatchList.parseEntry('https://crunchyroll.com @anime');
    expect(anime.contentType).toBe('anime');
    expect(anime.match).toBe('https://crunchyroll.com');

    const movie = UrlMatchList.parseEntry('https://example.com/movie/ @MOVIE');
    expect(movie.contentType).toBe('movie');
    expect(movie.match).toBe('https://example.com/movie/');
  });

  it('leaves contentType null when no tag is present', () => {
    expect(UrlMatchList.parseEntry('https://example.com/').contentType).toBeNull();
  });

  it('combines a content-type tag with other prefixes', () => {
    const entry = UrlMatchList.parseEntry('!~^https://example\\.com/ @anime');
    expect(entry.negative).toBe(true);
    expect(entry.regex).toBe(true);
    expect(entry.contentType).toBe('anime');
  });

  it('rejects a line that is only a content-type tag', () => {
    expect(UrlMatchList.parseEntry('@anime')).toBeNull();
  });
});

describe('matches', () => {
  it('returns false for an empty list', () => {
    const list = new UrlMatchList();
    expect(list.matches('https://example.com/movie/1')).toBe(false);
  });

  it('returns false for empty or missing URLs', () => {
    const list = new UrlMatchList();
    list.setEntries(['https://example.com/']);
    expect(list.matches('')).toBe(false);
    expect(list.matches(undefined)).toBe(false);
  });

  it('matches by prefix', () => {
    const list = new UrlMatchList();
    list.setEntries(['https://example.com/movie/']);
    expect(list.matches('https://example.com/movie/1')).toBe(true);
    expect(list.matches('https://example.com/other/1')).toBe(false);
    expect(list.matches('https://other.com/movie/1')).toBe(false);
  });

  it('matches case-insensitively', () => {
    const list = new UrlMatchList();
    list.setEntries(['https://example.com/movie/']);
    expect(list.matches('HTTPS://EXAMPLE.COM/MOVIE/1')).toBe(true);
  });

  it('matches by regex with tilde', () => {
    const list = new UrlMatchList();
    list.setEntries(['~^https:\\/\\/example\\.com\\/(movie|other)\\/']);
    expect(list.matches('https://example.com/movie/1')).toBe(true);
    expect(list.matches('https://example.com/other/2')).toBe(true);
    expect(list.matches('https://example.com/nope/1')).toBe(false);
  });

  it('matches by hostname with dash', () => {
    const list = new UrlMatchList();
    list.setEntries(['-example.com']);
    expect(list.matches('https://example.com/anything')).toBe(true);
    expect(list.matches('https://sub.example.com/anything')).toBe(false);
  });

  it('lets a later negative entry override an earlier positive one', () => {
    const list = new UrlMatchList();
    list.setEntries([
      'https://example.com/',
      '!https://example.com/ads/',
    ]);
    expect(list.matches('https://example.com/movie/1')).toBe(true);
    expect(list.matches('https://example.com/ads/banner')).toBe(false);
  });

  it('lets a later positive entry override an earlier negative one', () => {
    const list = new UrlMatchList();
    list.setEntries([
      '!https://example.com/',
      'https://example.com/ok/',
    ]);
    expect(list.matches('https://example.com/ok/1')).toBe(true);
    expect(list.matches('https://example.com/other/1')).toBe(false);
  });

  it('skips invalid entries instead of failing', () => {
    const list = new UrlMatchList();
    list.setEntries(['# comment', '   ', '~([broken', 'https://good.com/']);
    expect(list.entries).toHaveLength(1);
    expect(list.matches('https://good.com/x')).toBe(true);
  });

  it('tolerates null input', () => {
    const list = new UrlMatchList();
    list.setEntries(null);
    expect(list.entries).toHaveLength(0);
    expect(list.matches('https://example.com/')).toBe(false);
  });
});

describe('getContentType', () => {
  it('returns null when nothing matches', () => {
    const list = new UrlMatchList();
    list.setEntries(['https://example.com/ @anime']);
    expect(list.getContentType('https://other.com/')).toBeNull();
  });

  it('returns the tag of the matching entry', () => {
    const list = new UrlMatchList();
    list.setEntries(['https://crunchyroll.com @anime', 'https://netflix.com @movie']);
    expect(list.getContentType('https://crunchyroll.com/watch/1')).toBe('anime');
    expect(list.getContentType('https://netflix.com/watch/1')).toBe('movie');
  });

  it('returns null when the matching entry carries no tag', () => {
    const list = new UrlMatchList();
    list.setEntries(['https://example.com/']);
    expect(list.getContentType('https://example.com/x')).toBeNull();
  });

  it('lets a later untagged entry clear an earlier tag for the same prefix', () => {
    const list = new UrlMatchList();
    list.setEntries(['https://example.com/ @anime', 'https://example.com/movies/']);
    expect(list.getContentType('https://example.com/movies/1')).toBeNull();
    expect(list.getContentType('https://example.com/other/1')).toBe('anime');
  });

  it('returns null for a negative entry even if tagged', () => {
    const list = new UrlMatchList();
    list.setEntries(['!https://example.com/ads/ @anime']);
    expect(list.getContentType('https://example.com/ads/1')).toBeNull();
  });
});
