// @ts-check
import {MessageTypes} from '../enums/MessageTypes.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {RequestUtils} from '../utils/RequestUtils.mjs';
import {PageFetch} from './PageFetch.mjs';
import {StreamQuery} from './StreamQuery.mjs';

// fetch() with stall timeouts, retries and byte ranges, for everything the player loads.

/** @typedef {{aborted: boolean, timedout: boolean, loaded: number, total: number, retry: number, chunkCount: number, bwEstimate: number, loading: {start: number, first: number, end: number}, parsing: {start: number, end: number}, buffering: {start: number, first: number, end: number}, error?: {code: number, text: string, retryAfter?: number, page?: string, viaPage?: boolean}}} LoaderStats */
/** @typedef {{url: string, method?: string, headers?: Object<string, string>, body?: *, responseType?: string, rangeStart: number, rangeEnd: number}} LoaderRequest */
/** @typedef {{retryDelay: number, timeout: number, maxRetry: number, maxRetryDelay: number, fetchPriority?: 'high'|'low'|'auto'|(() => 'high'|'low'|'auto')}} LoaderConfig */
/** @typedef {{url: string, status: number, headers: Object<string, string>, data: string|ArrayBuffer}} LoaderResponse */
/** @typedef {{onError: (stats: LoaderStats, request: LoaderRequest, networkDetails: null) => void, onProgress?: (stats: LoaderStats, request: LoaderRequest, data: string|ArrayBuffer, networkDetails: null) => void, onSuccess: (response: LoaderResponse, stats: LoaderStats, request: LoaderRequest, networkDetails: null) => void, onTimeout: (stats: LoaderStats, request: LoaderRequest, networkDetails: null) => void, onSlowDown?: (retryAfter: number|null) => void, onRefused?: (status: number, url: string) => void, onChunk?: (chunk: Uint8Array, offset: number, answer: PartialAnswer) => void}} LoaderCallbacks */
/** @typedef {{status: number, contentRange: string, headers: Object<string, string>}} PartialAnswer */
/**
 * What an attempt that can be resumed has received, in the file's bytes start to end (exclusive).
 * @typedef {{chunks: Uint8Array[], length: number, start: number, end: number, total: number,
 *   answer: ?PartialAnswer, etag: ?string, lastModified: ?string,
 *   first?: {url: string, status: number, headers: Object<string, string>}}} Received
 */

// Answers that refuse FastStream what the page may get: tried once more through the page.
const REFUSALS = new Set([401, 403, 404, 410]);

export const STALL_TIMEOUT_MS = 30000;

/**
 * One of REFUSALS, or a web page where media was asked for.
 * @param {Response} response
 * @param {boolean} isArrayBuffer
 * @return {boolean}
 */
export function isRefusal(response, isArrayBuffer) {
  if (REFUSALS.has(response.status)) return true;
  return isArrayBuffer && response.ok && /^text\/html\b/i.test(response.headers.get('content-type') || '');
}

const PAGE_PEEK_BYTES = 1024;

/**
 * Whether a body's first byte after blanks and a byte order mark is '<': a page, where a segment
 * a server calls text/html (page-0.html) starts with its media.
 * @param {Response} response - Read through a clone; the response itself stays unread.
 * @return {Promise<boolean>}
 */
export async function startsAsPage(response) {
  const reader = response.clone().body?.getReader();
  if (!reader) return true;
  try {
    for (let seen = 0; seen < PAGE_PEEK_BYTES;) {
      const {value, done} = await reader.read();
      if (done) return true;
      for (const byte of value) {
        if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0xef || byte === 0xbb || byte === 0xbf) continue;
        return byte === 0x3c;
      }
      seen += value.length;
    }
    return true;
  } catch (e) {
    return true;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * isRefusal, by the answer's first bytes where only its Content-Type calls it a page.
 * @param {Response} response
 * @param {boolean} isArrayBuffer
 * @return {Promise<boolean>}
 */
export async function refuses(response, isArrayBuffer) {
  if (!isRefusal(response, isArrayBuffer)) return false;
  return REFUSALS.has(response.status) || await startsAsPage(response);
}

/**
 * Retry-After is a number of seconds or an HTTP date.
 * @param {string|null} value
 * @param {number} [now]
 * @return {number|null} Milliseconds; null for no usable header.
 */
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return parseInt(text, 10) * 1000;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(date - now, 0) : null;
}

