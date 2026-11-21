import fs from 'node:fs';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('../../chrome/player/modules/Localize.mjs', () => ({
  Localize: {getMessage: (key, subs) => subs ? `${key}(${subs.join('|')})` : key},
}));

const {ignoredPatternLines, ignoredUrlLines, showIgnoredLines} = await import('../../chrome/player/options/IgnoredLines.mjs');

// The URL lists and the custom source patterns dropped a line they could not read without a
// word: a typo in a list left the user wondering why a site was not picked up.

describe('ignoredUrlLines', () => {
  it('names the lines no entry can be read from', () => {
    const text = [
      'example.com',
      '~(unclosed',
      '# a comment',
      '',
      '-',
      '!example.org/path @anime',
      '~',
      '@movie',
    ].join('\n');
    expect(ignoredUrlLines(text)).toEqual([2, 5, 7, 8]);
  });

  it('names nothing in a list it reads whole', () => {
    expect(ignoredUrlLines('netflix.com\ncrunchyroll.com @anime\n~^https:\\/\\/example\\.com\\/movie\\/')).toEqual([]);
    expect(ignoredUrlLines('')).toEqual([]);
  });
});

describe('ignoredPatternLines', () => {
  it('names the lines the patterns leave out, counted as the field shows them', () => {
    const text = '# comment\nm3u8 /\\.m3u8/i\n\nmp4 notaregex\nxyz /a/\nvtt /(/';
    expect(ignoredPatternLines(text)).toEqual([4, 5, 6]);
  });
});

describe('showIgnoredLines', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the lines under the field, and hides once they are fixed', () => {
    const hint = {textContent: '', hidden: true};
    vi.stubGlobal('document', {getElementById: (id) => id === 'autoEnableURLsignored' ? hint : null});
    const input = {id: 'autoEnableURLs'};
    showIgnoredLines(input, [2, 5]);
    expect(hint.textContent).toBe('options_list_ignored_lines(2, 5)');
    expect(hint.hidden).toBe(false);
    showIgnoredLines(input, []);
    expect(hint.hidden).toBe(true);
  });
});

describe('the options page', () => {
  const page = fs.readFileSync(new URL('../../chrome/player/options/options.mjs', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../../chrome/player/options/index.html', import.meta.url), 'utf8');

  it.each(['autoEnableURLs', 'customSourcePatterns', 'mpvAllowlist'])('has a hint right under %s', (id) => {
    expect(html).toMatch(new RegExp(`<textarea id="${id}"[^>]*></textarea>\\s*<div class="ignored-lines" id="${id}ignored" hidden></div>`));
  });

  it.each([
    ['autoEnableURLSInput', 'ignoredUrlLines'],
    ['mpvAllowlistInput', 'ignoredUrlLines'],
    ['customSourcePatterns', 'ignoredPatternLines'],
  ])('shows %s\'s ignored lines when loaded and when changed', (field, finder) => {
    const call = `showIgnoredLines(${field}, ${finder}(${field}.value));`;
    expect(page.split(call).length - 1).toBe(2);
  });
});
