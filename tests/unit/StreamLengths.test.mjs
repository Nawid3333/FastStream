import {afterEach, describe, expect, it, vi} from 'vitest';

import {StreamLengths} from '../../chrome/background/StreamLengths.mjs';
import {PlayerModes} from '../../chrome/player/enums/PlayerModes.mjs';

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

  it('reads a DASH stream\'s length', async () => {
    const {fetch} = server({'https://cdn.example/a.mpd': {body: '<MPD type="static" mediaPresentationDuration="PT24M"></MPD>'}});
    const lengths = new StreamLengths({fetch});
    expect(await lengths.probe({url: 'https://cdn.example/a.mpd', mode: PlayerModes.ACCELERATED_DASH})).toBe(1440);
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gates).toHaveLength(4);
    gates.splice(0).forEach((open) => open());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gates).toHaveLength(2);
    gates.splice(0).forEach((open) => open());
    expect(await Promise.all(probes)).toEqual([null, null, null, null, null, null]);
  });

  it('waits for the lengths no longer than asked', async () => {
    const lengths = new StreamLengths({fetch: () => new Promise(() => {})});
    const started = Date.now();
    await lengths.settle([{url: 'https://cdn.example/slow.m3u8', mode: HLS}], 30);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(lengths.lengthOf('https://cdn.example/slow.m3u8')).toBeUndefined();
  });

  it('waits for the lengths until they are read', async () => {
    const {fetch} = server({'https://cdn.example/p.m3u8': {body: '#EXTM3U\n#EXTINF:60,\na.ts\n#EXT-X-ENDLIST\n'}});
    const lengths = new StreamLengths({fetch});
    await lengths.settle([{url: 'https://cdn.example/p.m3u8', mode: HLS}], 60000);
    expect(lengths.lengthOf('https://cdn.example/p.m3u8')).toBe(60);
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
