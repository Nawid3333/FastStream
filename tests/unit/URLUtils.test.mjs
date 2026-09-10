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

  it('survives a URL with no extension', () => {
    expect(URLUtils.get_url_extension('https://e.com/stream')).toBe('com/stream');
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
