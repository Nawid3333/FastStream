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

  it('reads a link in a script\'s escaped string, and in the page\'s HTML', () => {
    // As a script writes it: https:\/\/…&s=… (a JSON string of the link).
    const escaped = NEW.split('/').join('\\/').split('&').join('\\u0026');
    expect(findFreshLink(`{"file":"${escaped}"}`, OLD)).toBe(NEW);
    expect(findFreshLink(`<a href="${NEW.split('&').join('&amp;')}">`, OLD)).toBe(NEW);
    // A link with nothing kept but its path, escaped: still the one.
    const bare = 'https://h.test/v.m3u8?t=new';
    expect(findFreshLink(`{"file":"${bare.split('/').join('\\/')}\\u0026s=2"}`, 'https://h.test/v.m3u8?t=old&s=1'))
        .toBe(bare + '&s=2');
  });

  it('takes, of several links with the path, the one that kept most of the refused link, and none of two alike', () => {
    // The next episode in the same page, with the same path and its own id.
    const old = 'https://cdn.test/hls/master.m3u8?id=ep1&t=old';
    const next = 'https://cdn.test/hls/master.m3u8?id=ep2&t=b';
    const fresh = 'https://cdn.test/hls/master.m3u8?id=ep1&t=a';
    expect(findFreshLink(`${next} ${fresh}`, old)).toBe(fresh);
    expect(findFreshLink(`${next} https://cdn.test/hls/master.m3u8?id=ep3&t=c`, old)).toBeNull();
  });

  it('finds nothing in a page that gives the same link, or another video, or another host\'s', () => {
    expect(findFreshLink(page(OLD), OLD)).toBeNull();
    // The same link but for FastStream's time: no new one.
    expect(findFreshLink(page(OLD), OLD + '&faststream-timestamp=95')).toBeNull();
    expect(findFreshLink(page(NEW.replace('scqskddn1v5v', 'otherfile0001')), OLD)).toBeNull();
    expect(findFreshLink(page(NEW.replace('prx-1316-ant.vmget.online', 'cdn.elsewhere.test')), OLD)).toBeNull();
    // Another host of the service may be another tenant's: not taken (vidmoly kept its host).
    expect(findFreshLink(page(NEW.replace('prx-1316-ant', 'prx-1402-ant')), OLD)).toBeNull();
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

  it('reads no stream opened as a page, and only the start of a huge page', async () => {
    const video = vi.fn(async () => new Response(page(NEW), {headers: {'Content-Type': 'video/mp4'}}));
    expect(await fetchFreshLink(['https://a.test/'], OLD, video)).toBeNull();
    // The link past the first 4 MB is not read: the page is not held whole.
    const huge = vi.fn(async () => new Response('x'.repeat(5 * 1024 * 1024) + page(NEW), {headers: {'Content-Type': 'text/html'}}));
    expect(await fetchFreshLink(['https://a.test/'], OLD, huge)).toBeNull();
    const html = vi.fn(async () => new Response(page(NEW), {headers: {'Content-Type': 'text/html; charset=utf-8'}}));
    expect(await fetchFreshLink(['https://a.test/'], OLD, html)).toBe(NEW);
  });
});
