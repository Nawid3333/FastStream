import {afterEach, describe, expect, it, vi} from 'vitest';

import {StreamLengths} from '../../chrome/background/StreamLengths.mjs';
import {PlayerModes} from '../../chrome/player/enums/PlayerModes.mjs';
import {PIECE_LENGTH} from '../../chrome/player/utils/StreamLength.mjs';

// Not a divisor of the 64 KiB a file read takes: the last chunk read runs past it.
const CHUNK = 10000;

/**
 * A response whose body comes in chunks, and which tells how much of it was read.
 * @param {Uint8Array} bytes - The body.
 * @param {Object} options - status, url, and stats to fill in (pulled, cancelled).
 * @return {Response} It.
 */
function streamResponse(bytes, {status, url, stats = {}}) {
  let pos = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (pos >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(pos, pos + CHUNK));
      pos += CHUNK;
      stats.pulled = Math.min(pos, bytes.length);
    },
    cancel() {
      stats.cancelled = true;
    },
  }, {highWaterMark: 0});
  const response = new Response(body, {status});
  Object.defineProperty(response, 'url', {value: url});
  return response;
}

/**
 * A fake server: its files by URL, byte ranges answered unless told not to.
 * @param {Object<string, Object>} files - body (string or bytes), status, redirect, stats.
 * @param {Object} [options] - ranges: false for a server that ignores them.
 * @return {{fetch: Function, calls: Array<{url: string, init: Object}>}} Its fetch, and
 *   the requests it got.
 */
function server(files, {ranges = true} = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, init});
    const file = files[url];
    if (!file) {
      return new Response('not found', {status: 404});
    }
    if (file.status) {
      return new Response(file.body || '', {status: file.status});
    }
    const bytes = typeof file.body === 'string' ? new TextEncoder().encode(file.body) : file.body;
    const finalUrl = file.redirect || url;
    const range = init.headers?.Range && /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    if (range && ranges) {
      return streamResponse(bytes.subarray(Number(range[1]), Number(range[2]) + 1), {status: 206, url: finalUrl});
    }
    return streamResponse(bytes, {status: 200, url: finalUrl, stats: file.stats});
  };
  return {fetch, calls};
}

