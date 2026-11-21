import fs from 'node:fs';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('../../chrome/player/modules/Localize.mjs', () => ({
  Localize: {getMessage: (key, subs) => subs ? `${key}(${subs.join('|')})` : key},
}));
const env = vi.hoisted(() => ({extension: true}));
vi.mock('../../chrome/player/utils/EnvUtils.mjs', () => ({EnvUtils: {isExtension: () => env.extension}}));

const {ignoredPatternLines, ignoredUrlLines, showIgnoredLines} = await import('../../chrome/player/options/IgnoredLines.mjs');

// The URL lists and the custom source patterns dropped a line they could not read without a
// word: a typo in a list left the user wondering why a site was not picked up.

describe('ignoredUrlLines', () => {
  it('names the lines no entry can be read from', async () => {
    // One literal, as the field holds it: a host name alone in a string that reaches the
    // parser's RegExp reads to CodeQL as an unanchored URL pattern (js/regex/missing-regexp-anchor).
    const text = 'example.com\n~^(unclosed\n# a comment\n\n-\n!example.org/path @anime\n~\n@movie';
    expect(await ignoredUrlLines(text)).toEqual([2, 5, 7, 8]);
  });

  it('names nothing in a list it reads whole', async () => {
    expect(await ignoredUrlLines('netflix.com\ncrunchyroll.com @anime\n~^https:\\/\\/example\\.com\\/movie\\/')).toEqual([]);
    expect(await ignoredUrlLines('')).toEqual([]);
  });
});

describe('ignoredPatternLines', () => {
  it('names the lines the patterns leave out, counted as the field shows them', async () => {
    const text = '# comment\nm3u8 /\\.m3u8/i\n\nmp4 notaregex\nxyz /a/\nvtt /^(/';
    expect(await ignoredPatternLines(text)).toEqual([4, 5, 6]);
  });
});

describe('showIgnoredLines', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    env.extension = true;
  });

  /**
   * @param {string} value - The field's text.
   * @return {{hint: Object, input: Object}} The field and its hint, in a stand-in page.
   */
  function field(value) {
    const hint = {textContent: '', hidden: true};
    vi.stubGlobal('document', {getElementById: (id) => id === 'autoEnableURLsignored' ? hint : null});
    return {hint, input: {id: 'autoEnableURLs', value}};
  }

  it('names the lines under the field, and hides once they are fixed', async () => {
    const {hint, input} = field('example.com\n~');
    await showIgnoredLines(input, ignoredUrlLines);
    expect(hint.textContent).toBe('options_list_ignored_lines(2)');
    expect(hint.hidden).toBe(false);
    input.value = 'example.com\n# fixed';
    await showIgnoredLines(input, ignoredUrlLines);
    expect(hint.hidden).toBe(true);
  });

  it('leaves the hint to the call for a text changed meanwhile', async () => {
    const {hint, input} = field('~');
    const shown = showIgnoredLines(input, async (text) => {
      input.value = 'example.com\n# changed';
      return ignoredUrlLines(text);
    });
    await shown;
    expect(hint.hidden).toBe(true);
    expect(hint.textContent).toBe('');
  });

  it('reads nothing outside the extension, where the web build has no background folder', async () => {
    env.extension = false;
    const {hint, input} = field('~');
    const find = vi.fn(ignoredUrlLines);
    await showIgnoredLines(input, find);
    expect(find).not.toHaveBeenCalled();
    expect(hint.hidden).toBe(true);
  });

  it('never rejects: a list that cannot be read shows nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const {hint, input} = field('~');
    await expect(showIgnoredLines(input, async () => {
      throw new Error('no parser');
    })).resolves.toBeUndefined();
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
    const call = `showIgnoredLines(${field}, ${finder});`;
    expect(page.split(call).length - 1).toBe(2);
  });
});
