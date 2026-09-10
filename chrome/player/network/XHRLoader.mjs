import {MessageTypes} from '../enums/MessageTypes.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {RequestUtils} from '../utils/RequestUtils.mjs';

export class XHRLoader {
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

    if (request.rangeEnd) {
      fetchHeaders['Range'] = 'bytes=' + request.rangeStart + '-' + (request.rangeEnd - 1);
    }

    const controller = (this.controller = new AbortController());

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
        signal: controller.signal,
      });
    } catch (e) {
      if (stats.aborted) {
        // teardownAttempt() aborted this on purpose (real abort, or retry
        // tearing down the previous attempt) - not a network failure.
        return;
      }
      this.handleLoadFailure(0, e.message);
      return;
    }

    if (stats.aborted) {
      return;
    }

    if (stats.loading.first === 0) {
      stats.loading.first = Math.max(self.performance.now(), stats.loading.start);
    }
    // headers received - rearm for the body phase.
    this.rearmTimeout();

    const status = response.status;
    if (status < 200 || status >= 300) {
      this.handleLoadFailure(status, response.statusText);
      return;
    }

    this.response = response;
    const isArrayBuffer = request.responseType === 'arraybuffer';

    let data;
    try {
      data = await this.readBody(response, isArrayBuffer);
    } catch (e) {
      if (stats.aborted) {
        return;
      }
      this.handleLoadFailure(0, e.message);
      return;
    }

    if (stats.aborted) {
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
   * @return {Promise<ArrayBuffer|string>} the concatenated response body.
   */
  async readBody(response, isArrayBuffer) {
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

    while (true) {
      const {done, value} = await reader.read();
      if (done) break;

      chunks.push(value);
      receivedLength += value.byteLength;
      stats.loaded = receivedLength;

      this.rearmTimeout();
    }

    const merged = new Uint8Array(receivedLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return isArrayBuffer ? merged.buffer : new TextDecoder('utf-8').decode(merged);
  }

  /**
   * Decides whether a failed attempt (bad HTTP status or a rejected fetch,
   * status 0) should be retried or reported as a final error - shared by
   * both failure paths in loadInternal().
   * @param {number} status - HTTP status, or 0 for a network-level failure.
   * @param {string} statusText - status text / error message to report.
   */
  handleLoadFailure(status, statusText) {
    const {stats, config, request} = this;
    // Stop the current attempt's stall timer regardless of outcome: retry()
    // below re-arms its own via teardownAttempt(), and a final give-up must
    // not leave a stale timer around to fire loadtimeout() again later.
    self.clearTimeout(this.requestTimeout);
    // if max nb of retries reached or if http status between 400 and 499
    // (such error cannot be recovered, retrying is useless), return error
    if (
      stats.retry >= config.maxRetry ||
            (status >= 400 && status < 499)
    ) {
      console.error(`${status} while loading ${request.url}`);

      this.stats.error = {code: status, text: statusText};
      this.callbacks?.forEach((callbacks) => {
        callbacks?.onError(this.stats, request, null);
      });
    } else {
      // retry
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