function box(type, body) {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(Array.from(type, (c) => c.charCodeAt(0)), 4);
  out.set(body, 8);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

// A movie header, version 0, of the length given.
function moov(seconds) {
  const mvhd = new Uint8Array(100);
  const view = new DataView(mvhd.buffer);
  view.setUint32(12, 1000);
  view.setUint32(16, seconds * 1000);
  return box('moov', box('mvhd', mvhd));
}

const ftyp = box('ftyp', new TextEncoder().encode('isom\0\0\0\0isomavc1'));

const HLS = PlayerModes.ACCELERATED_HLS;
const MP4 = PlayerModes.ACCELERATED_MP4;

afterEach(() => {
  vi.useRealTimers();
});

describe('StreamLengths', () => {
  it('reads an HLS stream\'s length from its first variant, relative to where the master came from', async () => {
    const {fetch, calls} = server({
      'https://cdn.example/v/master.m3u8': {
        redirect: 'https://edge.example/v/master.m3u8?sig=1',
        body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\n1080/index.m3u8\n',
      },
      'https://edge.example/v/720/index.m3u8': {
        body: '#EXTM3U\n#EXTINF:600,\na.ts\n#EXTINF:600,\nb.ts\n#EXTINF:252,\nc.ts\n#EXT-X-ENDLIST\n',
      },
    });
    const lengths = new StreamLengths({fetch});
    expect(await lengths.probe({url: 'https://cdn.example/v/master.m3u8', mode: HLS})).toBe(1452);
    expect(calls.map((call) => call.url)).toEqual(['https://cdn.example/v/master.m3u8', 'https://edge.example/v/720/index.m3u8']);
    expect(lengths.lengthOf('https://cdn.example/v/master.m3u8')).toBe(1452);
  });

  it('keeps a master playlist\'s qualities, one per height, for the master and each variant', async () => {
    const {fetch} = server({
      'https://cdn.example/v/master.m3u8': {
        redirect: 'https://edge.example/v/master.m3u8?sig=1',
        body: '#EXTM3U\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480\n480/index.m3u8\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=1,RESOLUTION=1920x1080\n1080/index.m3u8\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720\n720/index.m3u8\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n1080-low/index.m3u8\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"\naudio/index.m3u8\n',
      },
      'https://edge.example/v/480/index.m3u8': {body: '#EXTM3U\n#EXTINF:600,\na.ts\n#EXT-X-ENDLIST\n'},
    });
    const lengths = new StreamLengths({fetch});
    await lengths.probe({url: 'https://cdn.example/v/master.m3u8', mode: HLS});
    const list = [
      {url: 'https://edge.example/v/1080/index.m3u8', label: '1080p', height: 1080},
      {url: 'https://edge.example/v/720/index.m3u8', label: '720p', height: 720},
      {url: 'https://edge.example/v/480/index.m3u8', label: '480p', height: 480},
    ];
    expect(lengths.hlsQualities('https://cdn.example/v/master.m3u8')).toEqual({master: 'https://cdn.example/v/master.m3u8', list});
    // The page's player loads a variant after the master: it has the same list.
    expect(lengths.hlsQualities('https://edge.example/v/720/index.m3u8')).toEqual({master: 'https://cdn.example/v/master.m3u8', list});
    expect(lengths.hlsQualities('https://edge.example/v/other.m3u8')).toBeNull();
  });

  it('gives a master with audio or subtitles of their own, or with one height, no list', async () => {
    const {fetch} = server({
      'https://cdn.example/a/master.m3u8': {
        body: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aac"\n1080.m3u8\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,AUDIO="aac"\n480.m3u8\n',
      },
      'https://cdn.example/a/1080.m3u8': {body: '#EXTM3U\n#EXTINF:60,\na.ts\n#EXT-X-ENDLIST\n'},
      'https://cdn.example/b/master.m3u8': {
        body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nhi.m3u8\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\nlo.m3u8\n',
      },
      'https://cdn.example/b/hi.m3u8': {body: '#EXTM3U\n#EXTINF:60,\na.ts\n#EXT-X-ENDLIST\n'},
    });
    const lengths = new StreamLengths({fetch});
    await lengths.probe({url: 'https://cdn.example/a/master.m3u8', mode: HLS});
    await lengths.probe({url: 'https://cdn.example/b/master.m3u8', mode: HLS});
    expect(lengths.hlsQualities('https://cdn.example/a/480.m3u8')).toEqual({master: 'https://cdn.example/a/master.m3u8', list: null});
    expect(lengths.hlsQualities('https://cdn.example/b/master.m3u8')).toEqual({master: 'https://cdn.example/b/master.m3u8', list: null});
  });

  it('takes a playlist of the master\'s audio or subtitles for the master, which alone plays it with a picture', async () => {
    // The page's player asks for the sound's playlist after the variant's, as long as the
    // video: sent alone, mpv played the sound alone (VOE, 2026-10-23).
    const {fetch} = server({
      'https://cdn.example/a/master.m3u8': {
        redirect: 'https://edge.example/a/master.m3u8?sig=1',
        body: '#EXTM3U\n' +
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Deutsch",DEFAULT=NO,URI="index-a1.m3u8?sig=1"\n' +
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES\n' +
          '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Deutsch",URI = "subs/de.m3u8"\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=1300000,RESOLUTION=1280x720,AUDIO="aac",SUBTITLES="subs"\nindex-v1-a1.m3u8?sig=1\n',
      },
      'https://edge.example/a/index-v1-a1.m3u8?sig=1': {body: '#EXTM3U\n#EXTINF:60,\na.ts\n#EXT-X-ENDLIST\n'},
    });
    const lengths = new StreamLengths({fetch});
    await lengths.probe({url: 'https://cdn.example/a/master.m3u8', mode: HLS});
    const master = {master: 'https://cdn.example/a/master.m3u8', list: null};
    expect(lengths.hlsQualities('https://edge.example/a/index-a1.m3u8?sig=1')).toEqual(master);
    expect(lengths.hlsQualities('https://edge.example/a/subs/de.m3u8')).toEqual(master);
    expect(lengths.hlsQualities('https://edge.example/a/index-v1-a1.m3u8?sig=1')).toEqual(master);
  });

  it('forgets the oldest master past its limit, its audio\'s playlist with it', async () => {
    const {fetch} = server(Object.fromEntries(Array.from({length: 301}, (_, i) => [`https://cdn.example/${i}/master.m3u8`, {
      body: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Deutsch",URI="de.m3u8"\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="aac"\nvideo.m3u8\n',
    }])));
    const lengths = new StreamLengths({fetch});
    for (let i = 0; i <= 300; i++) {
      await lengths.probe({url: `https://cdn.example/${i}/master.m3u8`, mode: HLS});
    }
    expect(lengths.hlsQualities('https://cdn.example/0/de.m3u8')).toBeNull();
    expect(lengths.hlsQualities('https://cdn.example/1/de.m3u8')).toEqual({master: 'https://cdn.example/1/master.m3u8', list: null});
  });

  it('reads a DASH stream\'s length', async () => {
    const {fetch} = server({'https://cdn.example/a.mpd': {body: '<MPD type="static" mediaPresentationDuration="PT24M"></MPD>'}});
    const lengths = new StreamLengths({fetch});
    expect(await lengths.probe({url: 'https://cdn.example/a.mpd', mode: PlayerModes.ACCELERATED_DASH})).toBe(1440);
  });

  describe('copy protection', () => {
    // Vimeo's, measured 2026-10-28 (vimeo.com/863362136): a master with no key, and variants
    // whose segments are SAMPLE-AES-CTR under a Widevine and a PlayReady key.
    const WIDEVINE = '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAANHBzc2g=",KEYID=0x46d7,' +
      'KEYFORMATVERSIONS="1",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"';
    const PLAYREADY = '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;charset=UTF-16;base64,BgIAAA==",' +
      'KEYFORMAT="com.microsoft.playready"';
    const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="audio/media.m3u8"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=6320976,RESOLUTION=1920x1080,AUDIO="a"\nv1080/media.m3u8\n';
    const variant = (keys) => `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n${keys}` +
      '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg1.mp4\n#EXTINF:6,\nseg2.mp4\n#EXT-X-ENDLIST\n';

    it('tells an HLS stream whose variant is copy-protected, by its master\'s URL, its length read all the same', async () => {
      const {fetch} = server({
        'https://cdn.example/v/master.m3u8': {body: master},
        'https://cdn.example/v/v1080/media.m3u8': {body: variant(`${WIDEVINE}\n${PLAYREADY}\n`)},
      });
      const lengths = new StreamLengths({fetch});
      expect(lengths.isProtected('https://cdn.example/v/master.m3u8')).toBe(false);
      expect(await lengths.probe({url: 'https://cdn.example/v/master.m3u8', mode: HLS})).toBe(12);
      expect(lengths.isProtected('https://cdn.example/v/master.m3u8')).toBe(true);
    });

    it('tells a media playlist detected by itself', async () => {
      const {fetch} = server({'https://cdn.example/v/v1080/media.m3u8': {body: variant(`${WIDEVINE}\n`)}});
      const lengths = new StreamLengths({fetch});
      await lengths.probe({url: 'https://cdn.example/v/v1080/media.m3u8', mode: HLS});
      expect(lengths.isProtected('https://cdn.example/v/v1080/media.m3u8')).toBe(true);
    });

    it('takes AES-128, which FastStream decrypts itself, and a stream with no key, for clear', async () => {
      const {fetch} = server({
        'https://cdn.example/aes.m3u8': {body: variant('#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x01\n')},
        'https://cdn.example/clear.m3u8': {body: variant('')},
      });
      const lengths = new StreamLengths({fetch});
      await lengths.probe({url: 'https://cdn.example/aes.m3u8', mode: HLS});
      await lengths.probe({url: 'https://cdn.example/clear.m3u8', mode: HLS});
      expect(lengths.isProtected('https://cdn.example/aes.m3u8')).toBe(false);
      expect(lengths.isProtected('https://cdn.example/clear.m3u8')).toBe(false);
    });

    it('tells a DASH stream whose video is copy-protected', async () => {
      const mpd = (protection) => '<MPD type="static" mediaPresentationDuration="PT24M"><Period>' +
        `<AdaptationSet contentType="video">${protection}<Representation id="1" width="1920"/></AdaptationSet>` +
        '<AdaptationSet contentType="audio"><Representation id="2"/></AdaptationSet></Period></MPD>';
      const {fetch} = server({
        'https://cdn.example/drm.mpd': {body: mpd('<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>')},
        'https://cdn.example/clear.mpd': {body: mpd('')},
      });
      const lengths = new StreamLengths({fetch});
      expect(await lengths.probe({url: 'https://cdn.example/drm.mpd', mode: PlayerModes.ACCELERATED_DASH})).toBe(1440);
      await lengths.probe({url: 'https://cdn.example/clear.mpd', mode: PlayerModes.ACCELERATED_DASH});
      expect(lengths.isProtected('https://cdn.example/drm.mpd')).toBe(true);
      expect(lengths.isProtected('https://cdn.example/clear.mpd')).toBe(false);
    });

    it('forgets a protected stream with its length, past the limit', async () => {
      const {fetch} = server({'https://cdn.example/drm.m3u8': {body: variant(`${WIDEVINE}\n`)}});
      const lengths = new StreamLengths({fetch});
      await lengths.probe({url: 'https://cdn.example/drm.m3u8', mode: HLS});
      for (let i = 0; i < 300; i++) {
        await lengths.probe({url: `https://cdn.example/${i}.m3u8`, mode: HLS});
      }
      expect(lengths.lengthOf('https://cdn.example/drm.m3u8')).toBeUndefined();
      expect(lengths.isProtected('https://cdn.example/drm.m3u8')).toBe(false);
      expect(lengths.protectedUrls.size).toBe(0);
    });
  });

  it('reads an MP4\'s length from a movie header after its media data, in two ranges', async () => {
    const mdat = box('mdat', new Uint8Array(200000));
    const file = concat(ftyp, mdat, moov(1500));
    const {fetch, calls} = server({'https://cdn.example/film.mp4': {body: file}});
    const lengths = new StreamLengths({fetch});
    expect(await lengths.probe({url: 'https://cdn.example/film.mp4', mode: MP4})).toBe(1500);
    const at = ftyp.length + mdat.length;
    expect(calls.map((call) => call.init.headers.Range)).toEqual(['bytes=0-65535', `bytes=${at}-${at + 65535}`]);
  });

  it('reads the length of a WebM file played directly', async () => {
    // EBML header, Segment of unknown size, Info with a Duration of 125.5 s.
    const webm = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 0x80, 0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
      0x15, 0x49, 0xA9, 0x66, 0x8B, 0x44, 0x89, 0x88, 0, 0, 0, 0, 0, 0, 0, 0]);
    new DataView(webm.buffer).setFloat64(25, 125500);
    const {fetch} = server({'https://cdn.example/clip.webm': {body: webm}});
    const lengths = new StreamLengths({fetch});
    expect(await lengths.probe({url: 'https://cdn.example/clip.webm', mode: PlayerModes.DIRECT})).toBe(125.5);
  });

  it('reads no more than the start of a file from a server that ignores the range', async () => {
    const stats = {};
    const file = concat(ftyp, moov(95), box('mdat', new Uint8Array(1024 * 1024)));
    const {fetch} = server({'https://cdn.example/a.mp4': {body: file, stats}}, {ranges: false});
    const lengths = new StreamLengths({fetch});
    expect(await lengths.probe({url: 'https://cdn.example/a.mp4', mode: MP4})).toBe(95);
    expect(stats.pulled).toBeLessThan(64 * 1024 + CHUNK);
    expect(stats.cancelled).toBe(true);

    // Nor the rest of it, for a movie header at its end: the second read would get the start again.
    const tail = concat(ftyp, box('mdat', new Uint8Array(1024 * 1024)), moov(95));
    const other = server({'https://cdn.example/b.mp4': {body: tail}}, {ranges: false});
    const lengths2 = new StreamLengths({fetch: other.fetch});
    expect(await lengths2.probe({url: 'https://cdn.example/b.mp4', mode: MP4})).toBeNull();
    expect(other.calls).toHaveLength(2);
  });

  it('sends the page\'s headers: Referer, Origin and Cookie by the rule, the rest with the request', async () => {
    const {fetch, calls} = server({'https://cdn.example/p.m3u8': {body: '#EXTM3U\n#EXTINF:60,\na.ts\n#EXT-X-ENDLIST\n'}});
    const setHeaders = vi.fn(async () => {});
    const lengths = new StreamLengths({fetch, setHeaders});
    await lengths.probe({url: 'https://cdn.example/p.m3u8', mode: HLS, headers: [
      {name: 'Host', value: 'cdn.example'},
      {name: 'User-Agent', value: 'Mozilla/5.0'},
      {name: 'Accept', value: '*/*'},
      {name: 'Referer', value: 'https://site.example/watch/1'},
      {name: 'Origin', value: 'https://site.example'},
      {name: 'Cookie', value: 'session=abc'},
      {name: 'If-None-Match', value: '"etag"'},
      {name: 'If-Modified-Since', value: 'Tue, 01 Sep 2026 00:00:00 GMT'},
      {name: 'X-Token', value: 'secret'},
      {name: 'Range', value: 'bytes=0-'},
    ]});
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith('https://cdn.example/p.m3u8', [
      {operation: 'set', header: 'referer', value: 'https://site.example/watch/1'},
      {operation: 'set', header: 'origin', value: 'https://site.example'},
      {operation: 'set', header: 'cookie', value: 'session=abc'},
    ]);
    expect(calls[0].init.headers).toEqual({'x-token': 'secret'});
    expect(calls[0].init.credentials).toBe('omit');
  });

  it('sets the headers of each URL it reads: a variant\'s too', async () => {
    const {fetch} = server({
      'https://cdn.example/m.m3u8': {body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv/index.m3u8\n'},
      'https://cdn.example/v/index.m3u8': {body: '#EXTM3U\n#EXTINF:60,\na.ts\n#EXT-X-ENDLIST\n'},
    });
    const setHeaders = vi.fn(async () => {});
    const lengths = new StreamLengths({fetch, setHeaders});
    await lengths.probe({url: 'https://cdn.example/m.m3u8', mode: HLS, headers: {Referer: 'https://site.example/'}});
    expect(setHeaders.mock.calls.map((call) => call[0])).toEqual(['https://cdn.example/m.m3u8', 'https://cdn.example/v/index.m3u8']);
  });

  it('reads each URL once', async () => {
    const {fetch, calls} = server({'https://cdn.example/p.m3u8': {body: '#EXTM3U\n#EXTINF:60,\na.ts\n#EXT-X-ENDLIST\n'}});
    const lengths = new StreamLengths({fetch});
    const source = {url: 'https://cdn.example/p.m3u8', mode: HLS};
    await Promise.all([lengths.probe(source), lengths.probe(source)]);
    await lengths.probe(source);
    expect(calls).toHaveLength(1);
  });

  it('tells no length for an error, a URL not on the web, or a mode it cannot read', async () => {
    const {fetch, calls} = server({'https://cdn.example/denied.m3u8': {status: 403}});
    const lengths = new StreamLengths({fetch});
    expect(lengths.lengthOf('https://cdn.example/denied.m3u8')).toBeUndefined();
    expect(await lengths.probe({url: 'https://cdn.example/denied.m3u8', mode: HLS})).toBeNull();
    expect(lengths.lengthOf('https://cdn.example/denied.m3u8')).toBeNull();
    expect(await lengths.probe({url: 'blob:https://site.example/1234', mode: MP4})).toBeNull();
    expect(await lengths.probe({url: 'https://player.vimeo.com/video/1/config', mode: PlayerModes.ACCELERATED_VM})).toBeNull();
    expect(await lengths.probe({url: 'https://cdn.example/page.html', mode: HLS})).toBeNull();
    expect(calls.map((call) => call.url)).toEqual(['https://cdn.example/denied.m3u8', 'https://cdn.example/page.html']);
  });

  it('takes no length from an error answer, whatever its body says', async () => {
    const {fetch} = server({'https://cdn.example/expired.m3u8': {
      status: 403, body: '#EXTM3U\n#EXTINF:10,\ndenied.ts\n#EXT-X-ENDLIST\n',
    }});
    const lengths = new StreamLengths({fetch});
    expect(await lengths.probe({url: 'https://cdn.example/expired.m3u8', mode: HLS})).toBeNull();
  });

  it('tells an HLS or DASH stream\'s pieces by their first read, and an init segment by reaching its end', async () => {
    // A fragmented movie header: an mvhd with no length of its own, then mvex.
    const header = box('moov', concat(box('mvhd', new Uint8Array(100)), box('mvex', box('trex', new Uint8Array(24)))));
    const fragments = concat(box('moof', box('mfhd', new Uint8Array(8))), box('mdat', new Uint8Array(200000)));
    const files = {
      'https://cdn.example/v/init.mp4': {body: concat(ftyp, header)},
      'https://cdn.example/v/s1.mp4': {body: concat(box('styp', new TextEncoder().encode('msdh')), fragments)},
      'https://cdn.example/v/whole.mp4': {body: concat(ftyp, header, fragments)},
    };
    const {fetch, calls} = server(files);
    const lengths = new StreamLengths({fetch});
    expect(await lengths.probe({url: 'https://cdn.example/v/init.mp4', mode: MP4})).toBe(PIECE_LENGTH);
    expect(await lengths.probe({url: 'https://cdn.example/v/s1.mp4', mode: MP4})).toBe(PIECE_LENGTH);
    // A whole fragmented file, its length not given: unknown, its fragments after the header.
    expect(await lengths.probe({url: 'https://cdn.example/v/whole.mp4', mode: MP4})).toBeNull();
    expect(calls).toHaveLength(3);

    // A whole one whose movie header ends right where the first read does: 60 s by its mehd.
    const mehd = box('mehd', new Uint8Array(8));
    new DataView(mehd.buffer).setUint32(12, 60000);
    const mvhd = box('mvhd', new Uint8Array(100));
    new DataView(mvhd.buffer).setUint32(20, 1000);
    const fill = 64 * 1024 - ftyp.length - 24 - mvhd.length - mehd.length;
    const cut = concat(ftyp, box('moov', concat(mvhd, box('mvex', mehd), box('free', new Uint8Array(fill)))));
    expect(cut.length).toBe(64 * 1024);
    const long = server({'https://cdn.example/v/long.mp4': {body: concat(cut, fragments)}});
    expect(await new StreamLengths({fetch: long.fetch}).probe({url: 'https://cdn.example/v/long.mp4', mode: MP4})).toBe(60);

    // From a server that ignores the range: the whole init segment comes.
    const other = server(files, {ranges: false});
    expect(await new StreamLengths({fetch: other.fetch}).probe({url: 'https://cdn.example/v/init.mp4', mode: MP4})).toBe(PIECE_LENGTH);
  });

  it('counts a file still unread, or unreadable, as a piece when its like was read as one', async () => {
    const segment = concat(box('styp', new TextEncoder().encode('msdh')), box('moof', box('mfhd', new Uint8Array(8))));
    const {fetch} = server({
      'https://cdn.example/v/p.m3u8': {body: '#EXTM3U\n#EXTINF:60,\na.ts\n#EXT-X-ENDLIST\n'},
      'https://cdn.example/v/seg-14.mp4?t=1727': {body: segment},
      'https://cdn.example/v/seg-16.mp4?t=1728': {status: 403},
      'https://cdn.example/v/seg-19.mp4?t=1731': {body: concat(ftyp, moov(1400))},
      'https://cdn.example/v/film.mp4': {status: 403},
      'https://proxy.example/get?id=11': {body: segment},
    });
    const lengths = new StreamLengths({fetch});
    for (const url of ['https://cdn.example/v/p.m3u8', 'https://cdn.example/v/seg-14.mp4?t=1727',
      'https://cdn.example/v/seg-16.mp4?t=1728', 'https://cdn.example/v/seg-19.mp4?t=1731',
      'https://cdn.example/v/film.mp4', 'https://proxy.example/get?id=11']) {
      await lengths.probe({url, mode: url.endsWith('.m3u8') ? HLS : MP4});
    }

    expect(lengths.lengthsOf([
      {url: 'https://cdn.example/v/p.m3u8', mode: HLS},
      {url: 'https://cdn.example/v/seg-14.mp4?t=1727', mode: MP4},
      // Not read yet, its fragment aside, and one whose read failed: pieces, as seg-14.
      {url: 'https://cdn.example/v/seg-15.mp4?t=1729#t=0', mode: MP4},
      {url: 'https://cdn.example/v/seg-16.mp4?t=1728', mode: MP4},
      {url: 'https://cdn.example/v/seg-18.mp4?t=1730', mode: PlayerModes.DIRECT},
      // A length that was read stays, whatever the URL.
      {url: 'https://cdn.example/v/seg-19.mp4?t=1731', mode: MP4},
      // Another name, or other letters in the query: not like a piece.
      {url: 'https://cdn.example/v/film.mp4', mode: MP4},
      {url: 'https://cdn.example/v/seg-20.mp4?t=1732&sig=kq', mode: MP4},
      // One address for everything: its files are pieces, a manifest never.
      {url: 'https://proxy.example/get?id=11', mode: MP4},
      {url: 'https://proxy.example/get?id=12', mode: MP4},
      {url: 'https://proxy.example/get?id=13', mode: HLS},
    ])).toEqual([60, PIECE_LENGTH, PIECE_LENGTH, PIECE_LENGTH, PIECE_LENGTH, 1400, null, undefined,
      PIECE_LENGTH, PIECE_LENGTH, undefined]);

    // With no piece read, none is guessed.
    expect(new StreamLengths({fetch}).lengthsOf([
      {url: 'https://cdn.example/v/seg-14.mp4?t=1727', mode: MP4},
      {url: 'https://cdn.example/v/seg-15.mp4?t=1729', mode: MP4},
    ])).toEqual([undefined, undefined]);
  });

  it('gives up on a file too short to hold a box, after one read', async () => {
    const {fetch, calls} = server({'https://cdn.example/tiny.mp4': {body: new Uint8Array([0, 0, 0, 1])}});
    const lengths = new StreamLengths({fetch});
    expect(await lengths.probe({url: 'https://cdn.example/tiny.mp4', mode: MP4})).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('tells no length when a read throws', async () => {
    const lengths = new StreamLengths({fetch: async () => {
      throw new TypeError('NetworkError when attempting to fetch resource.');
    }});
    expect(await lengths.probe({url: 'https://cdn.example/a.mp4', mode: MP4})).toBeNull();
  });

  it('reads at most four at once', async () => {
    const gates = [];
    const fetch = (url) => new Promise((resolve) => gates.push(() => resolve(new Response('', {status: 404}))));
    const lengths = new StreamLengths({fetch});
    const probes = Array.from({length: 6}, (_, i) => lengths.probe({url: `https://cdn.example/${i}.m3u8`, mode: HLS}));
    // Everything the probes do before their next fetch is promise work, which is all done
    // by the next turn of the event loop: no real time needs to pass.
    const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
    await nextTurn();
    expect(gates).toHaveLength(4);
    gates.splice(0).forEach((open) => open());
    await nextTurn();
    expect(gates).toHaveLength(2);
    gates.splice(0).forEach((open) => open());
    expect(await Promise.all(probes)).toEqual([null, null, null, null, null, null]);
  });

  it('waits for the lengths no longer than asked', async () => {
    const lengths = new StreamLengths({fetch: () => new Promise(() => {})});
    const started = Date.now();
    await lengths.settle(() => [{url: 'https://cdn.example/slow.m3u8', mode: HLS}], 30);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(lengths.lengthOf('https://cdn.example/slow.m3u8')).toBeUndefined();
  });

  it('waits for the lengths until they are read', async () => {
    const {fetch} = server({'https://cdn.example/p.m3u8': {body: '#EXTM3U\n#EXTINF:60,\na.ts\n#EXT-X-ENDLIST\n'}});
    const lengths = new StreamLengths({fetch});
    await lengths.settle(() => [{url: 'https://cdn.example/p.m3u8', mode: HLS}], 60000);
    expect(lengths.lengthOf('https://cdn.example/p.m3u8')).toBe(60);
  });

  it('waits for the lengths of sources detected while it waits', async () => {
    // The page's player fetches a segment while the manifest is read.
    const segment = concat(box('styp', new TextEncoder().encode('msdh')), box('moof', box('mfhd', new Uint8Array(8))));
    const {fetch} = server({
      'https://cdn.example/p.m3u8': {body: '#EXTM3U\n#EXTINF:60,\na.ts\n#EXT-X-ENDLIST\n'},
      'https://cdn.example/s1.mp4': {body: segment},
    });
    const lengths = new StreamLengths({fetch});
    const manifest = {url: 'https://cdn.example/p.m3u8', mode: HLS};
    let asked = 0;
    await lengths.settle(() => (asked++ === 0 ? [manifest] : [manifest, {url: 'https://cdn.example/s1.mp4', mode: MP4}]), 60000);
    expect(lengths.lengthOf('https://cdn.example/p.m3u8')).toBe(60);
    expect(lengths.lengthOf('https://cdn.example/s1.mp4')).toBe(PIECE_LENGTH);
  });

  it('stops waiting at its limit, however many sources keep coming', async () => {
    // Each read ends at once, and each time a new source has come.
    const lengths = new StreamLengths({fetch: async () => new Response('', {status: 404})});
    let asked = 0;
    const started = Date.now();
    await lengths.settle(() => [{url: `https://cdn.example/s${asked++}.mp4`, mode: MP4}], 30);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('gives up on a server that never answers', async () => {
    vi.useFakeTimers();
    const fetch = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
    const lengths = new StreamLengths({fetch});
    const probe = lengths.probe({url: 'https://cdn.example/hang.m3u8', mode: HLS});
    await vi.advanceTimersByTimeAsync(8000);
    expect(await probe).toBeNull();
  });

  it('forgets the oldest lengths past its limit', async () => {
    const lengths = new StreamLengths({fetch: async () => new Response('', {status: 404})});
    for (let i = 0; i <= 300; i++) {
      await lengths.probe({url: `https://cdn.example/${i}.m3u8`, mode: HLS});
    }
    expect(lengths.lengthOf('https://cdn.example/0.m3u8')).toBeUndefined();
    expect(lengths.lengthOf('https://cdn.example/1.m3u8')).toBeNull();
    expect(lengths.lengthOf('https://cdn.example/300.m3u8')).toBeNull();
  });
});

describe('StreamLengths.queue', () => {
  it('never runs more than four reads, wherever a new one comes in as one finishes', async () => {
    // A woken waiter raced a newcomer for the freed slot, and both ran: five at once (final
    // review, 2026-10-10). The newcomer comes in after 0 to 12 microtask hops, which puts it
    // in every gap between the read finishing and the waiter going on.
    for (let hops = 0; hops <= 12; hops++) {
      const lengths = new StreamLengths({fetch: async () => new Response('')});
      let running = 0;
      let most = 0;
      const gates = [];
      const read = () => lengths.queue(async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => gates.push(resolve));
        running--;
      });
      const reads = [read(), read(), read(), read(), read()];
      await new Promise((resolve) => setTimeout(resolve, 0));
      gates.shift()();
      let later = Promise.resolve();
      for (let i = 0; i < hops; i++) later = later.then(() => {});
      await later.then(() => reads.push(read()));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(most, `${hops} hops`).toBe(4);
      while (gates.length) {
        gates.shift()();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await Promise.all(reads);
      expect(lengths.active, `${hops} hops`).toBe(0);
    }
  });
});