/**
 * @param {LoaderConfig} config
 * @return {'high'|'low'|'auto'}
 */
export function fetchPriorityOf(config) {
  const priority = typeof config.fetchPriority === 'function' ? config.fetchPriority() : config.fetchPriority;
  return priority === 'high' || priority === 'low' ? priority : 'auto';
}

/**
 * @param {?string} value - An ETag header.
 * @return {?string} The tag when it is a strong one: a weak one may stand for other bytes.
 */
function strongEtag(value) {
  return value && !value.startsWith('W/') ? value : null;
}

/**
 * @param {Response} response
 * @return {boolean} Whether the bytes read are not the bytes sent (fetch() undoes a Content-Encoding).
 */
function encoded(response) {
  const coding = (response.headers.get('content-encoding') || '').trim().toLowerCase();
  return coding !== '' && coding !== 'identity';
}

/**
 * Whether an answer can be resumed where it is cut, and from which bytes: a 206 for the range from
 * its start, or a 200 to a request for the whole file that offers ranges, of a known length.
 * @param {Response} response
 * @param {LoaderRequest} request
 * @return {?Received}
 */
export function resumableAnswer(response, request) {
  if (encoded(response)) return null;
  const start = request.rangeStart || 0;
  const validators = {etag: strongEtag(response.headers.get('etag')), lastModified: response.headers.get('last-modified')};
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (!range || Number(range[1]) !== start) return null;
    return {chunks: [], length: 0, start, end: Number(range[2]) + 1, total: Number(range[3]), answer: null, ...validators};
  }
  if (response.status === 200 && !request.rangeEnd && !start && /\bbytes\b/i.test(response.headers.get('accept-ranges') || '')) {
    const length = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length <= 0) return null;
    return {chunks: [], length: 0, start: 0, end: length, total: length, answer: null, ...validators};
  }
  return null;
}

/**
 * Whether an answer is the rest of the same file a cut attempt began: from the next byte to the
 * same end, of the same size and validators.
 * @param {Response} response
 * @param {Received} received
 * @return {boolean}
 */
export function continuesAt(response, received) {
  if (response.status !== 206 || encoded(response)) return false;
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
  if (!range || Number(range[1]) !== received.start + received.length || Number(range[2]) + 1 !== received.end ||
      Number(range[3]) !== received.total) {
    return false;
  }
  if (received.etag && strongEtag(response.headers.get('etag')) !== received.etag) return false;
  return !received.lastModified || response.headers.get('last-modified') === received.lastModified;
}

/**
 * @param {Response} response
 * @return {Object<string, string>} Its headers, by lower-case name.
 */
