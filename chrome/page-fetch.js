// @ts-check
// Loads a stream for FastStream's player as the page itself would (PageFetch.mjs, the player's
// side). A page's own requests carry what FastStream's player, loading from its extension page,
// cannot: they go through the page's service worker, which can be the only place a video's
// address answers (abyss.to's player: "Video not found" from anywhere else, #665), and they carry
// the page's cookies, its Referer and its Origin as they are now. In Manifest V3 a content
// script's own fetch() is made in the page's context (measured, Firefox 160: through the page's
// service worker, with its cookies, Referer and Origin, ranges answered 206), so nothing here
// touches the page's own functions, and the page sees no change to them.
//
// Only FastStream can ask: a port the background opens with tabs.connect (PageFetchRelay.mjs, for
// its player, which has no tabs API in a page's iframe), which no web page can open. Each request
// is answered on the port with its head ({id, status, statusText, url, headers}), then its body in
// pieces ({id, chunk}), then {id, done} - or {id, error} at any point. {abort: id} stops one; a port that closes stops all of its own.
(() => {
  const PORT_NAME = 'faststream-page-fetch';
  // The headers a request may name; the rest are the page's own (cookies, Referer, Origin).
  const ALLOWED_HEADERS = new Set(['range', 'accept', 'if-range']);

  /**
   * Where a request was answered: its own address when it was not redirected, with its fragment,
   * which a Response's URL never has and a service worker may need (abyss.to's: #mp4/...).
   * @param {Response} response
   * @param {string} url - The request's.
   * @return {string}
   */
  function answeredAt(response, url) {
    return response.url && response.url !== url.split('#')[0] ? response.url : url;
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    // From this extension only (its background, for the player in this tab), never a page:
    // tabs.connect is no web page's to call, and its sender is one of the extension's URLs.
    if (port.sender?.id !== chrome.runtime.id || !String(port.sender?.url || '').startsWith(chrome.runtime.getURL(''))) {
      port.disconnect();
      return;
    }
    /** @type {Map<number, AbortController>} */
    const running = new Map();
    let open = true;
    port.onDisconnect.addListener(() => {
      open = false;
      running.forEach((controller) => controller.abort());
      running.clear();
    });
    /** @param {*} message */
    const send = (message) => {
      if (!open) return false;
      try {
        port.postMessage(message);
        return true;
      } catch (e) {
        open = false;
        return false;
      }
    };

    port.onMessage.addListener((/** @type {*} */ msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (typeof msg.abort === 'number') {
        running.get(msg.abort)?.abort();
        running.delete(msg.abort);
        return;
      }
      const {id, url} = msg;
      if (typeof id !== 'number' || typeof url !== 'string' || running.has(id)) return;
      let target;
      try {
        target = new URL(url, location.href);
      } catch (e) {
        send({id, error: 'Invalid URL'});
        return;
      }
      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        send({id, error: 'Not an http(s) URL'});
        return;
      }
      /** @type {Object<string, string>} */
      const headers = {};
      for (const [name, value] of Object.entries(msg.headers || {})) {
        if (ALLOWED_HEADERS.has(name.toLowerCase()) && typeof value === 'string') headers[name] = value;
      }
      const controller = new AbortController();
      running.set(id, controller);
      // load() answers every failure on the port itself: nothing is left to catch.
      load(id, target.href, headers, msg.priority, controller.signal).catch(() => {}).finally(() => running.delete(id));
    });

    /**
     * @param {number} id
     * @param {string} url
     * @param {Object<string, string>} headers
     * @param {*} priority - 'high', 'low' or 'auto' (FetchLoader's).
     * @param {AbortSignal} signal
     */
    async function load(id, url, headers, priority, signal) {
      try {
        const response = await fetch(url, {
          headers,
          // As a page's <video> asks for its file: with the cookies of the site it goes to.
          credentials: 'include',
          // FastStream keeps what it loads itself (FetchLoader's reason for no-store).
          cache: 'no-store',
          priority: priority === 'high' || priority === 'low' ? priority : 'auto',
          signal,
        });
        /** @type {Object<string, string>} */
        const head = {};
        response.headers.forEach((value, name) => {
          head[name] = value;
        });
        if (!send({id, status: response.status, statusText: response.statusText, url: answeredAt(response, url), headers: head})) {
          return;
        }
        if (!response.body) {
          send({id, done: true});
          return;
        }
        const reader = response.body.getReader();
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          // A copy of the piece this script owns: one from the page's world could not be sent.
          if (!send({id, chunk: new Uint8Array(value)})) {
            reader.cancel().catch(() => {});
            return;
          }
        }
        send({id, done: true});
      } catch (e) {
        const error = /** @type {Error} */ (e);
        send({id, error: error?.name === 'AbortError' ? 'AbortError' : String(error?.message || e)});
      }
    }
  });
})();
