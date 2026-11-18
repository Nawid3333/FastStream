import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {SNIFF_GIVE_UP_MS, sniffManifest} from '../../chrome/background/ManifestSniffer.mjs';
import {modeFromBody, worthSniffing} from '../../chrome/background/StreamDetection.mjs';
import {FetchLoader, startsAsPage} from '../../chrome/player/network/FetchLoader.mjs';
import {PageFetch} from '../../chrome/player/network/PageFetch.mjs';
import {StreamQuery} from '../../chrome/player/network/StreamQuery.mjs';

// A stream that hides what it is, as streaming hosters serve theirs: a playlist at an address naming
// no type, called text/plain (/pl/7?token=...); segments named page-0.html and called text/html;
// and a key in the playlist's address that its files need but are listed without.

const HLS = 'accelerated_hls';
const DASH = 'accelerated_dash';
const MASTER = '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=694542,RESOLUTION=640x266\n/pl/7/a\n';

/**
 * A response as webRequest gives it.
 * @param {string} url
 * @param {Object} [over]
 * @return {Object}
 */
function response(url, {statusCode = 200, method = 'GET', type = 'xmlhttprequest', contentType = 'text/plain; charset=utf-8'} = {}) {
  return {url, requestId: '1', statusCode, method, type,
    responseHeaders: contentType === null ? [] : [{name: 'Content-Type', value: contentType}]};
}

describe('which responses are read for a manifest', () => {
  it.each([
    ['a player\'s fetch of text/plain at an address naming no type', response('https://cdn.test/pl/7?token=a'), true],
    ['application/octet-stream', response('https://cdn.test/pl/7', {contentType: 'application/octet-stream'}), true],
    ['no Content-Type at all', response('https://cdn.test/pl/7', {contentType: null}), true],
    ['a .txt the server calls text/plain', response('https://cdn.test/v/list.txt'), true],
    ['a fetch Firefox calls other', response('https://cdn.test/pl/7', {type: 'other'}), true],
    ['a partial answer', response('https://cdn.test/pl/7', {statusCode: 206}), false],
    ['an error', response('https://cdn.test/pl/7', {statusCode: 403}), false],
    ['a POST', response('https://cdn.test/api', {method: 'POST'}), false],
    ['a script', response('https://cdn.test/app', {type: 'script'}), false],
    ['an image', response('https://cdn.test/px', {type: 'image'}), false],
    ['a media element\'s load', response('https://cdn.test/v', {type: 'media'}), false],
    ['JSON', response('https://cdn.test/api', {contentType: 'application/json'}), false],
    ['text/html a player fetched (some hosters call playlists so)', response('https://cdn.test/p', {contentType: 'text/html'}), true],
    ['an MPD called application/xml', response('https://cdn.test/api/manifest?id=7', {contentType: 'application/xml'}), true],
    ['an image a player fetched', response('https://cdn.test/p.png', {contentType: 'image/png'}), true],
    ['JSON by its structured suffix', response('https://cdn.test/api', {contentType: 'application/ld+json'}), false],
    ['an event stream', response('https://cdn.test/live', {contentType: 'text/event-stream'}), false],
    ['MP4 by its type', response('https://cdn.test/v', {contentType: 'application/mp4'}), false],
    ['a segment by its type', response('https://cdn.test/s', {contentType: 'video/mp2t'}), false],
    ['a .js called text/plain (hosters name playlists so)', response('https://cdn.test/app.js'), true],
    ['a .json called text/plain', response('https://cdn.test/data.json?x=1'), false],
    ['a segment named .ts', response('https://cdn.test/seg1.ts', {contentType: 'application/octet-stream'}), false],
    ['a segment named .webm', response('https://cdn.test/seg1.webm', {contentType: 'text/plain'}), false],
  ])('%s', (_, details, expected) => {
    expect(worthSniffing(details)).toBe(expected);
  });
});

