import {afterEach, describe, expect, it, vi} from 'vitest';

import {fetchFreshLink, findFreshLink} from '../../chrome/background/FreshLink.mjs';

// A link a server refused, and its page loaded again: the same video, a new signature (the
// shape of vidmoly's, read on 2026-10-27: the signature ends in '=', and the server refuses
// it written as %3D).
const PATH = '/hls2/02/02996/scqskddn1v5v_,n,l,.urlset/master.m3u8';
const OLD = `https://prx-1316-ant.vmget.online${PATH}?t=RIgphGm8m3mkbDLrG8Yci3P2_uhNi-XdUpxUJ2naOMY=&s=1793113399&e=43200&v=&asn=3209`;
const NEW = `https://prx-1316-ant.vmget.online${PATH}?t=gK8mWJT-Mjb_giPPDmvGDFC614ZUiG-o1DZAblDjGpw=&s=1793113401&e=43200&v=&asn=3209`;

const page = (link) => `<html><script>jwplayer("vplayer").setup({sources: [{file:"${link}"}],
  image: "https://cdn.example/poster.jpg"});</script></html>`;

describe('findFreshLink', () => {
  it('finds the same video\'s new link in the page, byte for byte', () => {
    expect(findFreshLink(page(NEW), OLD)).toBe(NEW);
  });

  it('reads a link in a script\'s escaped string', () => {
    const escaped = NEW.replace(/\//g, '\\/').replace(/&/g, '\\u0026');
    expect(findFreshLink(`{"file":"${escaped}"}`, OLD)).toBe(NEW);
    expect(findFreshLink(`<a href="${NEW.replace(/&/g, '&amp;')}">`, OLD)).toBe(NEW);
  });

  it('takes the link on another of the service\'s hosts', () => {
    const elsewhere = NEW.replace('prx-1316-ant', 'prx-1402-ant');
    expect(findFreshLink(page(elsewhere), OLD)).toBe(elsewhere);
  });

  it('finds nothing in a page that gives the same link, or another video, or another site\'s', () => {
    expect(findFreshLink(page(OLD), OLD)).toBeNull();
    // The same link but for FastStream's time: no new one.
    expect(findFreshLink(page(OLD), OLD + '&faststream-timestamp=95')).toBeNull();
    expect(findFreshLink(page(NEW.replace('scqskddn1v5v', 'otherfile0001')), OLD)).toBeNull();
    expect(findFreshLink(page(NEW.replace('prx-1316-ant.vmget.online', 'cdn.elsewhere.test')), OLD)).toBeNull();
    expect(findFreshLink('<html></html>', OLD)).toBeNull();
    expect(findFreshLink(page(NEW), 'not a url')).toBeNull();
  });
});

describe('fetchFreshLink', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches each page anew, past one that fails, and stops at the first with a link', async () => {
    const fetchPage = vi.fn(async (url) => {
      if (url === 'https://a.test/') throw new TypeError('NetworkError');
      if (url === 'https://b.test/') return new Response('gone', {status: 404});
      return new Response(page(NEW));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pages = ['https://a.test/', 'https://b.test/', 'https://c.test/', 'https://d.test/'];
    expect(await fetchFreshLink(pages, OLD, fetchPage)).toBe(NEW);
    expect(fetchPage.mock.calls.map(([url]) => url)).toEqual(pages.slice(0, 3));
    // Not from Firefox's cache: that is where the old link came from.
    expect(fetchPage.mock.calls[2][1]).toMatchObject({cache: 'no-store'});
  });

  it('gives null when no page has a new link', async () => {
    const fetchPage = vi.fn(async () => new Response(page(OLD)));
    expect(await fetchFreshLink(['https://a.test/'], OLD, fetchPage)).toBeNull();
    expect(await fetchFreshLink([], OLD, fetchPage)).toBeNull();
  });
});
