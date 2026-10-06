import {MessageTypes} from '../enums/MessageTypes.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {RequestUtils} from '../utils/RequestUtils.mjs';

// Every fragment, playlist, manifest and MP4 range the player loads: fetch() with stall
// timeouts, retries with backoff, byte ranges and the stats hls.js and dash.js read. It was
// XHRLoader until 2026-10-06, named for the XMLHttpRequest it wrapped before it moved to
// fetch(). (dash.js has an XHRLoader of its own, which DashPlayer replaces by that name.)

/**
 * How long a Retry-After header asks to wait: a number of seconds or an HTTP date.
 * @param {string|null} value - The header.
 * @param {number} [now] - The time, for a date.
 * @return {number|null} Milliseconds, or null for no usable header.
 */
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return parseInt(text, 10) * 1000;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(date - now, 0) : null;
}

export class FetchLoader {
  constructor() {
    this.callbacks = [];
    this.stats = {
      aborted: false,
      timedout: false,
      loaded: 0,
      total: 0,
      retry: 0,
      chunkCount: 0,
      bwEstimate: 0,
      loading: {
        start: 0,
        first: 0,
        end: 0,
      },
      parsing: {
        start: 0,
        end: 0,
      },
      buffering: {
        start: 0,
        first: 0,
        end: 0,
      },
    };
    this.retryDelay = 0;
    this.controller = null;
    this.response = null;
  }

  addCallbacks(callbacks) {
    if (this.callbacks !== null) {
      this.callbacks.push(callbacks);
    } else {
      throw new Error('Callbacks added too late');
    }
  }

  load(request, config) {
    if (this.stats.loading.start) {
      throw new Error('Loader can only be used once.');
    }
    this.request = request;
    this.config = config;
    this.retryDelay = config.retryDelay;
    this.loadInternal();
  };

  /** Abort any loading in progress. */
  abort() {
    if (this.callbacks !== null) {
      this.callbacks = null;
      this.abortInternal();
    }
  };

  /** Destroy loading entry. */
  destroy() {
    this.callbacks = null;
    this.abortInternal();
  }

