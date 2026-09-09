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
