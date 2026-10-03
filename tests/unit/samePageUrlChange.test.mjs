import {beforeAll, describe, expect, it} from 'vitest';

// Firefox reports a change of a tab's URL fragment (tabs.onUpdated) as it reports a new
// page. The background took it for one: the allowlist's per-page mpv latch was reset, so
// the page's next stream request opened a second mpv window, and the in-page player was
// taken down by an anchor link or a #t= update (#236). Only the fragment changing to
// another anchor is the same page; a hash route is a page of its own.

let BackgroundUtils;

beforeAll(async () => {
  // BackgroundUtils reads the player URL when it loads.
  globalThis.chrome = {runtime: {getURL: (file) => 'moz-extension://test/' + file}};
  ({BackgroundUtils} = await import('../../chrome/background/BackgroundUtils.mjs'));
});

describe('isSamePageUrlChange', () => {
  it.each([
    ['https://site.example/watch/1', 'https://site.example/watch/1#comments'],
    ['https://site.example/watch/1#comments', 'https://site.example/watch/1#t=120'],
    ['https://site.example/watch/1?v=2#a', 'https://site.example/watch/1?v=2'],
  ])('%s -> %s: the same page', (from, to) => {
    expect(BackgroundUtils.isSamePageUrlChange(from, to)).toBe(true);
  });

  it.each([
    // Another path or query: a new page, or a single-page site's next episode.
    ['https://site.example/watch/1', 'https://site.example/watch/2'],
    ['https://site.example/watch?v=1', 'https://site.example/watch?v=2'],
    // A hash route is the next page of a single-page site.
    ['https://site.example/#/watch/1', 'https://site.example/#/watch/2'],
    ['https://site.example/#!/watch/1', 'https://site.example/#!/watch/2'],
    ['https://site.example/', 'https://site.example/#/watch/2'],
    // The same URL again is a reload.
    ['https://site.example/watch/1', 'https://site.example/watch/1'],
    // The tab's first page.
    [undefined, 'https://site.example/watch/1#a'],
    ['', 'https://site.example/watch/1#a'],
  ])('%s -> %s: a page of its own', (from, to) => {
    expect(BackgroundUtils.isSamePageUrlChange(from, to)).toBe(false);
  });
});