  /**
   * Tears down whatever attempt is currently in flight (timers + in-flight
   * fetch) without marking the whole load as aborted. Used both by a real
   * abort and by retry() - a retry must not leave stats.aborted latched
   * true, or the next attempt's own completion would be silently swallowed.
   */
  teardownAttempt() {
    self.clearTimeout(this.requestTimeout);
    self.clearTimeout(this.retryTimeout);
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  abortInternal() {
    this.stats.aborted = true;
    this.teardownAttempt();
  }

  rearmTimeout() {
    self.clearTimeout(this.requestTimeout);
    this.requestTimeout = self.setTimeout(
        this.loadtimeout.bind(this),
        this.config.timeout,
    );
  }

  async loadInternal() {
    this.stats.loading.start = self.performance.now();

    const {config, request} = this;
    if (!config) {
      return;
    }
    const stats = this.stats;
    stats.loading.first = 0;
    stats.loaded = 0;

    const fetchHeaders = {};
    try {
      const headers = request.headers;
      if (headers) {
        const {customHeaderCommands, regularHeaders} = RequestUtils.splitSpecialHeaders(headers);
        for (const header in regularHeaders) {
          if (!Object.hasOwn(regularHeaders, header)) continue;
          fetchHeaders[header] = regularHeaders[header];
        }
        // A header fetch() cannot send (a name with a space, a value with a line break)
        // fails here, for good: from fetch() it was a network error, retried six times.
        new Headers(fetchHeaders);

        if (customHeaderCommands.length) {
          if (EnvUtils.isExtension()) {
            await chrome.runtime.sendMessage({
              type: MessageTypes.SET_HEADERS,
              url: request.url,
              commands: customHeaderCommands,
            });
          }
        }
      }
    } catch (e) {
      this.stats.error = {code: 0, text: e.message};
      this.callbacks?.forEach((callbacks) => {
        callbacks.onError(this.stats, request, null);
      });
      return;
    }

    // Aborted while the background set the headers: the answer would be thrown away, so
    // do not ask for it.
    if (stats.aborted) {
      return;
    }

    if (request.rangeEnd) {
      fetchHeaders['Range'] = 'bytes=' + request.rangeStart + '-' + (request.rangeEnd - 1);
    }

    const controller = (this.controller = new AbortController());
    // This attempt is over once teardownAttempt() has aborted its controller - a real
    // abort, or retry() replacing it with the next attempt. A real fetch() then rejects
    // with an AbortError, and that rejection is not a failure of the load: counting it
    // as one called retry() a second time for the same stall, spending two retries,
    // doubling the backoff twice and cancelling the retry that was already scheduled.
    const isStale = () => stats.aborted || controller.signal.aborted;

    // setup timeout before we perform request - a stall at any point (no
    // headers yet, or no further body chunks) re-arms this the same way, see
    // rearmTimeout() calls below.
    this.rearmTimeout();

    let response;
    try {
      response = await fetch(request.url, {
        method: request.method || 'GET',
        headers: fetchHeaders,
        body: request.body,
        credentials: 'same-origin',
        // Not through Firefox's HTTP cache. FastStream keeps what it loads itself, a live
        // playlist must come fresh, and an attempt that goes through the cache first waits
        // for its cache entry: on a busy disk, behind the cache's own writes, before it
        // reaches the network. On the Windows CI runner every attempt of a stalled load,
        // retries included, waited 2 to 5 s that way while the cache wrote a page's ~150
        // module files, and the stall timer fired again before any reached the server
        // (loader-retry.e2e.mjs, Firefox's cache2 log of CI run 37018281037). With
        // 'no-store' Firefox opens no cache entry at all (INHIBIT_CACHING and
        // LOAD_BYPASS_CACHE; nsHttpChannel::OpenCacheEntryInternal returns before it).
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (e) {
      if (isStale()) {
        // teardownAttempt() aborted this on purpose (real abort, or retry
        // tearing down the previous attempt) - not a network failure.
        return;
      }
      this.handleLoadFailure(0, e.message);
      return;
    }

    if (isStale()) {
      return;
    }

    if (stats.loading.first === 0) {
      stats.loading.first = Math.max(self.performance.now(), stats.loading.start);
    }
    // headers received - rearm for the body phase.
    this.rearmTimeout();

    const status = response.status;
    if (status < 200 || status >= 300) {
      this.handleLoadFailure(status, response.statusText, retryAfterMs(response.headers.get('retry-after')));
      return;
    }

    this.response = response;
    const isArrayBuffer = request.responseType === 'arraybuffer';
    // A server that ignores Range answers 200 with the whole file, from its first byte. That
    // was taken for the range asked for (the file's start, labelled as a range further in);
    // the range is cut out of it now (readBody). A 200 that says it is the range (a
    // Content-Range, or exactly the range's length) is taken as one, as before.
    const length = parseInt(response.headers.get('content-length'), 10);
    const wholeFile = status === 200 && !!request.rangeEnd && !response.headers.has('content-range') &&
        !(request.rangeStart > 0 && length === request.rangeEnd - request.rangeStart);

    let data;
    try {
      data = await this.readBody(response, isArrayBuffer, isStale, wholeFile ? request : null);
    } catch (e) {
      if (isStale()) {
        return;
      }
      this.handleLoadFailure(0, e.message);
      return;
    }

    if (isStale()) {
      return;
    }

    if (wholeFile && !(isArrayBuffer ? data.byteLength : data.length)) {
      // The file ends before the range starts.
      this.handleLoadFailure(416, 'Range Not Satisfiable');
      return;
    }

    self.clearTimeout(this.requestTimeout);
    stats.loading.end = Math.max(self.performance.now(), stats.loading.first);
    stats.loaded = stats.total = isArrayBuffer ? data.byteLength : data.length;

    if (!this.callbacks) {
      return;
    }

    this.callbacks?.forEach((callbacks) => {
      if (callbacks.onProgress) {
        callbacks.onProgress(stats, request, data, null);
      }
    });

    if (!this.callbacks) {
      return;
    }

    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const responseObj = {
      url: response.url,
      headers: responseHeaders,
      data: data,
    };

    this.callbacks.forEach((callbacks) => {
      callbacks.onSuccess(responseObj, stats, request, null);
    });
    this.callbacks = null;
  }

  /**
   * Reads a fetch Response body to completion, tracking stats.loaded as
   * chunks arrive and re-arming the stall timeout on every chunk - unlike
   * the previous XHR-based loader, which only re-armed on readyState
   * transitions and could time out mid-transfer on a large, slow-but-still-
   * progressing body.
   * @param {Response} response - the fetch Response to read.
   * @param {boolean} isArrayBuffer - true to return an ArrayBuffer, false for text.
   * @param {function(): boolean} [isStale] - true once this attempt has been torn down;
   *   a chunk still delivered then must not re-arm the next attempt's stall timer.
   * @param {?{rangeStart: number, rangeEnd: number}} [range] - for a body that is the whole
   *   file although a range was asked for: only that range is returned, and reading stops
   *   once it is in.
   * @return {Promise<ArrayBuffer|string>} the concatenated response body.
   */
  async readBody(response, isArrayBuffer, isStale = () => false, range = null) {
    const stats = this.stats;
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      stats.total = parseInt(contentLength, 10);
    }

    if (!response.body) {
      return isArrayBuffer ? new ArrayBuffer(0) : '';
    }

    const reader = response.body.getReader();
    const chunks = [];
    let receivedLength = 0;
    const limit = range ? range.rangeEnd : Infinity;

    while (receivedLength < limit) {
      const {done, value} = await reader.read();
      if (done) break;
      if (isStale()) {
        throw new DOMException('The attempt was torn down.', 'AbortError');
      }

      chunks.push(value);
      receivedLength += value.byteLength;
      stats.loaded = receivedLength;

      this.rearmTimeout();
    }
    if (receivedLength >= limit) {
      // The rest of the file is not needed.
      reader.cancel().catch(() => {});
    }

    let merged = new Uint8Array(receivedLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (range) {
      merged = merged.slice(range.rangeStart || 0, range.rangeEnd);
    }

    return isArrayBuffer ? merged.buffer : new TextDecoder('utf-8').decode(merged);
  }

  /**
   * Decides whether a failed attempt (bad HTTP status or a rejected fetch,
   * status 0) should be retried or reported as a final error - shared by
   * both failure paths in loadInternal().
   * @param {number} status - HTTP status, or 0 for a network-level failure.
   * @param {string} statusText - status text / error message to report.
   * @param {number|null} [retryAfter] - The wait the server asked for (Retry-After), in ms:
   *   a retry waits at least that long (up to maxRetryDelay), and a final error carries it
   *   for the DownloadManager, which holds every download back for it.
   */
  handleLoadFailure(status, statusText, retryAfter = null) {
    const {stats, config, request} = this;
    // Stop the current attempt's stall timer regardless of outcome: retry()
    // below re-arms its own via teardownAttempt(), and a final give-up must
    // not leave a stale timer around to fire loadtimeout() again later.
    self.clearTimeout(this.requestTimeout);
    // 429 and 503 ask the player to slow down: half the downloaders stop at once. Do this
    // before deciding to retry or give up, so the manager knows even when the answer is final.
    if (status === 429 || status === 503) {
      this.callbacks?.forEach((callbacks) => {
        callbacks?.onSlowDown?.(retryAfter);
      });
      // onSlowDown can synchronously slow down and abort this loader (DownloadManager.slowDown
      // -> StandardDownloader.retire): do not retry or report a stopped loader.
      if (!this.callbacks) return;
    }
    // if max nb of retries reached or if http status between 400 and 499
    // (such error cannot be recovered, retrying is useless), return error
    // 429 is retryable like 503: the Retry-After waits below respect the server.
    if (
      stats.retry >= config.maxRetry ||
            ((status >= 400 && status < 500) && status !== 429)
    ) {
      console.error(`${status} while loading ${request.url}`);

      this.stats.error = {code: status, text: statusText};
      if (retryAfter !== null) this.stats.error.retryAfter = retryAfter;
      this.callbacks?.forEach((callbacks) => {
        callbacks?.onError(this.stats, request, null);
      });
    } else {
      // retry, no sooner than the server asked
      if (retryAfter !== null) {
        this.retryDelay = Math.max(this.retryDelay, Math.min(retryAfter, config.maxRetryDelay));
      }
      console.warn(
          `${status} while loading ${request.url}, retrying in ${this.retryDelay}...`,
      );
      this.retry();
    }
  }

  retry() {
    const {stats, config} = this;
    // Tear down the in-flight attempt only - must not set stats.aborted, or
    // the retried attempt's own completion would be silently swallowed by
    // the `if (stats.aborted) return;` guards above.
    this.teardownAttempt();

    self.clearTimeout(this.retryTimeout);
    this.retryTimeout = self.setTimeout(
        this.loadInternal.bind(this),
        this.retryDelay,
    );
    // set exponential backoff
    this.retryDelay = Math.min(
        2 * this.retryDelay,
        config.maxRetryDelay,
    );
    stats.retry++;
  }

  loadtimeout() {
    console.warn(`timeout while loading ${this.request.url}`);

    if (this.stats.retry < this.config.maxRetry / 2) {
      this.retry();
      return;
    }

    this.callbacks?.forEach((callbacks) => {
      callbacks.onTimeout(this.stats, this.request, null);
    });
    this.abortInternal();
  }

  getCacheAge() {
    const ageHeader = this.response?.headers.get('age');
    return ageHeader ? parseFloat(ageHeader) : null;
  }
};
