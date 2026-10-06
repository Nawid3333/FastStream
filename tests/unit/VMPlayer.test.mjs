import {afterEach, describe, expect, it, vi} from 'vitest';
import VMPlayer from '../../chrome/player/players/vm/VMPlayer.mjs';
import {DefaultPlayerEvents} from '../../chrome/player/enums/DefaultPlayerEvents.mjs';
import {RequestUtils} from '../../chrome/player/utils/RequestUtils.mjs';

// The Vimeo player fetched whatever its source's URL was, with the source's headers. The
// background gives it only player.vimeo.com addresses, but a source's mode can also come
// from the player's address (faststream-mode=accelerated_vm) or the Sources browser, so it
// could be pointed at any host (CodeQL js/client-side-request-forgery, 2026-10-06). It now
// asks player.vimeo.com only, and there only a video's player page or config: an address
// rebuilt from the video's number and the query, since a path of the source's choosing could
// reach any other endpoint on Vimeo's host with those headers.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VMPlayer.vimeoRequestUrl', () => {
  it('keeps a player.vimeo.com config or video address as it was', () => {
    for (const url of [
      'https://player.vimeo.com/video/76979871/config?autopause=1&h=abc&s=1_2',
      'https://player.vimeo.com/video/76979871?h=abc&app_id=122963',
      'https://player.vimeo.com/video/76979871',
    ]) {
      expect(VMPlayer.vimeoRequestUrl(url)).toBe(url);
    }
  });

  it('asks over https, without a fragment', () => {
    expect(VMPlayer.vimeoRequestUrl('http://player.vimeo.com/video/1/config?a=b#t=10'))
        .toBe('https://player.vimeo.com/video/1/config?a=b');
  });

  it('refuses any other host, look-alikes included, and anything that is not a web address', () => {
    for (const url of [
      'https://example.com/video/1/config?a=b',
      'https://player.vimeo.com.evil.example/video/1/config',
      'https://evil.example/player.vimeo.com/video/1',
      'https://vimeo.com/76979871',
      'https://x.player.vimeo.com/video/1',
      'https://player.vimeo.com@evil.example/video/1',
      'file:///C:/video/1/config',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(VMPlayer.vimeoRequestUrl(url), url).toBe(null);
    }
  });

  it('asks for a video\'s player page or config only, not another path on Vimeo\'s host', () => {
    const cases = {
      'https://player.vimeo.com/video/840742166/config/': 'https://player.vimeo.com/video/840742166/config',
      'https://player.vimeo.com/video/840742166/': 'https://player.vimeo.com/video/840742166',
      'https://player.vimeo.com/video/1?a=1/../x&b=%2F': 'https://player.vimeo.com/video/1?a=1/../x&b=%2F',
      'https://player.vimeo.com/video/1?': 'https://player.vimeo.com/video/1',
      'https://player.vimeo.com/video/abc/config': null,
      'https://player.vimeo.com/video/1/config/request': null,
      'https://player.vimeo.com/video/1/other': null,
      'https://player.vimeo.com/api/v2/me': null,
      'https://player.vimeo.com/video%2F1/config': null,
      'https://player.vimeo.com/': null,
    };
    for (const [input, expected] of Object.entries(cases)) {
      expect(VMPlayer.vimeoRequestUrl(input), input).toBe(expected);
    }
  });

  it('gives an address on player.vimeo.com whatever the parser makes of the input', () => {
    const cases = {
      'https://player.vimeo.com./video/1': null,
      'https://xn--plyer-4ve.vimeo.com/video/1': null,
      'https://plаyer.vimeo.com/video/1': null, // a Cyrillic а
      'https:\\\\evil.example\\player.vimeo.com\\video': null,
      'https://player.vimeo.com:8443/video/1?a=b': 'https://player.vimeo.com/video/1?a=b',
      'https://user:pass@player.vimeo.com/video/1': 'https://player.vimeo.com/video/1',
      'https://player.vimeo.com//evil.example/video/1': null,
      'https://player.vimeo.com/video/../../evil.example/1': null,
      'https://PLAYER.Vimeo.COM/video/1': 'https://player.vimeo.com/video/1',
    };
    for (const [input, expected] of Object.entries(cases)) {
      const out = VMPlayer.vimeoRequestUrl(input);
      expect(out, input).toBe(expected);
      if (out) expect(new URL(out).host, input).toBe('player.vimeo.com');
    }
  });
});

describe('VMPlayer.setSource', () => {
  const player = () => ({emit: vi.fn(), extractVimeoHlsUrlFromIframePlayer: () => null});

  it('reports an error for another host, and sends no request', async () => {
    const request = vi.spyOn(RequestUtils, 'request');
    const that = player();
    await VMPlayer.prototype.setSource.call(that, {url: 'https://evil.example/video/1/config?x=1', headers: {}});
    expect(request).not.toHaveBeenCalled();
    expect(that.emit).toHaveBeenCalledWith(DefaultPlayerEvents.ERROR, expect.any(Error));
  });

  it('asks player.vimeo.com, with the source\'s headers', async () => {
    const request = vi.spyOn(RequestUtils, 'request').mockResolvedValue({response: {}});
    const that = player();
    const url = 'https://player.vimeo.com/video/1/config?h=abc';
    await VMPlayer.prototype.setSource.call(that, {url, headers: {Referer: 'https://site.example/'}});
    expect(request).toHaveBeenCalledWith({
      url,
      header_commands: [{operation: 'set', header: 'Referer', value: 'https://site.example/'}],
      responseType: 'json',
    });
    // The empty config has no HLS data: reported, as before.
    expect(that.emit).toHaveBeenCalledWith(DefaultPlayerEvents.ERROR, expect.any(Error));
  });
});
