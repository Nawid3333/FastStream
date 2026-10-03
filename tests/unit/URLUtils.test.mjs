import {describe, expect, it} from 'vitest';
import {URLUtils} from '../../chrome/player/utils/URLUtils.mjs';
import {PlayerModes} from '../../chrome/player/enums/PlayerModes.mjs';

// URLUtils decides whether a URL is a stream worth intercepting and which
// player engine handles it. If this regresses, FastStream silently does
// nothing at all - no error is raised anywhere - so it gets the most
// coverage of any module here.

describe('get_url_extension', () => {
  it('extracts a lowercase extension', () => {
    expect(URLUtils.get_url_extension('https://e.com/a/b/v.M3U8')).toBe('m3u8');
  });

  it('ignores query strings and fragments', () => {
    expect(URLUtils.get_url_extension('https://e.com/v.mpd?token=abc#t=10')).toBe('mpd');
    expect(URLUtils.get_url_extension('https://e.com/v.mp4#frag')).toBe('mp4');
  });

  it('is empty for a URL with no extension', () => {
    // It once gave 'com/stream': everything after the host's last dot.
    expect(URLUtils.get_url_extension('https://e.com/stream')).toBe('');
    expect(URLUtils.get_url_extension('https://e.com/v1.2/stream')).toBe('');
    expect(URLUtils.get_url_extension('https://e.com/v.m3u8/')).toBe('');
  });

  it('reads no extension from the host', () => {
    expect(URLUtils.get_url_extension('https://example.mp4')).toBe('');
    expect(URLUtils.get_url_extension('https://example.mp4/')).toBe('');
    expect(URLUtils.getModeFromURL('https://example.mp4')).toBe(PlayerModes.DIRECT);
    expect(URLUtils.get_url_extension('https://cdn.e.com:8443/a/v.mp4')).toBe('mp4');
  });

  it('reads a file name, which has no scheme', () => {
    // SaveManager reads dropped files' names with it.
    expect(URLUtils.get_url_extension('Episode 1.SRT')).toBe('srt');
    expect(URLUtils.get_url_extension('profile.fsprofile.json')).toBe('json');
    expect(URLUtils.get_url_extension('README')).toBe('');
  });
});

describe('getModeFromExtension', () => {
  it('maps every streaming container FastStream accelerates', () => {
    expect(URLUtils.getModeFromExtension('m3u8')).toBe(PlayerModes.ACCELERATED_HLS);
    expect(URLUtils.getModeFromExtension('m3u')).toBe(PlayerModes.ACCELERATED_HLS);
    expect(URLUtils.getModeFromExtension('mpd')).toBe(PlayerModes.ACCELERATED_DASH);
    expect(URLUtils.getModeFromExtension('mp4')).toBe(PlayerModes.ACCELERATED_MP4);
    expect(URLUtils.getModeFromExtension('webm')).toBe(PlayerModes.DIRECT);
  });

  it('returns undefined for an unknown extension', () => {
    expect(URLUtils.getModeFromExtension('txt')).toBeUndefined();
  });
});

describe('getModeFromURL', () => {
  it('routes HLS, DASH and MP4 to their accelerated players', () => {
    expect(URLUtils.getModeFromURL('https://e.com/master.m3u8')).toBe(PlayerModes.ACCELERATED_HLS);
    expect(URLUtils.getModeFromURL('https://e.com/manifest.mpd')).toBe(PlayerModes.ACCELERATED_DASH);
    expect(URLUtils.getModeFromURL('https://e.com/movie.mp4')).toBe(PlayerModes.ACCELERATED_MP4);
  });

  it('falls back to DIRECT rather than throwing on an unknown type', () => {
    expect(URLUtils.getModeFromURL('https://e.com/page.html')).toBe(PlayerModes.DIRECT);
  });
});

