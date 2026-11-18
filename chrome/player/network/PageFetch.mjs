// @ts-check
// Loading a stream through its page (page-fetch.js), for what only the page's context gets.

export const PAGE_PORT_NAME = 'faststream-page-fetch';
export const RELAY_PORT_PREFIX = 'faststream-page-fetch-relay:';
const HEAD_TIMEOUT_MS = 30000;

export class PageFetchChannel {
  /** @param {() => chrome.runtime.Port} connect */
  constructor(connect) {
    this.connect = connect;
    /** @type {?chrome.runtime.Port} */
    this.port = null;
    this.nextId = 1;
    /** @type {Map<number, {head: (response: Response) => void, fail: (e: Error) => void, controller: ?ReadableStreamDefaultController<Uint8Array>, url: string}>} */
    this.pending = new Map();
  }

  /** @return {chrome.runtime.Port} */
  open() {
    if (this.port) return this.port;
    const port = this.connect();
    this.port = port;
    port.onMessage.addListener((/** @type {*} */ msg) => this.onMessage(msg));
    port.onDisconnect.addListener(() => {
      if (this.port === port) this.port = null;
      const reason = new TypeError('The page is gone');
      for (const request of this.pending.values()) {
        request.fail(reason);
      }
      this.pending.clear();
    });
    return port;
  }

  /** @param {*} msg */
  onMessage(msg) {
    const request = msg && this.pending.get(msg.id);
    if (!request) return;
    if (typeof msg.error === 'string') {
      this.pending.delete(msg.id);
      request.fail(msg.error === 'AbortError' ? new DOMException('Aborted', 'AbortError') : new TypeError(msg.error));
    } else if (typeof msg.status === 'number') {
      const body = new ReadableStream({
        start: (controller) => {
          request.controller = controller;
        },
        cancel: () => {
          this.pending.delete(msg.id);
          request.dispose();
          this.port?.postMessage({abort: msg.id});
        },
      });
      // A Response's status is 200 to 599, and 204, 205 and 304 have no body.
      const status = Math.min(Math.max(msg.status, 200), 599);
      const response = new Response([204, 205, 304].includes(status) ? null : body, {
        status,
        statusText: typeof msg.statusText === 'string' ? msg.statusText : '',
        headers: msg.headers || {},
      });
      Object.defineProperty(response, 'url', {value: typeof msg.url === 'string' && msg.url ? msg.url : request.url});
      request.head(response);
    } else if (ArrayBuffer.isView(msg.chunk)) {
      // Not instanceof: a port's message is another realm's. Copied into one of this realm.
      const piece = new Uint8Array(msg.chunk.byteLength);
      piece.set(/** @type {Uint8Array} */ (msg.chunk));
      try {
        request.controller?.enqueue(piece);
      } catch (e) {
        // Its reader cancelled meanwhile.
      }
    } else if (msg.done) {
      this.pending.delete(msg.id);
      request.dispose();
      try {
        request.controller?.close();
      } catch (e) {
        // Already cancelled.
      }
    }
  }

  /**
   * @param {string} url
   * @param {{headers?: Object<string, string>, signal?: AbortSignal, priority?: string}} [init]
   * @return {Promise<Response>}
   */
  fetch(url, init = {}) {
    return new Promise((resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      let port;
      try {
        port = this.open();
      } catch (e) {
        reject(new TypeError('No page to load through: ' + /** @type {Error} */ (e)?.message));
        return;
      }
      const id = this.nextId++;
      let settled = false;
      const timer = setTimeout(() => request.fail(new TypeError('The page did not answer')), HEAD_TIMEOUT_MS);
      const onAbort = () => request.fail(new DOMException('Aborted', 'AbortError'));
      const request = {
        url,
        /** @type {?ReadableStreamDefaultController<Uint8Array>} */
        controller: null,
        head: (/** @type {Response} */ response) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          resolve(response);
        },
        dispose: () => signal?.removeEventListener('abort', onAbort),
        fail: (/** @type {Error} */ e) => {
          clearTimeout(timer);
          request.dispose();
          if (this.pending.has(id)) {
            try {
              this.port?.postMessage({abort: id});
            } catch (err) {
              // The port is gone, and the page's requests with it.
            }
          }
          this.pending.delete(id);
          if (!settled) {
            settled = true;
            reject(e);
            return;
          }
          try {
            request.controller?.error(e);
          } catch (err) {
            // Already closed or cancelled.
          }
        },
      };
      this.pending.set(id, request);
      signal?.addEventListener('abort', onAbort, {once: true});
      try {
        port.postMessage({id, url, headers: init.headers || {}, priority: init.priority});
      } catch (e) {
        request.fail(new TypeError('The page is gone'));
      }
    });
  }

  close() {
    const port = this.port;
    this.port = null;
    port?.disconnect();
    for (const request of this.pending.values()) {
      request.fail(new DOMException('Aborted', 'AbortError'));
    }
    this.pending.clear();
  }
}

class PageFetchRoutes {
  constructor() {
    /** @type {?PageFetchChannel} */
    this.channel = null;
    /** @type {?string} */
    this.target = null;
    /** @type {Set<string>} */
    this.routed = new Set();
  }

  /**
   * Routes start empty for each source: a host proves again that only the page gets it.
   * @param {?{tabId: number, frameId: number}} target
   * @param {(tabId: number, frameId: number) => chrome.runtime.Port} [connect]
   */
  configure(target, connect = defaultConnect) {
    const key = target && Number.isInteger(target.tabId) && target.tabId >= 0 && Number.isInteger(target.frameId) ?
      target.tabId + ':' + target.frameId : null;
    this.routed.clear();
    if (key === this.target) return;
    this.channel?.close();
    this.routed.clear();
    this.target = key;
    this.channel = key && target ? new PageFetchChannel(() => connect(target.tabId, target.frameId)) : null;
  }

  /** @return {boolean} */
  available() {
    return !!this.channel;
  }

  /**
   * @param {string} url
   * @return {?string}
   */
  originOf(url) {
    try {
      return new URL(url).origin;
    } catch (e) {
      return null;
    }
  }

  /**
   * @param {string} url
   * @return {boolean}
   */
  routes(url) {
    const origin = this.originOf(url);
    return !!this.channel && !!origin && this.routed.has(origin);
  }

  /** @param {string} url */
  route(url) {
    const origin = this.originOf(url);
    if (origin && this.channel) this.routed.add(origin);
  }

  /** @param {string} url */
  unroute(url) {
    const origin = this.originOf(url);
    if (origin) this.routed.delete(origin);
  }

  /**
   * @param {string} url
   * @param {{headers?: Object<string, string>, signal?: AbortSignal, priority?: string}} [init]
   * @return {Promise<Response>}
   */
  fetch(url, init) {
    if (!this.channel) return Promise.reject(new TypeError('No page to load through'));
    return this.channel.fetch(url, init);
  }
}

/**
 * @param {number} tabId
 * @param {number} frameId
 * @return {chrome.runtime.Port}
 */
function defaultConnect(tabId, frameId) {
  return chrome.runtime.connect({name: RELAY_PORT_PREFIX + frameId});
}

export const PageFetch = new PageFetchRoutes();
