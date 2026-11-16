import {describe, expect, it, vi} from 'vitest';
import {DownloadStatus} from '../../chrome/player/enums/DownloadStatus.mjs';
import {DashFragmentRequester} from '../../chrome/player/players/dash/DashFragmentRequester.mjs';
import {HLSFragmentRequester} from '../../chrome/player/players/hls/HLSFragmentRequester.mjs';
import {siteOfHost, sourceHeadersFor, VideoSource} from '../../chrome/player/VideoSource.mjs';

// A source's headers are what the page's request sent to the source's host, its Cookie
// included, and a header rule sets them on each request of the source. A playlist or manifest
// that named another host for a segment or a key had the source site's session cookie sent
// there, which the browser itself never does (glm's review, 2026-11-16). The login headers now
// go only to the source's own site; Referer and Origin, which CDNs check, go everywhere.

const MASTER = 'https://video.site.test/hls/master.m3u8';
const HEADERS = {cookie: 'session=secret', authorization: 'Bearer t', referer: 'https://site.test/watch/1',
  origin: 'https://site.test'};
const PUBLIC = {referer: 'https://site.test/watch/1', origin: 'https://site.test'};

describe('siteOfHost', () => {
  it('is the last two labels, three under a public second level', () => {
    expect(siteOfHost('cdn.video.site.test')).toBe('site.test');
    expect(siteOfHost('site.test')).toBe('site.test');
    expect(siteOfHost('www.example.co.uk')).toBe('example.co.uk');
    expect(siteOfHost('media.example.com.au')).toBe('example.com.au');
    expect(siteOfHost('192.168.1.10')).toBe('192.168.1.10');
    expect(siteOfHost('localhost')).toBe('localhost');
  });
});

describe('sourceHeadersFor', () => {
  const source = new VideoSource(MASTER, HEADERS, 'hls');

  it('gives every header to the source\'s own site, its other hosts too', () => {
    expect(sourceHeadersFor(source, 'https://video.site.test/hls/seg1.ts')).toEqual(HEADERS);
    expect(sourceHeadersFor(source, 'https://cdn2.site.test/seg1.ts')).toEqual(HEADERS);
    expect(source.headersFor('https://site.test/key')).toEqual(HEADERS);
  });

  it('gives another site no login header', () => {
    expect(sourceHeadersFor(source, 'https://collector.example/k')).toEqual(PUBLIC);
    // A country's public second level is no one site.
    const uk = new VideoSource('https://a.co.uk/v.m3u8', HEADERS, 'hls');
    expect(sourceHeadersFor(uk, 'https://b.co.uk/seg.ts')).toEqual(PUBLIC);
    // Nor anything that is no http(s) address, either way round.
    expect(sourceHeadersFor(source, 'data:text/plain,x')).toEqual(PUBLIC);
    expect(sourceHeadersFor({url: 'data:application/dash+xml;base64,AA', headers: HEADERS}, MASTER)).toEqual(PUBLIC);
  });
});

describe('a segment and its key on another site', () => {
  it('HLS: neither gets the source\'s login headers; on its own site, both do', () => {
    for (const [segment, key, expected] of [
      ['https://evil.example/seg0.ts', 'https://collector.example/k', [PUBLIC, PUBLIC]],
      ['https://video.site.test/seg0.ts', 'https://keys.site.test/k', [HEADERS, HEADERS]],
    ]) {
      const getFile = vi.fn(() => ({abort() {}}));
      const player = {emit: vi.fn(), source: new VideoSource(MASTER, HEADERS, 'hls'),
        getClient: () => ({downloadManager: {getFile}})};
      const requester = new HLSFragmentRequester(player);
      requester.requestFragment({
        status: DownloadStatus.WAITING,
        getFrag: () => ({fs_oldcryptdata: {uri: key, iv: new Uint8Array(16)}}),
        getContext: () => ({url: segment, responseType: 'arraybuffer'}),
      }, {onSuccess: vi.fn(), onFail: vi.fn(), onAbort: vi.fn()});
      // The key's download first, the segment's second.
      expect(getFile.mock.calls.map(([request]) => request.headers)).toEqual(expected);
    }
  });

  it('DASH: a segment on another site gets no login header', () => {
    const getFile = vi.fn(() => ({abort() {}}));
    const player = {emit: vi.fn(), source: new VideoSource('https://video.site.test/manifest.mpd', HEADERS, 'dash'),
      getClient: () => ({downloadManager: {getFile}})};
    new DashFragmentRequester(player).requestFragment({
      status: DownloadStatus.WAITING,
      getContext: () => ({url: 'https://evil.example/seg1.m4s', responseType: 'arraybuffer'}),
    }, {onSuccess: vi.fn(), onFail: vi.fn(), onAbort: vi.fn()});
    expect(getFile.mock.calls[0][0].headers).toEqual(PUBLIC);
  });
});
