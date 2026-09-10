import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {XHRLoader} from '../../chrome/player/network/XHRLoader.mjs';

// XHRLoader is the single network primitive shared by HLS, DASH and MP4
// fragment/playlist loading (via DownloadManager -> StandardDownloader). It
// used to wrap XMLHttpRequest; this suite pins the fetch()-based rewrite's
// retry/backoff/timeout/abort state machine, since it previously had zero
// unit coverage and the whole thing is easy to get subtly wrong (a rejected
// fetch() is a different failure shape than a bad XHR status, and an
// aborted-for-retry attempt must not be confused with a genuinely aborted
// load - see the stats.aborted latch bug this rewrite fixes below).

/** Builds a config object matching StandardDownloader's defaults, small enough to keep tests fast. */
function makeConfig(overrides) {
  return {
    timeout: 1000,
    maxRetry: 3,
    retryDelay: 100,
    maxRetryDelay: 800,
    ...overrides,
  };
}

/** Builds a request object matching what DownloadEntry.getRequest() produces. */
function makeRequest(overrides) {
  return {
    url: 'https://example.com/fragment.ts',
    responseType: 'arraybuffer',
    headers: {},
    ...overrides,
  };
}

/** Collects every callback invocation XHRLoader makes, in order. */
function makeCallbackRecorder() {
  const calls = [];
  return {
    calls,
    onSuccess: (...args) => calls.push({type: 'onSuccess', args}),
    onError: (...args) => calls.push({type: 'onError', args}),
    onProgress: (...args) => calls.push({type: 'onProgress', args}),
    onTimeout: (...args) => calls.push({type: 'onTimeout', args}),
  };
}

/** A fetch() mock that resolves with a real Response, once, for every call. */
function fetchResolving(body, init) {
  return vi.fn(async () => new Response(body, init));
}

/**
 * A fetch() mock whose returned promise never settles on its own, but
 * rejects with an AbortError as soon as the passed-through AbortSignal
 * fires - the same contract a real fetch() honours for an aborted request.
 */
function fetchHangingUntilAborted() {
  return vi.fn((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  }));
}