function headersOf(response) {
  /** @type {Object<string, string>} */
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

export class FetchLoader {
  constructor() {
    /** @type {number|undefined} */
    this.retryTimeout = undefined;
    // The retry waiting there follows a failure with no answer (status 0).
    this.retryOnNetwork = false;
    /** @type {?string} */
    this.pageFailure = null;
    this.viaPage = false;
    /** @type {any[]|null} */
    this.callbacks = [];
    /** @type {LoaderStats} */
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
    // An attempt that can be resumed, and what a cut one received: the next asks for the rest.
    /** @type {?Received} */
    this.receiving = null;
    /** @type {?Received} */
    this.received = null;
  }

  /** @param {LoaderCallbacks} callbacks */
  addCallbacks(callbacks) {
    if (this.callbacks !== null) {
      this.callbacks.push(callbacks);
    } else {
      throw new Error('Callbacks added too late');
    }
  }

  /**
   * @param {LoaderRequest} request
   * @param {LoaderConfig} config
   */
  load(request, config) {
    if (this.stats.loading.start) {
      throw new Error('Loader can only be used once.');
    }
    /** @type {LoaderRequest} */
    this.request = request;
    /** @type {LoaderConfig} */
    this.config = config;
    this.retryDelay = config.retryDelay;
    this.loadInternal();
  };

  abort() {
    if (this.callbacks !== null) {
      this.callbacks = null;
      this.abortInternal();
    }
  };

  destroy() {
    this.callbacks = null;
    this.abortInternal();
  }

  /** Tears down the attempt in flight, not the load: stats.aborted would swallow a retry's completion. */
  teardownAttempt() {
    self.clearTimeout(this.requestTimeout);
    self.clearTimeout(this.retryTimeout);
    this.retryTimeout = undefined;
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  abortInternal() {
    this.stats.aborted = true;
    this.received = null;
    this.receiving = null;
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
    const resume = this.received;
    if (!resume) this.stats.loading.start = self.performance.now();

    const {config, request} = this;
    if (!config) {
      return;
    }
    request.url = StreamQuery.apply(request.url);
    const stats = this.stats;
    stats.loading.first = 0;
    stats.loaded = 0;
    this.pageFailure = null;
    this.viaPage = false;

    /** @type {Object<string, string>} */
    const fetchHeaders = {};
    try {
      const headers = request.headers;
      if (headers) {
        const {customHeaderCommands, regularHeaders} = /** @type {{customHeaderCommands: FSHeaderCommand[], regularHeaders: Object<string, string>}} */ (RequestUtils.splitSpecialHeaders(headers));
        for (const header in regularHeaders) {
          if (!Object.hasOwn(regularHeaders, header)) continue;
          fetchHeaders[header] = regularHeaders[header];
        }
        // A header fetch() cannot send fails here for good, not as a network error retried six times.
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
      this.stats.error = {code: 0, text: /** @type {Error} */ (e).message};
      this.callbacks?.forEach((callbacks) => {
        callbacks.onError(this.stats, request, null);
      });
      return;
    }

    if (stats.aborted) {
      return;
    }

    if (request.rangeEnd) {
      fetchHeaders['Range'] = 'bytes=' + request.rangeStart + '-' + (request.rangeEnd - 1);
    } else if (request.rangeStart > 0) {
      // To the file's end (a DASH mediaRange of the form "first-").
      fetchHeaders['Range'] = 'bytes=' + request.rangeStart + '-';
    }
    if (resume) {
      fetchHeaders['Range'] = 'bytes=' + (resume.start + resume.length) + '-' + (resume.end - 1);
    }

    const controller = (this.controller = new AbortController());
    // A torn-down attempt's AbortError is no failure of the load: counted, it would retry twice.
    const isStale = () => stats.aborted || controller.signal.aborted;

    this.rearmTimeout();

    const isArrayBuffer = request.responseType === 'arraybuffer';
    const viaPage = PageFetch.routes(request.url);
    this.viaPage = viaPage;
    /** @type {Object<string, string>} */
    const pageHeaders = fetchHeaders['Range'] ? {Range: fetchHeaders['Range']} : {};
    let response;
    try {
      response = viaPage ? await PageFetch.fetch(request.url, {headers: pageHeaders, signal: controller.signal, priority: fetchPriorityOf(config)}) :
      await fetch(request.url, {
        method: request.method || 'GET',
        headers: fetchHeaders,
        body: request.body,
        credentials: 'same-origin',
        // 'no-store': no cache entry at all, which on a busy disk waits behind the cache's writes.
        cache: 'no-store',
        priority: fetchPriorityOf(config),
        signal: controller.signal,
      });
    } catch (e) {
      if (isStale()) {
        // teardownAttempt() aborted it on purpose.
        return;
      }
      // The page could not load it: the next try goes direct again.
      if (viaPage) PageFetch.unroute(request.url);
      this.handleLoadFailure(0, /** @type {Error} */ (e).message);
      return;
    }

    if (isStale()) {
      return;
    }

    // A file of the stream's own server refused without the stream address's key: asked again with it (StreamQuery).
    if (response.status === 401 || response.status === 403) {
      const withKey = StreamQuery.retryFor(request.url);
      if (withKey) {
        response.body?.cancel().catch(() => {});
        if (viaPage) PageFetch.unroute(request.url);
        request.url = withKey;
        this.loadInternal();
        return;
      }
    }

    if (viaPage && await refuses(response, isArrayBuffer)) {
      if (isStale()) return;
      PageFetch.unroute(request.url);
      if (response.ok) {
        response.body?.cancel().catch(() => {});
        this.handleLoadFailure(0, 'The page was given a web page');
        return;
      }
    }

    // Tried once through the page, taken only when its answer is the file; only media routes the host.
    if (!viaPage && PageFetch.available() && await refuses(response, isArrayBuffer)) {
      if (isStale()) return;
      try {
        const fromPage = await PageFetch.fetch(request.url, {headers: pageHeaders, signal: controller.signal, priority: fetchPriorityOf(config)});
        if (isStale()) return;
        if (fromPage.ok && !(await refuses(fromPage, true))) {
          if (isArrayBuffer) {
            console.log('Loading through the page from now on:', new URL(request.url).origin);
            PageFetch.route(request.url);
          }
          response.body?.cancel().catch(() => {});
          response = fromPage;
        } else {
          this.pageFailure = fromPage.ok ? 'a web page' : 'HTTP ' + fromPage.status;
          fromPage.body?.cancel().catch(() => {});
        }
      } catch (e) {
        if (isStale()) return;
        this.pageFailure = /** @type {Error} */ (e)?.message || 'no answer';
        console.warn('The page could not load it either', this.pageFailure);
      }
    }

    if (stats.loading.first === 0) {
      stats.loading.first = Math.max(self.performance.now(), stats.loading.start);
    }
    this.rearmTimeout();

    const status = response.status;
    if (resume && (status === 416 || (status >= 200 && status < 300 && !continuesAt(response, resume)))) {
      response.body?.cancel().catch(() => {});
      console.warn('The rest of a cut download is not the same file; loading it whole again:', request.url);
      this.received = null;
      this.receiving = null;
      this.loadInternal();
      return;
    }
    if (status < 200 || status >= 300) {
      // Its body is not read: let its connection go now.
      response.body?.cancel().catch(() => {});
      this.handleLoadFailure(status, response.statusText, retryAfterMs(response.headers.get('retry-after')));
      return;
    }

    // A server that ignores Range answers 200 with the whole file: the range is cut out (readBody).
    const length = parseInt(/** @type {string} */ (response.headers.get('content-length')), 10);
    const wholeFile = status === 200 && (!!request.rangeEnd || request.rangeStart > 0) && !response.headers.has('content-range') &&
        !(request.rangeStart > 0 && length === request.rangeEnd - request.rangeStart);
    // A 206 without Content-Range is taken as starting at the range; reading stops once it is in.
    const unsized = status === 206 && !!request.rangeEnd && !response.headers.has('content-range');
    const cut = wholeFile ? {rangeStart: request.rangeStart, rangeEnd: request.rangeEnd || Infinity} : unsized ? {rangeStart: 0, rangeEnd: request.rangeEnd - (request.rangeStart || 0)} : null;

    this.receiving = resume || (isArrayBuffer && !cut ? resumableAnswer(response, request) : null);
    if (this.receiving && !resume) {
      this.receiving.first = {url: response.url, status: response.status, headers: headersOf(response)};
    }

    let data;
    try {
      data = await this.readBody(response, isArrayBuffer, isStale, cut, this.receiving);
    } catch (e) {
      if (isStale()) {
        return;
      }
      this.keepReceived();
      this.handleLoadFailure(0, /** @type {Error} */ (e).message);
      return;
    }
    this.received = null;
    this.receiving = null;

    if (isStale()) {
      return;
    }

    if (wholeFile && !(isArrayBuffer ? /** @type {ArrayBuffer} */ (data).byteLength : /** @type {string} */ (data).length)) {
      // The file ends before the range starts.
      this.handleLoadFailure(416, 'Range Not Satisfiable');
      return;
    }

    self.clearTimeout(this.requestTimeout);
    stats.loading.end = Math.max(self.performance.now(), stats.loading.first);
    stats.loaded = stats.total = isArrayBuffer ? /** @type {ArrayBuffer} */ (data).byteLength : /** @type {string} */ (data).length;

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

    // A resumed load's data is the first answer's whole: its status and headers describe it.
    const first = resume?.first;
    const responseObj = {
      url: first ? first.url : response.url,
      // 200 to a range request: the whole file, cut to the range; MP4Player reads it.
      status: first ? first.status : response.status,
      headers: first ? first.headers : headersOf(response),
      data: data,
    };

    this.callbacks.forEach((callbacks) => {
      callbacks.onSuccess(responseObj, stats, request, null);
    });
    this.callbacks = null;
  }

  /**
   * Reads the body, re-arming the stall timeout on every chunk.
   * @param {Response} response
   * @param {boolean} isArrayBuffer
   * @param {() => boolean} [isStale] - True once this attempt is torn down.
   * @param {?{rangeStart: number, rangeEnd: number}} [range] - Only the range of a longer body is returned.
   * @param {?Received} [sink] - Takes the bytes as they come, after those a cut attempt received.
   * @return {Promise<ArrayBuffer|string>}
   */
  async readBody(response, isArrayBuffer, isStale = () => false, range = null, sink = null) {
    const stats = this.stats;
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      stats.total = parseInt(contentLength, 10);
    }

    if (!response.body) {
      return isArrayBuffer ? new ArrayBuffer(0) : '';
    }

    const reader = response.body.getReader();
    const store = sink || /** @type {{chunks: Uint8Array[], length: number}} */ ({chunks: [], length: 0});
    const before = store.length;
    // Each piece of a range's own answer (a 206 with its Content-Range) goes out as it comes.
    const contentRange = response.headers.get('content-range');
    /** @type {?PartialAnswer} */
    let partial = null;
    if (isArrayBuffer && !range && response.status === 206 && contentRange && this.callbacks?.some((callbacks) => callbacks.onChunk)) {
      partial = {status: 206, contentRange, headers: headersOf(response)};
    }
    // A resumed attempt's pieces go on with the first answer's, at their place in it; its size
    // is the range's, as loaded counts the bytes kept too.
    if (sink) {
      if (before) {
        partial = sink.answer;
        stats.total = sink.end - sink.start;
      } else {
        sink.answer = partial;
      }
    }
    let receivedLength = 0;
    const limit = range ? range.rangeEnd : Infinity;
    const from = range ? range.rangeStart || 0 : 0;

    while (receivedLength < limit) {
      const {done, value} = await reader.read();
      if (done) break;
      if (isStale()) {
        throw new DOMException('The attempt was torn down.', 'AbortError');
      }

      const chunkStart = receivedLength;
      receivedLength += value.byteLength;
      if (receivedLength > from) {
        const kept = value.subarray(Math.max(0, from - chunkStart), Math.max(0, limit - chunkStart));
        store.chunks.push(kept);
        store.length += kept.byteLength;
        if (partial && kept.byteLength) {
          const answer = partial;
          const offset = store.length - kept.byteLength;
          this.callbacks?.forEach((callbacks) => {
            // A reader's mistake is not the download's: it goes on, and is delivered whole.
            try {
              callbacks.onChunk?.(kept, offset, answer);
            } catch (e) {
              console.error('A reader of a download\'s pieces threw:', e);
            }
          });
        }
      }
      stats.loaded = before + receivedLength;

      this.rearmTimeout();
    }
    if (receivedLength >= limit) {
      // The rest of the file is not needed.
      reader.cancel().catch(() => {});
    }

    const merged = new Uint8Array(store.length);
    let offset = 0;
    for (const chunk of store.chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return isArrayBuffer ? merged.buffer : new TextDecoder('utf-8').decode(merged);
  }

  /**
   * @param {number} status - 0 for a network failure.
   * @param {string} statusText
   * @param {number|null} [retryAfter] - In ms: a retry waits at least that long, and a final error carries it.
   */
  handleLoadFailure(status, statusText, retryAfter = null) {
    const {stats, config, request} = this;
    self.clearTimeout(this.requestTimeout);
    // 429 and 503: told before deciding to retry, so the manager knows of a final answer too.
    if (status === 429 || status === 503) {
      this.callbacks?.forEach((callbacks) => {
        callbacks?.onSlowDown?.(retryAfter);
      });
      // onSlowDown may abort this loader synchronously (DownloadManager.slowDown).
      if (!this.callbacks) return;
    }
    // 401, 403 and 410 refuse the link itself: the player may get it anew (FreshLink).
    if (status === 401 || status === 403 || status === 410) {
      this.callbacks?.forEach((callbacks) => {
        callbacks?.onRefused?.(status, request.url);
      });
      if (!this.callbacks) return;
    }
    // The last try, or a 4xx other than 429, is final.
    if (
      stats.retry >= config.maxRetry ||
            ((status >= 400 && status < 500) && status !== 429)
    ) {
      console.error(`${status} while loading ${request.url}`);
      this.received = null;
      this.receiving = null;

      /** @type {NonNullable<LoaderStats['error']>} */
      const error = {code: status, text: statusText};
      if (retryAfter !== null) error.retryAfter = retryAfter;
      if (this.pageFailure) error.page = this.pageFailure;
      if (this.viaPage) error.viaPage = true;
      this.stats.error = error;
      this.callbacks?.forEach((callbacks) => {
        callbacks?.onError(this.stats, request, null);
      });
    } else {
      if (retryAfter !== null) {
        this.retryDelay = Math.max(this.retryDelay, Math.min(retryAfter, config.maxRetryDelay));
      }
      console.warn(
          `${status} while loading ${request.url}, retrying in ${this.retryDelay}...`,
      );
      this.retry();
      // No answer at all: retryNow may send it early. A server's answer is waited out.
      this.retryOnNetwork = status === 0;
    }
  }

  retry() {
    const {stats, config} = this;
    this.retryOnNetwork = false;
    // The attempt only: stats.aborted would swallow the retried attempt's own completion.
    this.teardownAttempt();

    self.clearTimeout(this.retryTimeout);
    this.retryTimeout = self.setTimeout(() => {
      this.retryTimeout = undefined;
      this.loadInternal();
    }, this.retryDelay);
    this.retryDelay = Math.min(
        2 * this.retryDelay,
        config.maxRetryDelay,
    );
    stats.retry++;
  }

  /**
   * A retry after no answer at all goes now; a wait a server asked for is kept.
   * @return {boolean}
   */
  retryNow() {
    if (!this.retryTimeout || !this.retryOnNetwork || this.stats.aborted) return false;
    self.clearTimeout(this.retryTimeout);
    this.retryTimeout = undefined;
    this.loadInternal();
    return true;
  }

  /** A cut attempt's bytes are kept for the next when its answer can be resumed. */
  keepReceived() {
    this.received = this.receiving?.length ? this.receiving : null;
  }

  loadtimeout() {
    console.warn(`timeout while loading ${this.request.url}`);

    if (this.stats.retry < this.config.maxRetry / 2) {
      this.keepReceived();
      this.retry();
      return;
    }

    /** @type {NonNullable<LoaderStats['error']>} */
    const error = {code: 0, text: 'No data for ' + this.config.timeout / 1000 + ' s'};
    if (this.pageFailure) error.page = this.pageFailure;
    if (this.viaPage) error.viaPage = true;
    this.stats.error = error;
    this.callbacks?.forEach((callbacks) => {
      callbacks.onTimeout(this.stats, this.request, null);
    });
    this.abortInternal();
  }
};
