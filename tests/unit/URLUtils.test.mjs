import {afterEach, describe, expect, it} from 'vitest';
import {URLUtils} from '../../chrome/player/utils/URLUtils.mjs';
import {PlayerModes} from '../../chrome/player/enums/PlayerModes.mjs';

// URLUtils decides whether a URL is a stream worth intercepting and which
// player engine handles it. If this regresses, FastStream silently does
// nothing at all - no error is raised anywhere - so it gets the most
// coverage of any module here.

afterEach(() => {
  delete globalThis.chrome;
});

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

  it('only takes the YouTube path when running as an extension', () => {
    const watch = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    // No chrome global: the web build must not claim the YT engine.
    expect(URLUtils.getModeFromURL(watch)).toBe(PlayerModes.DIRECT);

    globalThis.chrome = {extension: {}};
    expect(URLUtils.getModeFromURL(watch)).toBe(PlayerModes.ACCELERATED_YT);
  });
});

describe('YouTube URL recognition', () => {
  it('accepts every host listed in the manifest content_scripts', () => {
    for (const host of [
      'https://www.youtube.com/watch?v=a',
      'https://youtube.com/watch?v=a',
      'https://m.youtube.com/watch?v=a',
      'https://music.youtube.com/watch?v=a',
      'https://www.youtube-nocookie.com/embed/a',
    ]) {
      expect(URLUtils.is_url_yt(host), host).toBe(true);
    }
  });

  it('rejects lookalike hosts', () => {
    expect(URLUtils.is_url_yt('https://notyoutube.com/watch?v=a')).toBe(false);
    expect(URLUtils.is_url_yt('https://youtube.com.evil.net/watch?v=a')).toBe(false);
    expect(URLUtils.is_url_yt('')).toBe(false);
    expect(URLUtils.is_url_yt('not a url')).toBe(false);
  });

  it('distinguishes watch pages from embeds', () => {
    expect(URLUtils.is_url_yt_watch('https://www.youtube.com/watch?v=a')).toBe(true);
    expect(URLUtils.is_url_yt_watch('https://www.youtube.com/embed/a')).toBe(true);
    expect(URLUtils.is_url_yt_embed('https://www.youtube.com/embed/a')).toBe(true);
    expect(URLUtils.is_url_yt_embed('https://www.youtube.com/watch?v=a')).toBe(false);
    expect(URLUtils.is_url_yt_watch('https://www.youtube.com/feed/subscriptions')).toBe(false);
  });

  it('pulls the video id from both ?v= and /shorts/ style URLs', () => {
    expect(URLUtils.get_yt_identifier('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(URLUtils.get_yt_identifier('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(URLUtils.get_yt_identifier('not a url')).toBe('');
  });

  it('pulls the playlist id', () => {
    expect(URLUtils.get_yt_playlist_identifier('https://www.youtube.com/watch?v=a&list=PL123')).toBe('PL123');
    expect(URLUtils.get_yt_playlist_identifier('https://www.youtube.com/watch?v=a')).toBeNull();
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
