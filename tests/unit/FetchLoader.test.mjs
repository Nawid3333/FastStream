import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {FetchLoader} from '../../chrome/player/network/FetchLoader.mjs';

// FetchLoader is the single network primitive shared by HLS, DASH and MP4
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

/** Collects every callback invocation FetchLoader makes, in order. */
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

describe('FetchLoader', () => {
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

    const loader = new FetchLoader();
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

    const loader = new FetchLoader();
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

    const loader = new FetchLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest(), makeConfig());
    await vi.runAllTimersAsync();

    const [response] = recorder.calls.find((c) => c.type === 'onSuccess').args;
    expect(response.headers['content-type']).toBe('video/mp2t');
  });

  it('fetches past Firefox\'s HTTP cache, every attempt', async () => {
    // Through the cache, an attempt first waits for its cache entry: on the Windows CI
    // runner 2 to 5 s behind the cache's own writes, so a stalled load's retries stalled
    // too before reaching the server (loader-retry.e2e.mjs). 'no-store' opens none.
    const fetchMock = fetchHangingUntilAborted();
    vi.stubGlobal('fetch', fetchMock);

    const loader = new FetchLoader();
    loader.addCallbacks(makeCallbackRecorder());
    loader.load(makeRequest(), makeConfig({timeout: 100, maxRetry: 1}));
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of fetchMock.mock.calls) expect(init.cache).toBe('no-store');
  });

  it('reports a 4xx as a final error without retrying', async () => {
    const fetchMock = fetchResolving(new ArrayBuffer(0), {status: 404, statusText: 'Not Found'});
    vi.stubGlobal('fetch', fetchMock);

    const loader = new FetchLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest(), makeConfig());
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recorder.calls.map((c) => c.type)).toEqual(['onError']);
    expect(loader.stats.error).toEqual({code: 404, text: 'Not Found'});
  });

  it('counts 499 as a 4xx too (it was retried: "< 499")', async () => {
    const fetchMock = fetchResolving(new ArrayBuffer(0), {status: 499, statusText: 'Client Closed Request'});
    vi.stubGlobal('fetch', fetchMock);

    const loader = new FetchLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest(), makeConfig());
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recorder.calls.map((c) => c.type)).toEqual(['onError']);
  });

  it('retries a 5xx up to maxRetry, doubling the backoff each time, then errors', async () => {
    const fetchMock = fetchResolving(new ArrayBuffer(0), {status: 503, statusText: 'Unavailable'});
    vi.stubGlobal('fetch', fetchMock);

    const loader = new FetchLoader();
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
    const loader = new FetchLoader();
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

    const loader = new FetchLoader();
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

    const loader = new FetchLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest(), makeConfig({timeout: 500, maxRetry: 3, retryDelay: 50}));
    await vi.runAllTimersAsync();

    expect(call).toBe(2);
    expect(recorder.calls.map((c) => c.type)).toEqual(['onProgress', 'onSuccess']);
    expect(loader.stats.aborted).toBe(false);
  });

  // The stall tests above use a fetch() that never settles. A real fetch() does settle once
  // retry() aborts its controller: it rejects with an AbortError. That rejection belongs
  // to an attempt that retry() has already replaced, so it must not count as a second
  // failure - before this was handled, it went to handleLoadFailure(), which called
  // retry() again: one stall cost two retries, doubled the backoff twice and cancelled
  // the retry that was already scheduled.
  it('a stall that a real fetch() reports as an AbortError costs one retry, not two', async () => {
    const starts = [];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      call++;
      starts.push(Date.now());
      if (call === 1) {
        return fetchHangingUntilAborted()(url, init);
      }
      return Promise.resolve(new Response(new Uint8Array([7]).buffer, {status: 200}));
    }));

    const loader = new FetchLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest(), makeConfig({timeout: 500, maxRetry: 6, retryDelay: 50, maxRetryDelay: 800}));
    await vi.runAllTimersAsync();

    expect(call).toBe(2);
    expect(loader.stats.retry).toBe(1);
    // The retry waits the configured delay after the stall, not twice that.
    expect(starts[1] - starts[0]).toBe(500 + 50);
    expect(loader.retryDelay).toBe(100);
    expect(recorder.calls.map((c) => c.type)).toEqual(['onProgress', 'onSuccess']);
  });

  it('a stall retried once never reports an error before the retry succeeds', async () => {
    // maxRetry 1: the stale AbortError used to find the retry budget spent and report
    // onError, while the retry it had not cancelled went on to report onSuccess.
    let call = 0;
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      call++;
      if (call === 1) {
        return fetchHangingUntilAborted()(url, init);
      }
      return Promise.resolve(new Response(new Uint8Array([7]).buffer, {status: 200}));
    }));

    const loader = new FetchLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest(), makeConfig({timeout: 500, maxRetry: 1, retryDelay: 50}));
    await vi.runAllTimersAsync();

    expect(call).toBe(2);
    expect(recorder.calls.map((c) => c.type)).toEqual(['onProgress', 'onSuccess']);
  });

  it('a body that stalls mid-transfer is retried once per stall', async () => {
    // Headers arrive, then the body stops. The stall timer fires, retry() aborts the
    // controller, and the pending reader.read() rejects - the same stale AbortError, from
    // readBody() instead of fetch().
    let call = 0;
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      call++;
      if (call === 1) {
        const body = new ReadableStream({
          start(streamController) {
            streamController.enqueue(new Uint8Array([1, 2]));
            init.signal.addEventListener('abort', () => {
              streamController.error(new DOMException('The operation was aborted.', 'AbortError'));
            });
          },
        });
        return Promise.resolve(new Response(body, {status: 200}));
      }
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]).buffer, {status: 200}));
    }));

    const loader = new FetchLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest(), makeConfig({timeout: 500, maxRetry: 6, retryDelay: 50}));
    await vi.runAllTimersAsync();

    expect(call).toBe(2);
    expect(loader.stats.retry).toBe(1);
    const [response] = recorder.calls.find((c) => c.type === 'onSuccess').args;
    expect(new Uint8Array(response.data)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('gives up with onTimeout once retry.maxRetry/2 stall-retries are exhausted', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    const loader = new FetchLoader();
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

    const loader = new FetchLoader();
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

    const loader = new FetchLoader();
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

  it('does not fetch a load aborted while SET_HEADERS was on its way', async () => {
    let answer;
    globalThis.chrome = {
      extension: {},
      runtime: {sendMessage: vi.fn(() => new Promise((resolve) => (answer = resolve)))},
    };
    const fetchMock = fetchResolving(new ArrayBuffer(0), {status: 200});
    vi.stubGlobal('fetch', fetchMock);

    const loader = new FetchLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest({headers: {referer: 'https://origin.example/'}}), makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    expect(globalThis.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);

    loader.abort();
    answer();
    await vi.runAllTimersAsync();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(recorder.calls).toEqual([]);
  });

  it('does not call SET_HEADERS outside an extension context, and still sends the request', async () => {
    const fetchMock = fetchResolving(new ArrayBuffer(0), {status: 200});
    vi.stubGlobal('fetch', fetchMock);

    const loader = new FetchLoader();
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

    const loader = new FetchLoader();
    loader.addCallbacks(makeCallbackRecorder());
    loader.load(makeRequest({rangeStart: 100, rangeEnd: 200}), makeConfig());
    await vi.runAllTimersAsync();

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers['Range']).toBe('bytes=100-199');
  });

  it('fails at once, without retrying, for a header fetch() cannot send', async () => {
    // A name with a space (a custom header) made a real fetch() reject with a TypeError,
    // which was retried like a network error, six times over a minute (#150).
    const fetchMock = vi.fn(async (url, init) => {
      new Headers(init.headers);
      return new Response(new ArrayBuffer(0), {status: 200});
    });
    vi.stubGlobal('fetch', fetchMock);

    const loader = new FetchLoader();
    const recorder = makeCallbackRecorder();
    loader.addCallbacks(recorder);
    loader.load(makeRequest({headers: {'x-bad name': 'value'}}), makeConfig());
    await vi.runAllTimersAsync();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(loader.stats.retry).toBe(0);
    expect(recorder.calls.map((c) => c.type)).toEqual(['onError']);
  });

  describe('a server that ignores Range and sends the whole file (200)', () => {
    // It was taken for the range asked for: the file's first bytes, labelled as a range
    // further in (#139).
    const file = Uint8Array.from({length: 100}, (_, i) => i);

    /** The data a range of `file` came back as. */
    async function loadRange(rangeStart, rangeEnd, body = file, headers = {}) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {status: 200, headers})));
      const loader = new FetchLoader();
      const recorder = makeCallbackRecorder();
      loader.addCallbacks(recorder);
      loader.load(makeRequest({rangeStart, rangeEnd}), makeConfig());
      await vi.runAllTimersAsync();
      return {recorder, loader};
    }

    it('gives the range asked for, cut out of the file', async () => {
      const {recorder, loader} = await loadRange(10, 20);
      const [response] = recorder.calls.find((c) => c.type === 'onSuccess').args;
      expect([...new Uint8Array(response.data)]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
      expect(loader.stats.loaded).toBe(10);
    });

    it('stops reading the file once the range is in', async () => {
      // A body that would go on for ever after its first 30 bytes.
      let cancelled = false;
      let sent = 0;
      const endless = new ReadableStream({
        pull(controller) {
          if (sent < 30) {
            controller.enqueue(file.slice(sent, sent + 10));
            sent += 10;
            return;
          }
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
        },
      });
      const {recorder} = await loadRange(5, 15, endless);
      const [response] = recorder.calls.find((c) => c.type === 'onSuccess').args;
      expect([...new Uint8Array(response.data)]).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
      expect(cancelled).toBe(true);
    });

    it('fails a range that starts past the end of the file', async () => {
      const {recorder, loader} = await loadRange(200, 300);
      expect(recorder.calls.map((c) => c.type)).toEqual(['onError']);
      expect(loader.stats.error.code).toBe(416);
    });

    it('takes a 200 that says it is the range as the range, as before', async () => {
      const range = file.slice(10, 20);
      for (const headers of [{'content-range': 'bytes 10-19/100'}, {'content-length': '10'}]) {
        const {recorder} = await loadRange(10, 20, range, headers);
        const [response] = recorder.calls.find((c) => c.type === 'onSuccess').args;
        expect(new Uint8Array(response.data)).toEqual(range);
      }
    });

    it('leaves a whole-file request alone', async () => {
      const {recorder} = await loadRange(undefined, undefined);
      const [response] = recorder.calls.find((c) => c.type === 'onSuccess').args;
      expect(new Uint8Array(response.data)).toEqual(file);
    });
  });
});