describe('header string round-trip', () => {
  it('rejects malformed header blocks', () => {
    expect(URLUtils.validateHeadersString('Referer: https://e.com')).toBe(true);
    expect(URLUtils.validateHeadersString('Referer: https://e.com\nOrigin: https://e.com')).toBe(true);
    expect(URLUtils.validateHeadersString('')).toBe(true);
    expect(URLUtils.validateHeadersString('NoColonHere')).toBe(false);
    expect(URLUtils.validateHeadersString('Referer:')).toBe(false);
    expect(URLUtils.validateHeadersString(': novalue')).toBe(false);
  });

  it('keeps colons inside header values intact', () => {
    // Referer spoofing is how FastStream fetches protected segments, so a
    // value like "https://x" must not be truncated at its own colon.
    const obj = URLUtils.headersStringToObj('Referer: https://example.com:8443/a');
    expect(obj.referer).toBe('https://example.com:8443/a');
  });

  it('round-trips an object through the string form', () => {
    const obj = URLUtils.headersStringToObj(
        URLUtils.objToHeadersString({referer: 'https://e.com', origin: 'https://e.com'}),
    );
    expect(obj).toEqual({referer: 'https://e.com', origin: 'https://e.com'});
  });
});

describe('hostnameMatches', () => {
  it('accepts the domain itself and real subdomains', () => {
    expect(URLUtils.hostnameMatches('https://vimeo.com/123', 'vimeo.com')).toBe(true);
    expect(URLUtils.hostnameMatches('https://player.vimeo.com/video/1', 'vimeo.com')).toBe(true);
  });

  it('rejects a domain that only appears as a substring elsewhere in the URL', () => {
    // A CodeQL-flagged bug class: url.includes(domain) also matches these.
    expect(URLUtils.hostnameMatches('https://vimeo.com.evil.com/x', 'vimeo.com')).toBe(false);
    expect(URLUtils.hostnameMatches('https://evil.com/vimeo.com', 'vimeo.com')).toBe(false);
    expect(URLUtils.hostnameMatches('https://notvimeo.com', 'vimeo.com')).toBe(false);
  });

  it('returns false for an unparsable URL instead of throwing', () => {
    expect(URLUtils.hostnameMatches('not a url', 'vimeo.com')).toBe(false);
  });
});

describe('playableUrl', () => {
  const base = 'moz-extension://abc/player/index.html';

  it('keeps the protocols a media element plays from', () => {
    expect(URLUtils.playableUrl('https://cdn.test/v.webm?t=1#x', base)).toBe('https://cdn.test/v.webm?t=1#x');
    expect(URLUtils.playableUrl('http://127.0.0.1:41800/v.webm', base)).toBe('http://127.0.0.1:41800/v.webm');
    expect(URLUtils.playableUrl('blob:moz-extension://abc/1234', base)).toBe('blob:moz-extension://abc/1234');
    expect(URLUtils.playableUrl('data:video/webm;base64,AAAA', base)).toBe('data:video/webm;base64,AAAA');
    expect(URLUtils.playableUrl('file:///C:/Videos/a.webm', base)).toBe('file:///C:/Videos/a.webm');
  });

  it('refuses a javascript: URL, however it is written', () => {
    // CodeQL's js/xss and js/client-side-unvalidated-url-redirection: a source from the
    // player's address or the sources browser reached video.src unchecked.
    expect(URLUtils.playableUrl('javascript:alert(1)', base)).toBe(null);
    expect(URLUtils.playableUrl('JavaScript:alert(1)', base)).toBe(null);
    expect(URLUtils.playableUrl(' \tjavascript:alert(1)', base)).toBe(null);
    expect(URLUtils.playableUrl('java\nscript:alert(1)', base)).toBe(null);
  });

  it('refuses the other protocols', () => {
    expect(URLUtils.playableUrl('moz-extension://abc/player/index.html', base)).toBe(null);
    expect(URLUtils.playableUrl('about:blank', base)).toBe(null);
    expect(URLUtils.playableUrl('ftp://host/v.webm', base)).toBe(null);
    expect(URLUtils.playableUrl('vbscript:x', base)).toBe(null);
  });

  it('reads a relative source against the base, and refuses one with nothing to read it against', () => {
    expect(URLUtils.playableUrl('v.webm', 'https://faststream.online/player/index.html'))
        .toBe('https://faststream.online/player/v.webm');
    expect(URLUtils.playableUrl('v.webm', base)).toBe(null);
    expect(URLUtils.playableUrl('v.webm')).toBe(null);
    expect(URLUtils.playableUrl('', undefined)).toBe(null);
  });
});
