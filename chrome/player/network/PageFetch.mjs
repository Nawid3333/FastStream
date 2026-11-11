// @ts-check
// Loading a stream through its page, for what FastStream cannot load itself (the page's side:
// page-fetch.js). The player loads from its extension page, which is no part of the page that
// showed the video: a video only the page's service worker answers (abyss.to's player, #665),
// or one whose server wants the page's cookies as they are now, is refused there. The page's own
// requests are not: a content script's fetch() in Manifest V3 is made in the page's context.
//
// FetchLoader asks PageFetch first, for every request: a host that refused FastStream's request
// and answered the page's is loaded this way from then on (route), the rest as before. What comes back is a real
// Response, its body streamed as the page reads it, so FetchLoader treats it as any other.

// The port's name in the page (page-fetch.js), and the player's port to the background, which
// joins the two (PageFetchRelay.mjs), named for the page's frame.
export const PAGE_PORT_NAME = 'faststream-page-fetch';
export const RELAY_PORT_PREFIX = 'faststream-page-fetch-relay:';
// How long the page may take to answer with a request's head.
const HEAD_TIMEOUT_MS = 30000;

/**
 * A port to page-fetch.js in one frame of a tab, with the requests sent on it.
 */
export class PageFetchChannel {
  /**
   * @param {() => chrome.runtime.Port} connect - Opens the port (through the background).
   */
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
      // Its page went, or never had page-fetch.js: every request on it fails.
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
      // A Response's status is 200 to 599, and one of 204, 205 and 304 has no body (its
      // constructor throws otherwise).
      const status = Math.min(Math.max(msg.status, 200), 599);
      const response = new Response([204, 205, 304].includes(status) ? null : body, {
        status,
        statusText: typeof msg.statusText === 'string' ? msg.statusText : '',
        headers: msg.headers || {},
      });
      // Where it came from after the page's redirects, as a fetch's own Response says.
      Object.defineProperty(response, 'url', {value: typeof msg.url === 'string' && msg.url ? msg.url : request.url});
      request.head(response);
    } else if (ArrayBuffer.isView(msg.chunk)) {
      // Not `instanceof Uint8Array`: a port's message is another realm's (measured, Firefox 160:
      // "[object Uint8Array]", instanceof false), and every piece was dropped. Copied into one of
      // this page's own, which the body's readers (Response, FetchLoader) take as they take any.
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
   * Loads a URL through the page.
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
        // Ended (done, cancelled, failed): the signal no longer holds it.
        dispose: () => signal?.removeEventListener('abort', onAbort),
        fail: (/** @type {Error} */ e) => {
          clearTimeout(timer);
          request.dispose();
          // The page stops too, when its port is still open: a head that came too late, an
          // abort. A page that sent the error itself has ended it already (an unknown id there).
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
          // The head came, the body breaks off: the reader gets the error.
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

/**
 * The player's way to its page: which frame, and which hosts go through it.
 */
class PageFetchRoutes {
  constructor() {
    /** @type {?PageFetchChannel} */
    this.channel = null;
    /** @type {?string} */
    this.target = null;
    // Hosts (origins) loaded through the page.
    /** @type {Set<string>} */
    this.routed = new Set();
  }

  /**
   * The frame the player's stream came from, or none (a file, a link typed in, no page): for each
   * source the player sets. Its routes start empty: a host proves again, for each stream, that
   * only the page gets it (another episode's links may load directly). The port to the same frame
   * is kept.
   * @param {?{tabId: number, frameId: number}} target
   * @param {(tabId: number, frameId: number) => chrome.runtime.Port} [connect] - Opens a port to the frame.
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

  /** @return {boolean} Whether there is a page to load through. */
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
   * Whether a URL is loaded through the page.
   * @param {string} url
   * @return {boolean}
   */
  routes(url) {
    const origin = this.originOf(url);
    return !!this.channel && !!origin && this.routed.has(origin);
  }

  /**
   * Loads the URL's host through the page from now on.
   * @param {string} url
   */
  route(url) {
    const origin = this.originOf(url);
    if (origin && this.channel) this.routed.add(origin);
  }

  /**
   * Loads the URL's host directly again: the page could not load it.
   * @param {string} url
   */
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
 * A port to the frame, through the background (PageFetchRelay.mjs): the player's iframe in a page
 * has no tabs API, and the background joins it to the frame of the player's own tab.
 * @param {number} tabId - The player's tab (the background takes the port's own).
 * @param {number} frameId
 * @return {chrome.runtime.Port}
 */
function defaultConnect(tabId, frameId) {
  return chrome.runtime.connect({name: RELAY_PORT_PREFIX + frameId});
}

export const PageFetch = new PageFetchRoutes();