describe('the mode a manifest\'s first bytes name', () => {
  it.each([
    ['an HLS master playlist', MASTER, true, HLS],
    ['an HLS media playlist', '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.005,\n/c/page-0.html\n', true, HLS],
    ['HLS after a byte order mark and blank lines', '﻿\r\n\n#EXTM3U\n#EXT-X-VERSION:3\n', true, HLS],
    ['an IPTV channel list (no #EXT-X- tag)', '#EXTM3U\n#EXTINF:-1 tvg-id="a",A\nhttp://iptv.test/1\n', true, null],
    ['a Winamp playlist', '#EXTM3U\n#EXTINF:123,Song\nsong.mp3\n', true, null],
    ['#EXTM3U alone, more to come', '#EXTM3U\n', false, undefined],
    ['the first bytes of #EXTM3U', '#EX', false, undefined],
    ['nothing yet', '', false, undefined],
    ['an empty body', '', true, null],
    ['a DASH manifest', '<?xml version="1.0" encoding="UTF-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">', true, DASH],
    ['a DASH manifest after a comment', '<!-- made by packager -->\n<MPD type="static">', true, DASH],
    ['an XML prolog cut short', '<?xml version="1.0" enc', false, undefined],
    ['other XML', '<?xml version="1.0"?><rss version="2.0">', false, null],
    ['a page', '<!DOCTYPE html><html>', false, null],
    ['JSON', '{"stream": "https://cdn.test/a.m3u8"}', false, null],
    ['a binary segment', 'G@\u00000', false, null],
    ['<MPD cut short', '<?xml version="1.0"?>\n<MP', false, undefined],
    ['a comment cut short', '<!-- packag', false, undefined],
  ])('%s', (_, text, complete, expected) => {
    expect(modeFromBody(text, complete)).toBe(expected);
  });

  it('gives up on #EXTM3U without an #EXT-X- tag in its first KB', () => {
    expect(modeFromBody('#EXTM3U\n' + '#EXTINF:-1,x\nhttp://a.test/b\n'.repeat(60), false)).toBeNull();
  });
});

/** A StreamFilter as webRequest.filterResponseData gives it, recording what it passed on. */
function fakeFilter() {
  return {
    written: /** @type {number[][]} */ ([]),
    disconnected: false,
    closed: false,
    ondata: null,
    onstop: null,
    onerror: null,
    /** @param {ArrayBuffer} data */
    write(data) {
      this.written.push(Array.from(new Uint8Array(data)));
    },
    disconnect() {
      this.disconnected = true;
    },
    close() {
      this.closed = true;
    },
    /** @param {string} text */
    send(text) {
      this.ondata({data: new TextEncoder().encode(text).buffer});
    },
  };
}

const bytesOf = (text) => Array.from(new TextEncoder().encode(text));

describe('reading a response\'s first bytes on their way to the page', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tells HLS from the first piece, passes it on and lets the rest go', async () => {
    const filter = fakeFilter();
    const mode = sniffManifest(() => filter, '1');
    filter.send(MASTER);
    expect(await mode).toBe(HLS);
    expect(filter.written).toEqual([bytesOf(MASTER)]);
    expect(filter.disconnected).toBe(true);
  });

  it('waits for a second piece when the first is too short to tell', async () => {
    const filter = fakeFilter();
    let mode;
    sniffManifest(() => filter, '1').then((m) => mode = m);
    filter.send('#EXT');
    await Promise.resolve();
    expect(mode).toBeUndefined();
    expect(filter.disconnected).toBe(false);
    filter.send('M3U\n#EXT-X-VERSION:3\n');
    await Promise.resolve();
    expect(mode).toBe(HLS);
    expect(filter.written).toEqual([bytesOf('#EXT'), bytesOf('M3U\n#EXT-X-VERSION:3\n')]);
  });

  it('lets a response go at once when its first bytes are no manifest', async () => {
    const filter = fakeFilter();
    const mode = sniffManifest(() => filter, '1');
    filter.send('{"ok":true}');
    expect(await mode).toBeNull();
    expect(filter.disconnected).toBe(true);
    expect(filter.written).toEqual([bytesOf('{"ok":true}')]);
  });

  it('decides at the end of a short body, and closes the filter', async () => {
    const filter = fakeFilter();
    const mode = sniffManifest(() => filter, '1');
    filter.send('#EXTM3U\n');
    filter.onstop();
    expect(await mode).toBeNull();
    expect(filter.closed).toBe(true);
    expect(filter.disconnected).toBe(false);
  });

  it('is no manifest when the response fails, or the filter cannot be had', async () => {
    const filter = fakeFilter();
    const mode = sniffManifest(() => filter, '1');
    filter.onerror();
    expect(await mode).toBeNull();
    expect(await sniffManifest(() => {
      throw new Error('Invalid request ID');
    }, '1')).toBeNull();
  });

  it('lets a response that sends nothing go after a while', async () => {
    vi.useFakeTimers();
    const filter = fakeFilter();
    const mode = sniffManifest(() => filter, '1');
    await vi.advanceTimersByTimeAsync(SNIFF_GIVE_UP_MS);
    expect(await mode).toBeNull();
    expect(filter.disconnected).toBe(true);
  });
});

