import {afterEach, describe, expect, it, vi} from 'vitest';
import {RequestResult, RequestUtils} from '../../chrome/player/utils/RequestUtils.mjs';
import {URLUtils} from '../../chrome/player/utils/URLUtils.mjs';

// RequestUtils.request() made its requests with XMLHttpRequest and resolved with it, and its
// callers (subtitles, OpenSubtitles, the update check, Vimeo, archives) read status,
// response, responseText and headers off it. Since 2026-10-06 it uses fetch() and resolves
// with a RequestResult holding the same: these pin what the callers read, failures
// included - an XMLHttpRequest that failed resolved with status 0, and so does this.

/** A fetch() stub answering every call with a real Response. */
const answering = (body, init) => vi.fn(async () => new Response(body, init));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RequestUtils.request', () => {
  it('reads an ArrayBuffer, with status, URL and headers', async () => {
    vi.stubGlobal('fetch', answering(new Uint8Array([1, 2, 3]), {status: 206, headers: {'Content-Range': 'bytes 0-2/10'}}));
    const result = await RequestUtils.request({url: 'https://example.com/a', responseType: 'arraybuffer'});
    expect(result).toBeInstanceOf(RequestResult);
    expect(result.status).toBe(206);
    expect([...new Uint8Array(result.response)]).toEqual([1, 2, 3]);
    expect(result.getResponseHeader('content-range')).toBe('bytes 0-2/10');
    expect(result.getResponseHeader('X-None')).toBe(null);
    // httpGetLarge parses the whole list as XMLHttpRequest gave it.
    expect(URLUtils.headersStringToObj(result.getAllResponseHeaders())['content-range']).toBe('bytes 0-2/10');
  });

  it('reads text, which responseText gives too', async () => {
    vi.stubGlobal('fetch', answering('hello', {status: 200}));
    const result = await RequestUtils.request({url: 'https://example.com/t'});
    expect(result.response).toBe('hello');
    expect(result.responseText).toBe('hello');
  });

  it('parses JSON, and gives null for a body that is not JSON, as XMLHttpRequest did', async () => {
    vi.stubGlobal('fetch', answering('{"a":1}', {status: 200}));
    expect((await RequestUtils.request({url: 'https://example.com/j', responseType: 'json'})).response).toEqual({a: 1});
    vi.stubGlobal('fetch', answering('<html>', {status: 200}));
    expect((await RequestUtils.request({url: 'https://example.com/j', responseType: 'json'})).response).toBe(null);
  });

  it('throws from responseText for a response that is not text, as XMLHttpRequest did', async () => {
    vi.stubGlobal('fetch', answering('x', {status: 200}));
    const result = await RequestUtils.request({url: 'https://example.com/b', responseType: 'arraybuffer'});
    expect(() => result.responseText).toThrow(/only for a text response/);
  });

  it('resolves a failed request with status 0 and no response, not a rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('NetworkError when attempting to fetch resource.');
    }));
    const result = await RequestUtils.request({url: 'https://example.com/down', responseType: 'json'});
    expect(result.status).toBe(0);
    expect(result.response).toBe(null);
    expect(result.getResponseHeader('content-type')).toBe(null);
    expect(result.getAllResponseHeaders()).toBe('');
  });

  it('keeps an HTTP error\'s status and body for the caller to judge', async () => {
    vi.stubGlobal('fetch', answering('gone', {status: 404, statusText: 'Not Found'}));
    const result = await RequestUtils.request({url: 'https://example.com/404'});
    expect(result.status).toBe(404);
    expect(result.statusText).toBe('Not Found');
    expect(result.response).toBe('gone');
  });

  it('sends the query, the range, the headers, the method and the body', async () => {
    const fetchMock = answering('', {status: 200});
    vi.stubGlobal('fetch', fetchMock);
    await RequestUtils.request({
      url: 'https://example.com/q', method: 'POST', body: 'payload', usePlusForSpaces: true,
      query: {q: 'two words', empty: '', none: null, n: 3},
      range: {start: 0, end: 9}, headers: {'X-Api-Key': 'k'},
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/q?q=two+words&n=3');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('payload');
    expect(init.headers.get('Range')).toBe('bytes=0-9');
    expect(init.headers.get('X-Api-Key')).toBe('k');
  });

  it('asks the background for the special headers before it sends, and rejects when refused', async () => {
    const order = [];
    vi.stubGlobal('chrome', {extension: {}, runtime: {sendMessage: vi.fn(async (message) => {
      order.push(message.type);
    })}});
    vi.stubGlobal('fetch', vi.fn(async () => {
      order.push('fetch');
      return new Response('', {status: 200});
    }));
    const commands = [{operation: 'set', header: 'User-Agent', value: 'x'}];
    await RequestUtils.request({url: 'https://example.com/h', header_commands: commands});
    expect(order).toEqual(['SET_HEADERS', 'fetch']);
    expect(chrome.runtime.sendMessage.mock.calls[0][0]).toMatchObject({url: 'https://example.com/h', commands});

    chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('refused'));
    await expect(RequestUtils.request({url: 'https://example.com/h', header_commands: commands})).rejects.toThrow('refused');
  });

  it('tells onProgress how much of the body has come', async () => {
    vi.stubGlobal('fetch', answering(new Uint8Array(5), {status: 200, headers: {'Content-Length': '5'}}));
    const progress = [];
    const result = await RequestUtils.request({url: 'https://example.com/p', responseType: 'arraybuffer', onProgress: (e) => progress.push(e)});
    expect(result.response.byteLength).toBe(5);
    expect(progress.at(-1)).toEqual({loaded: 5, total: 5, lengthComputable: true});
  });

  it('gives a Blob, of the response\'s type, when progress is read too', async () => {
    vi.stubGlobal('fetch', answering(new Uint8Array([7, 8]), {status: 200, headers: {'Content-Type': 'image/png'}}));
    const result = await RequestUtils.request({url: 'https://example.com/i', responseType: 'blob', onProgress: () => {}});
    expect(result.status).toBe(200);
    expect(result.response).toBeInstanceOf(Blob);
    expect(result.response.type).toBe('image/png');
    expect([...new Uint8Array(await result.response.arrayBuffer())]).toEqual([7, 8]);
  });

  it('sends no body with GET or HEAD, as XMLHttpRequest dropped it (fetch() would refuse)', async () => {
    const fetchMock = answering('ok', {status: 200});
    vi.stubGlobal('fetch', fetchMock);
    const result = await RequestUtils.request({url: 'https://example.com/g', body: 'ignored'});
    expect(result.status).toBe(200);
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    await RequestUtils.request({url: 'https://example.com/g', method: 'head', data: 'ignored'});
    expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
  });

  it('refuses a responseType it cannot give', async () => {
    await expect(RequestUtils.request({url: 'https://example.com/d', responseType: 'document'})).rejects.toThrow(/no responseType "document"/);
  });
});

describe('RequestUtils.requestSimple', () => {
  it('calls back with the text on 200 and 206, and with an error for any other status', async () => {
    vi.stubGlobal('fetch', answering('body', {status: 200}));
    const ok = vi.fn();
    await RequestUtils.requestSimple('https://example.com/s', ok);
    expect(ok).toHaveBeenCalledWith(undefined, expect.any(RequestResult), 'body');

    vi.stubGlobal('fetch', answering('', {status: 500}));
    const bad = vi.fn();
    const result = await RequestUtils.requestSimple({url: 'https://example.com/s'}, bad);
    expect(result.status).toBe(500);
    expect(bad.mock.calls[0][0].message).toBe('Bad status code: 500');
    expect(bad.mock.calls[0][2]).toBe(false);
  });
});