describe('XHRLoader', () => {
  beforeEach(() => {
    globalThis.self = globalThis;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete globalThis.chrome;
  });

  it('resolves arraybuffer responses and reports stats.loaded/total', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    vi.stubGlobal('fetch', fetchResolving(bytes.buffer, {status: 200, headers: {'content-length': '5'}}));

    const loader = new XHRLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest(), makeConfig());
    await vi.runAllTimersAsync();

    expect(recorder.calls.map((c) => c.type)).toEqual(['onProgress', 'onSuccess']);
    const [response, stats] = recorder.calls[1].args;
    expect(new Uint8Array(response.data)).toEqual(bytes);
    expect(stats.loaded).toBe(5);
    expect(stats.total).toBe(5);
    expect(stats.aborted).toBe(false);
  });

  it('decodes text responses when responseType is not arraybuffer', async () => {
    vi.stubGlobal('fetch', fetchResolving('hello world', {status: 200}));

    const loader = new XHRLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest({responseType: 'text'}), makeConfig());
    await vi.runAllTimersAsync();

    const [response] = recorder.calls.find((c) => c.type === 'onSuccess').args;
    expect(response.data).toBe('hello world');
  });

  it('lowercases response headers into a plain object', async () => {
    vi.stubGlobal('fetch', fetchResolving(new ArrayBuffer(0), {
      status: 200,
      headers: {'Content-Type': 'video/mp2t'},
    }));

    const loader = new XHRLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest(), makeConfig());
    await vi.runAllTimersAsync();

    const [response] = recorder.calls.find((c) => c.type === 'onSuccess').args;
    expect(response.headers['content-type']).toBe('video/mp2t');
  });

  it('reports a 4xx as a final error without retrying', async () => {
    const fetchMock = fetchResolving(new ArrayBuffer(0), {status: 404, statusText: 'Not Found'});
    vi.stubGlobal('fetch', fetchMock);

    const loader = new XHRLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest(), makeConfig());
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recorder.calls.map((c) => c.type)).toEqual(['onError']);
    expect(loader.stats.error).toEqual({code: 404, text: 'Not Found'});
  });

  it('retries a 5xx up to maxRetry, doubling the backoff each time, then errors', async () => {
    const fetchMock = fetchResolving(new ArrayBuffer(0), {status: 503, statusText: 'Unavailable'});
    vi.stubGlobal('fetch', fetchMock);

    const loader = new XHRLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    // retryDelay starts at 100, doubles each retry, capped at maxRetryDelay 800.
    loader.load(makeRequest(), makeConfig({maxRetry: 3, retryDelay: 100, maxRetryDelay: 800}));
    await vi.runAllTimersAsync();

    // initial attempt + 3 retries
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(loader.stats.retry).toBe(3);
    expect(recorder.calls.map((c) => c.type)).toEqual(['onError']);
  });

  it('grows retryDelay exponentially up to the configured cap', () => {
    const loader = new XHRLoader();
    loader.request = makeRequest();
    loader.config = makeConfig({retryDelay: 100, maxRetryDelay: 800});
    loader.retryDelay = 100;
    loader.stats.retry = 0;

    loader.retry();
    expect(loader.retryDelay).toBe(200);
    loader.retry();
    expect(loader.retryDelay).toBe(400);
    loader.retry();
    expect(loader.retryDelay).toBe(800);
    loader.retry();
    expect(loader.retryDelay).toBe(800); // capped, not 1600
  });

  it('retries after a rejected fetch (network failure), same as a bad status', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++;
      if (call === 1) {
        throw new TypeError('Failed to fetch');
      }
      return new Response(new Uint8Array([9]).buffer, {status: 200, headers: {'content-length': '1'}});
    }));

    const loader = new XHRLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest(), makeConfig());
    await vi.runAllTimersAsync();

    expect(call).toBe(2);
    expect(recorder.calls.map((c) => c.type)).toEqual(['onProgress', 'onSuccess']);
  });

  it('a timeout-triggered retry can still succeed (stats.aborted must not latch true)', async () => {
    // First attempt hangs forever (simulating a stalled connection); once
    // config.timeout elapses, loadtimeout() retries. The second attempt
    // resolves successfully. Before this rewrite, abortInternal() (called to
    // tear down the stalled attempt) unconditionally set stats.aborted=true
    // with nothing to ever reset it, so the retried attempt's own
    // readystatechange/onSuccess would have been silently swallowed by the
    // `if (stats.aborted) return;` guard. This pins the fix.
    let call = 0;
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      call++;
      if (call === 1) {
        return new Promise(() => {}); // never resolves - simulates a stall
      }
      return Promise.resolve(new Response(new Uint8Array([7]).buffer, {
        status: 200,
        headers: {'content-length': '1'},
      }));
    }));

    const loader = new XHRLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest(), makeConfig({timeout: 500, maxRetry: 3, retryDelay: 50}));
    await vi.runAllTimersAsync();

    expect(call).toBe(2);
    expect(recorder.calls.map((c) => c.type)).toEqual(['onProgress', 'onSuccess']);
    expect(loader.stats.aborted).toBe(false);
  });

  it('gives up with onTimeout once retry.maxRetry/2 stall-retries are exhausted', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    const loader = new XHRLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    // maxRetry/2 = 1: one stall-retry is allowed, the second timeout gives up.
    loader.load(makeRequest(), makeConfig({timeout: 200, maxRetry: 2, retryDelay: 50}));
    await vi.runAllTimersAsync();

    expect(recorder.calls.map((c) => c.type)).toEqual(['onTimeout']);
    expect(loader.stats.aborted).toBe(true);
  });

  it('abort() during an in-flight request suppresses every later callback', async () => {
    vi.stubGlobal('fetch', fetchHangingUntilAborted());

    const loader = new XHRLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest(), makeConfig());

    await vi.advanceTimersByTimeAsync(0); // let loadInternal reach the fetch() call
    loader.abort();
    await vi.runAllTimersAsync();

    expect(recorder.calls).toEqual([]);
    expect(loader.stats.aborted).toBe(true);
  });

  it('sends SET_HEADERS before fetch() for browser-restricted headers, only when running as an extension', async () => {
    const order = [];
    globalThis.chrome = {
      extension: {},
      runtime: {
        sendMessage: vi.fn(async (msg) => {
          order.push({step: 'sendMessage', msg});
        }),
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => {
      order.push({step: 'fetch'});
      return new Response(new ArrayBuffer(0), {status: 200});
    }));

    const loader = new XHRLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest({headers: {referer: 'https://origin.example/'}}), makeConfig());
    await vi.runAllTimersAsync();

    expect(order.map((o) => o.step)).toEqual(['sendMessage', 'fetch']);
    expect(order[0].msg).toMatchObject({
      type: 'SET_HEADERS',
      url: 'https://example.com/fragment.ts',
      commands: [{operation: 'set', header: 'referer', value: 'https://origin.example/'}],
    });
  });

  it('does not call SET_HEADERS outside an extension context, and still sends the request', async () => {
    const fetchMock = fetchResolving(new ArrayBuffer(0), {status: 200});
    vi.stubGlobal('fetch', fetchMock);

    const loader = new XHRLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest({headers: {referer: 'https://origin.example/'}}), makeConfig());
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recorder.calls.map((c) => c.type)).toEqual(['onProgress', 'onSuccess']);
  });

  it('sets a Range header from rangeStart/rangeEnd', async () => {
    const fetchMock = fetchResolving(new ArrayBuffer(0), {status: 200});
    vi.stubGlobal('fetch', fetchMock);

    const loader = new XHRLoader();
    loader.addCallbacks(makeCallbackRecorder());
    loader.load(makeRequest({rangeStart: 100, rangeEnd: 200}), makeConfig());
    await vi.runAllTimersAsync();

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers['Range']).toBe('bytes=100-199');
  });
});