describe('the stream address\'s key, for files listed without it', () => {
  afterEach(() => {
    StreamQuery.configure(null);
  });

  it('is added to a file of the same server that lacks it, keeping the file\'s own query', () => {
    StreamQuery.configure('https://cdn.test/pl/7?token=abc&exp=9');
    expect(StreamQuery.withQuery('https://cdn.test/c/page-0.html')).toBe('https://cdn.test/c/page-0.html?token=abc&exp=9');
    expect(StreamQuery.withQuery('https://cdn.test/c/page-0.html?exp=1')).toBe('https://cdn.test/c/page-0.html?exp=1&token=abc');
    expect(StreamQuery.withQuery('https://cdn.test/c/page-0.html?token=x&exp=1')).toBeNull();
  });

  it('never goes to another server', () => {
    StreamQuery.configure('https://cdn.test/pl/7?token=abc');
    expect(StreamQuery.withQuery('https://other.test/c/page-0.html')).toBeNull();
    expect(StreamQuery.withQuery('http://cdn.test/c/page-0.html')).toBeNull();
    expect(StreamQuery.retryFor('https://other.test/c/page-0.html')).toBeNull();
  });

  it('is added before asking only once a file was refused without it, until the next stream', () => {
    StreamQuery.configure('https://cdn.test/pl/7?token=abc');
    expect(StreamQuery.apply('https://cdn.test/c/page-0.html')).toBe('https://cdn.test/c/page-0.html');
    expect(StreamQuery.retryFor('https://cdn.test/c/page-0.html')).toBe('https://cdn.test/c/page-0.html?token=abc');
    // Not before the retry was given the file: a 403 the key does not cure changes nothing else.
    expect(StreamQuery.apply('https://cdn.test/c/page-1.html')).toBe('https://cdn.test/c/page-1.html');
    StreamQuery.confirm();
    expect(StreamQuery.apply('https://cdn.test/c/page-1.html')).toBe('https://cdn.test/c/page-1.html?token=abc');
    StreamQuery.configure('https://cdn.test/pl/8?token=def');
    expect(StreamQuery.apply('https://cdn.test/c/page-1.html')).toBe('https://cdn.test/c/page-1.html');
  });

  it('is none for a stream address without a query', () => {
    StreamQuery.configure('https://cdn.test/v/master.m3u8');
    expect(StreamQuery.retryFor('https://cdn.test/v/seg1.ts')).toBeNull();
    StreamQuery.configure(null);
    expect(StreamQuery.retryFor('https://cdn.test/v/seg1.ts')).toBeNull();
  });
});

