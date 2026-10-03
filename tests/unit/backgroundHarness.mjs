import {vi} from 'vitest';

// Runs chrome/background/background.mjs in Node against a stand-in for the WebExtension
// API, for what its listeners do together: a page's request, the page naming itself, a
// toolbar click, a play. The pure helpers have their own tests; these cover the order of
// events between them, which no single function shows. Firefox itself is the e2e suites'.
//
// Each load is a fresh background (vi.resetModules), with fake timers: a test moves time
// itself (bg.wait), and nothing left over from a load fires in the next test.

/**
 * An event a listener can be added to.
 * @return {{addListener: function(Function): void, listeners: Array<Function>}}
 */
function event() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    listeners,
  };
}

/**
 * A response for the background's own reads of a stream's length (StreamLengths), which
 * reads a body through arrayBuffer() when it has no stream.
 * @param {string|Uint8Array} body - What the server sends.
 * @param {number} [status] - Its status.
 * @return {Object} A stand-in for fetch()'s Response.
 */
export function response(body, status = 200) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    body: null,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/**
 * An HLS media playlist that plays for the given seconds, in 10 s segments.
 * @param {number} seconds - Its length.
 * @return {string} The playlist.
 */
export function hlsPlaylist(seconds) {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXT-X-VERSION:3'];
  for (let left = seconds; left > 0; left -= 10) {
    lines.push(`#EXTINF:${Math.min(10, left)}.0,`, `seg-${left}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

let requestCounter = 0;

/**
 * Loads a fresh background.
 * @param {Object} [setup]
 * @param {Object} [setup.options] - The saved options (over the defaults).
 * @param {Array<Object>} [setup.tabs] - What tabs.query answers: {id, url, incognito, ...}.
 * @param {Object} [setup.session] - storage.session as the last background left it.
 * @param {function(string): (Object|Promise<Object>)} [setup.fetch] - The network, for
 *   the background's own reads; a 404 for everything by default.
 * @param {function({tabId: number, frameId: (number|undefined), message: Object}): *} [setup.onTabMessage] -
 *   A page's answer to a message the background sends it (tabs.sendMessage).
 * @param {function(Object): *} [setup.onNative] - The mpv host's answer; {ok: true} by default.
 * @param {function(): void} [setup.beforeImport] - Runs once the stand-in is in place,
 *   before the background loads: to make an API fail from the start.
 * @return {Promise<Object>} The background's handle.
 */
export async function loadBackground({
  options = {},
  tabs = [],
  session = {},
  fetch = async () => response('', 404),
  onTabMessage = () => undefined,
  onNative = () => ({ok: true}),
  beforeImport = () => {},
} = {}) {
  vi.useFakeTimers();
  vi.resetModules();

  const bg = {
    options: {...options},
    tabs,
    session,
    sentToTabs: [],
    native: [],
    badges: new Map(),
    titles: new Map(),
    dynamicRules: [],
    sessionRuleUpdates: [],
    reloaded: [],
    removedTabs: [],
    createdTabs: [],
  };

  const onMessage = event();
  const webRequest = {
    onBeforeRequest: event(),
    onBeforeSendHeaders: event(),
    onHeadersReceived: event(),
    onErrorOccurred: event(),
  };
  const tabEvents = {
    onRemoved: event(),
    onCreated: event(),
    onUpdated: event(),
  };

  /**
   * Answers a callback after the caller's own code has run, as the browser does.
   * @param {Function|undefined} callback - The callback, if any.
   * @param {*} value - What it gets, or a promise of it.
   * @return {Promise<*>} The value.
   */
  const answer = (callback, value) => Promise.resolve(value).then((resolved) => {
    if (typeof callback === 'function') callback(resolved);
    return resolved;
  });

  const chrome = {
    runtime: {
      id: 'faststream@test',
      lastError: undefined,
      getURL: (file) => 'moz-extension://bg-test/' + file,
      getManifest: () => ({version: '1.0.0'}),
      onInstalled: event(),
      onMessage,
      sendNativeMessage: (name, message, callback) => {
        bg.native.push(message);
        answer(callback, onNative(message));
      },
    },
    extension: {inIncognitoContext: false},
    management: {getSelf: async () => ({installType: 'normal'})},
    i18n: {getMessage: () => ''},
    permissions: {contains: (query, callback) => answer(callback, true)},
    storage: {
      local: {
        get: (key, callback) => answer(callback, {[key]: key === 'options' ? JSON.stringify(bg.options) : undefined}),
        set: (items, callback) => answer(callback, undefined),
      },
      session: {
        get: async () => structuredClone(session),
        set: async (items) => {
          Object.assign(session, structuredClone(items));
        },
        remove: async (key) => {
          delete session[key];
        },
      },
    },
    action: {
      onClicked: event(),
      setBadgeText: ({text, tabId}) => bg.badges.set(tabId, text),
      setTitle: ({title, tabId}) => bg.titles.set(tabId, title),
      setIcon: () => {},
    },
    commands: {onCommand: event(), getAll: async () => []},
    tabs: {
      TAB_ID_NONE: -1,
      ...tabEvents,
      query: (query, callback) => answer(callback, bg.tabs.map((t) => ({...t}))),
      get: async (tabId) => ({...(bg.tabs.find((t) => t.id === tabId) || {id: tabId})}),
      sendMessage: (tabId, message, ...rest) => {
        const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() : undefined;
        const frameId = rest[0] && typeof rest[0].frameId === 'number' ? rest[0].frameId : undefined;
        bg.sentToTabs.push({tabId, frameId, message});
        return answer(callback, onTabMessage({tabId, frameId, message}));
      },
      reload: (tabId) => {
        bg.reloaded.push(tabId);
      },
      update: (tabId, props, callback) => answer(callback, {id: tabId, ...props}),
      create: (props, callback) => {
        const tab = {id: 1000 + bg.createdTabs.length, ...props};
        bg.createdTabs.push(tab);
        return answer(callback, tab);
      },
      remove: async (tabId) => {
        bg.removedTabs.push(tabId);
      },
    },
    webRequest,
    declarativeNetRequest: {
      updateDynamicRules: async (update) => {
        bg.dynamicRules.push(update);
      },
      updateSessionRules: async (update) => {
        bg.sessionRuleUpdates.push(update);
      },
      getSessionRules: async () => [],
    },
    downloads: {download: async () => 1},
  };

  globalThis.chrome = chrome;
  bg.chrome = chrome;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => fetch(String(url), init);
  beforeImport(chrome);

  const log = console.log;
  console.log = () => {};
  try {
    await import('../../chrome/background/background.mjs');
    await settle();
  } finally {
    console.log = log;
  }

  /**
   * Lets the background's pending work run: promises, and timers due by then.
   * @param {number} [ms] - How far to move the clock.
   * @return {Promise<void>}
   */
  async function settle(ms = 0) {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(0);
  }
  bg.wait = settle;

  /**
   * Sends the background a message from a page.
   * @param {Object} message - The message.
   * @param {{tabId?: number, frameId?: number, url?: string, tab?: Object}} [from] - Its sender.
   * @return {Promise<*>} The background's answer, once given (undefined for none).
   */
  bg.message = async (message, {tabId = 1, frameId = 0, url, tab} = {}) => {
    const sender = {
      tab: tab || {id: tabId, url: (bg.tabs.find((t) => t.id === tabId) || {}).url},
      frameId,
      url,
    };
    let reply;
    const answered = new Promise((resolve) => {
      reply = resolve;
    });
    let async = false;
    for (const listener of onMessage.listeners) {
      if (listener(message, sender, reply) === true) {
        async = true;
      }
    }
    if (!async) {
      reply(undefined);
    }
    const result = await answered;
    await settle();
    return result;
  };

  /**
   * A page names itself in a frame, as content.js does as it starts (FRAME_ADDED).
   * @param {number} tabId - The tab.
   * @param {number} frameId - The frame.
   * @param {string} url - The page.
   * @param {string} document - Its name.
   * @return {Promise<*>}
   */
  bg.frameAdded = (tabId, frameId, url, document) =>
    bg.message({type: 'FRAME_ADDED', url, document}, {tabId, frameId});

  /**
   * A request a page sends, up to the moment its headers are sent.
   * @param {Object} details - webRequest's details; requestId is made up when missing.
   * @return {Object} The details, for the response to the same request.
   */
  bg.requestSent = (details) => {
    const full = {
      requestId: String(++requestCounter),
      frameId: 0,
      parentFrameId: -1,
      type: 'xmlhttprequest',
      requestHeaders: [{name: 'Referer', value: 'https://site.test/'}],
      ...details,
    };
    for (const listener of webRequest.onBeforeRequest.listeners) listener(full);
    for (const listener of webRequest.onBeforeSendHeaders.listeners) listener(full);
    return full;
  };

  /**
   * The response to a request: its headers arrive.
   * @param {Object} details - The request's details (bg.requestSent).
   * @param {Object} [extra] - statusCode, responseHeaders.
   * @return {Promise<void>}
   */
  bg.responded = async (details, extra = {}) => {
    const full = {statusCode: 200, responseHeaders: [], ...details, ...extra};
    for (const listener of webRequest.onHeadersReceived.listeners) listener(full);
    await settle();
  };

  /**
   * A request that fails, or is cancelled, before its response.
   * @param {Object} details - The request's details (bg.requestSent).
   * @return {Promise<void>}
   */
  bg.failed = async (details) => {
    for (const listener of webRequest.onErrorOccurred.listeners) listener({...details, error: 'NS_BINDING_ABORTED'});
    await settle();
  };

  /**
   * A whole request: sent, then answered.
   * @param {Object} details - webRequest's details.
   * @param {Object} [extra] - statusCode, responseHeaders.
   * @return {Promise<Object>} The details.
   */
  bg.request = async (details, extra) => {
    const sent = bg.requestSent(details);
    await bg.responded(sent, extra);
    return sent;
  };

  /**
   * The tab's address changes (tabs.onUpdated with a url).
   * @param {number} tabId - The tab.
   * @param {string} url - Its new address.
   * @return {Promise<void>}
   */
  bg.navigated = async (tabId, url) => {
    const tab = bg.tabs.find((t) => t.id === tabId);
    if (tab) tab.url = url;
    for (const listener of tabEvents.onUpdated.listeners) listener(tabId, {url}, {id: tabId, url});
    await settle();
  };

  /**
   * The tab is closed.
   * @param {number} tabId - The tab.
   * @return {Promise<void>}
   */
  bg.closed = async (tabId) => {
    bg.tabs = bg.tabs.filter((t) => t.id !== tabId);
    for (const listener of tabEvents.onRemoved.listeners) listener(tabId, {});
    await settle();
  };

  /**
   * The toolbar button is clicked in a tab.
   * @param {number} tabId - The tab.
   * @return {Promise<void>}
   */
  bg.click = async (tabId) => {
    const tab = bg.tabs.find((t) => t.id === tabId) || {id: tabId};
    for (const listener of chrome.action.onClicked.listeners) listener({...tab});
    await settle();
  };

  /**
   * A keyboard shortcut is pressed in a tab (commands.onCommand).
   * @param {string} command - toggle_player or toggle_mpv.
   * @param {number} tabId - The tab.
   * @return {Promise<void>}
   */
  bg.command = async (command, tabId) => {
    const tab = bg.tabs.find((t) => t.id === tabId) || {id: tabId};
    for (const listener of chrome.commands.onCommand.listeners) listener(command, {...tab});
    await settle();
  };

  /**
   * The messages the background sent to tabs, of one type.
   * @param {string} type - The message type.
   * @return {Array<{tabId: number, frameId: (number|undefined), message: Object}>}
   */
  bg.sent = (type) => bg.sentToTabs.filter((m) => m.message.type === type);

  /**
   * The URLs the background handed to mpv.
   * @return {Array<string>}
   */
  bg.toMpv = () => bg.native.filter((m) => m.type === 'open').map((m) => m.url);

  /**
   * Puts the real timers and network back.
   */
  bg.unload = () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    delete globalThis.chrome;
  };

  return bg;
}