describe('FetchLoader with a disguised stream', () => {
  beforeEach(() => {
    globalThis.self = globalThis;
    vi.useFakeTimers();
  });

  afterEach(() => {
    StreamQuery.configure(null);
    PageFetch.configure(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Loads one request, all timers run; its callbacks, in order. */
  async function load(url) {
    const calls = [];
    const loader = new FetchLoader();
    loader.addCallbacks({
      onSuccess: (...args) => calls.push({type: 'onSuccess', args}),
      onError: (...args) => calls.push({type: 'onError', args}),
      onProgress: () => {},
      onTimeout: (...args) => calls.push({type: 'onTimeout', args}),
    });
    loader.load({url, responseType: 'arraybuffer', headers: {}}, {timeout: 1000, maxRetry: 0, retryDelay: 100, maxRetryDelay: 800});
    await vi.runAllTimersAsync();
    return calls;
  }

  /** A server that refuses /c/ files without ?token=abc. */
  function keyedServer() {
    return vi.fn(async (url) => new URL(url).searchParams.get('token') === 'abc' ?
      new Response(new Uint8Array([0x47, 1, 2]), {status: 200, headers: {'content-type': 'video/mp2t'}}) :
      new Response('Forbidden', {status: 403}));
  }

  it('asks a refused file again with the stream address\'s key, and the next ones with it at once', async () => {
    StreamQuery.configure('https://cdn.test/pl/7?token=abc');
    const server = keyedServer();
    vi.stubGlobal('fetch', server);

    const first = await load('https://cdn.test/c/page-0.html');
    expect(first.map((c) => c.type)).toEqual(['onSuccess']);
    expect(server.mock.calls.map(([url]) => url)).toEqual(['https://cdn.test/c/page-0.html', 'https://cdn.test/c/page-0.html?token=abc']);

    server.mockClear();
    await load('https://cdn.test/c/page-1.html');
    expect(server.mock.calls.map(([url]) => url)).toEqual(['https://cdn.test/c/page-1.html?token=abc']);
  });

  it('asks the next file without the key when the key did not cure a refusal (a signed-URL server)', async () => {
    StreamQuery.configure('https://cdn.test/v/master.m3u8?X-Amz-Signature=abc');
    const server = vi.fn(async (url) => new Response('Forbidden', {status: url.includes('seg7.ts') ? 403 : 200}));
    vi.stubGlobal('fetch', server);
    const calls = await load('https://cdn.test/v/seg7.ts');
    expect(calls.map((c) => c.type)).toEqual(['onError']);
    expect(server.mock.calls.map(([url]) => url)).toEqual(['https://cdn.test/v/seg7.ts', 'https://cdn.test/v/seg7.ts?X-Amz-Signature=abc']);
    server.mockClear();
    expect((await load('https://cdn.test/v/seg8.ts')).map((c) => c.type)).toEqual(['onSuccess']);
    expect(server.mock.calls.map(([url]) => url)).toEqual(['https://cdn.test/v/seg8.ts']);
  });

  it('asks the page again for a refusal a server words as text, which only its type calls a page', async () => {
    for (const body of ['Access denied', '{"error":"expired"}']) {
      const page = vi.fn(() => ({postMessage: () => {}, disconnect: () => {}, onMessage: {addListener: () => {}}, onDisconnect: {addListener: () => {}}}));
      PageFetch.configure({tabId: 1, frameId: 0}, page);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {status: 200, headers: {'content-type': 'text/html'}})));
      const loader = new FetchLoader();
      loader.addCallbacks({onSuccess: () => {}, onError: () => {}, onProgress: () => {}, onTimeout: () => {}});
      loader.load({url: 'https://cdn.test/c/page-0.html', responseType: 'arraybuffer', headers: {}}, {timeout: 1000, maxRetry: 0, retryDelay: 100, maxRetryDelay: 800});
      await vi.advanceTimersByTimeAsync(50);
      expect(page, body).toHaveBeenCalled();
      loader.abort();
      PageFetch.configure(null);
    }
  });

  it('keeps the refusal of another server\'s file, without the key', async () => {
    StreamQuery.configure('https://cdn.test/pl/7?token=abc');
    const server = keyedServer();
    vi.stubGlobal('fetch', server);
    const calls = await load('https://other.test/c/page-0.html');
    expect(calls.map((c) => c.type)).toEqual(['onError']);
    expect(calls[0].args[0].error.code).toBe(403);
    expect(server.mock.calls.map(([url]) => url)).toEqual(['https://other.test/c/page-0.html']);
  });

  it('takes a segment the server calls text/html by its bytes, without asking the page again', async () => {
    const page = vi.fn();
    PageFetch.configure({tabId: 1, frameId: 0}, page);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0x47, 0x40, 0, 0x30]), {status: 200, headers: {'content-type': 'text/html; charset=UTF-8'}})));
    const calls = await load('https://cdn.test/c/page-0.html');
    expect(calls.map((c) => c.type)).toEqual(['onSuccess']);
    expect(Array.from(new Uint8Array(calls[0].args[0].data))).toEqual([0x47, 0x40, 0, 0x30]);
    expect(page).not.toHaveBeenCalled();
  });
});

describe('a body that starts as a page', () => {
  it.each([
    ['a page', '<!DOCTYPE html><html>', true],
    ['a page after blanks and a byte order mark', '﻿ \r\n\t<html>', true],
    ['an empty body', '', true],
    ['an MPEG-TS segment', 'G@\u0000', false],
    ['an MP4 fragment', '\u0000\u0000\u0000\u0018styp', false],
    ['a refusal in words', 'Access denied', true],
    ['a refusal as JSON', '{"error":"expired"}', true],
    ['an ID3-tagged audio segment', 'ID3\u0004\u0000\u0000\u0000\u0000\u0000', false],
  ])('%s', async (_, body, expected) => {
    const answer = new Response(new TextEncoder().encode(body), {status: 200, headers: {'content-type': 'text/html'}});
    expect(await startsAsPage(answer)).toBe(expected);
    // The answer itself stays whole for the loader.
    expect(new TextDecoder('utf-8', {ignoreBOM: true}).decode(await answer.arrayBuffer())).toBe(body);
  });
});
