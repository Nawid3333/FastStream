import nodeCrypto from 'node:crypto';
import {vi} from 'vitest';
import {RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';

// The thin helper's primitives (host 15): a helper before it answers each of them so.
const ThinMessages = new Set(['play', 'ipc', 'relay']);
const UnknownMessage = Object.freeze({ok: false, error: 'unknown message', hostVersion: 14});

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
 * @param {function(Object): *} [setup.onNative] - The mpv host's answer; a current host's
 *   {ok: true} by default.
 * @param {boolean} [setup.thinHost] - The mpv host is the thin helper (host 15): onNative
 *   answers its play and ipc messages too. Without it the host is one from before (host 14),
 *   which answers them "unknown message" (onNative is not asked), and the background goes
 *   on with the messages it knows: the tests written for those keep testing them.
 * @param {string} [setup.os] - What runtime.getPlatformInfo says ('win', 'linux', 'mac'):
 *   Windows, whatever the system the tests run on.
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
  onNative = () => ({ok: true, hostVersion: RequiredHostVersion}),
  thinHost = false,
  os = 'win',
  beforeImport = () => {},
} = {}) {
  vi.useFakeTimers();
  vi.resetModules();
  // mpv's fs-id is a SHA-256 (crypto.subtle, MpvTarget.mjs), which Node computes on its
  // thread pool: under fake timers nothing waits for it, and a send to mpv never went. The
  // same hash, as the moment's microtask.
  const realDigest = Object.hasOwn(globalThis.crypto.subtle, 'digest') ? globalThis.crypto.subtle.digest : null;
  globalThis.crypto.subtle.digest = async (algorithm, data) => {
    const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    const bytes = nodeCrypto.createHash('sha256').update(view).digest();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  };

  const bg = {
    options: {...options},
    tabs,
    session,
    sentToTabs: [],
    native: [],
    // The ports connectNative opened (MPV autoplay's watch): each has what the background
    // posted (sent), emit(message) to answer as the host, and disconnected once it is closed.
    ports: [],
    // What the background sent to the extension's own pages (runtime.sendMessage: an open
    // options page hears LOAD_OPTIONS after a save of its own).
    runtimeSent: [],
    // The browser window (windows.get/update; one window, id 1): its state, and each update.
    windowState: 'maximized',
    windowUpdates: [],
    // storage.local beside the options (ProblemLog's siteProblems).
    local: {},
    badges: new Map(),
    titles: new Map(),
    // The right-click menu's items as made and updated (menus), by id; and its refreshes.
    menuItems: new Map(),
    menuRefreshes: 0,
    dynamicRules: [],
    sessionRuleUpdates: [],
    reloaded: [],
    removedTabs: [],
    createdTabs: [],
    callbackErrors: [],
  };

  const onMessage = event();
  const webRequest = {
    onBeforeRequest: event(),
    onBeforeSendHeaders: event(),
    onHeadersReceived: event(),
    onErrorOccurred: event(),
    onBeforeRedirect: event(),
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
    if (typeof callback === 'function') {
      try {
        callback(resolved);
      } catch (e) {
        // The browser reports it on the console; a test can check none was thrown.
        bg.callbackErrors.push(e);
      }
    }
    return resolved;
  });

  const chrome = {
    runtime: {
      id: 'faststream@test',
      lastError: undefined,
      getURL: (file) => 'moz-extension://bg-test/' + file,
      getManifest: () => ({version: '1.0.0'}),
      getPlatformInfo: async () => ({os, arch: 'x86-64'}),
      onInstalled: event(),
      onMessage,
      sendMessage: async (message) => {
        bg.runtimeSent.push(message);
      },
      sendNativeMessage: (name, message, callback) => {
        bg.native.push(message);
        answer(callback, !thinHost && ThinMessages.has(message?.type) ? {...UnknownMessage} : onNative(message));
      },
      connectNative: () => {
        const port = {
          sent: [], disconnected: false, onMessage: event(), onDisconnect: event(),
          postMessage: (message) => port.sent.push(message),
          disconnect: () => {
            port.disconnected = true;
          },
          emit: (message) => port.onMessage.listeners.slice().forEach((fn) => fn(message)),
          drop: () => port.onDisconnect.listeners.slice().forEach((fn) => fn()),
        };
        bg.ports.push(port);
        return port;
      },
    },
    extension: {inIncognitoContext: false},
    management: {getSelf: async () => ({installType: 'normal'})},
    i18n: {getMessage: () => ''},
    // onAdded/onRemoved: the optional "proxy" permission (Firefox VPN, VpnProxyMirror.mjs).
    permissions: {contains: (query, callback) => answer(callback, true), onAdded: event(), onRemoved: event()},
    storage: {
      local: {
        get: (key, callback) => answer(callback, {[key]: key === 'options' ? JSON.stringify(bg.options) : structuredClone(bg.local[key])}),
        // The options stay bg.options (a test changes them there); other keys are kept (bg.local).
        set: (items, callback) => {
          for (const [key, value] of Object.entries(items)) {
            if (key !== 'options') bg.local[key] = structuredClone(value);
          }
          return answer(callback, undefined);
        },
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
    menus: {
      create: (props) => {
        if (bg.menuItems.has(props.id)) throw new Error(`menus: an item ${props.id} is there already`);
        bg.menuItems.set(props.id, {...props});
        return props.id;
      },
      update: async (id, props) => {
        if (!bg.menuItems.has(id)) throw new Error(`menus: no item ${id}`);
        Object.assign(bg.menuItems.get(id), props);
      },
      removeAll: async () => {
        bg.menuItems.clear();
      },
      refresh: async () => {
        bg.menuRefreshes++;
      },
      onClicked: event(),
      onShown: event(),
    },
    windows: {
      get: async (windowId) => ({id: windowId, state: bg.windowState}),
      update: async (windowId, info) => {
        bg.windowUpdates.push({windowId, ...info});
        if (info.state) bg.windowState = info.state;
        return {id: windowId, state: bg.windowState};
      },
    },
    tabs: {
      TAB_ID_NONE: -1,
      ...tabEvents,
      query: (query, callback) => answer(callback, bg.tabs.map((t) => ({...t}))),
      get: async (tabId) => ({windowId: 1, ...(bg.tabs.find((t) => t.id === tabId) || {id: tabId})}),
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
   * @param {{tabId?: number, frameId?: number, url?: string, tab?: Object,
   *   onAnswer?: function(*): void}} [from] - Its sender; onAnswer runs the moment the answer
   *   comes, as the sender's callback does, before anything else the background has started.
   * @return {Promise<*>} The background's answer, once given (undefined for none).
   */
  bg.message = async (message, {tabId = 1, frameId = 0, url, tab, onAnswer} = {}) => {
    const sender = {
      tab: tab || {id: tabId, url: (bg.tabs.find((t) => t.id === tabId) || {}).url},
      frameId,
      url,
    };
    let reply;
    const answered = new Promise((resolve) => {
      reply = (value) => {
        onAnswer?.(value);
        resolve(value);
      };
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
   * A redirect: the request goes on to another address, with the same request id, as
   * Firefox's webRequest has it (the redirect's own response, onBeforeRedirect, then the
   * headers are sent again).
   * @param {Object} details - The request's details (bg.requestSent).
   * @param {string} to - Where it is redirected.
   * @return {Object} The request's details at its new address, for bg.responded.
   */
  bg.redirected = (details, to) => {
    const redirect = {...details, statusCode: 302, responseHeaders: [{name: 'Location', value: to}]};
    for (const listener of webRequest.onHeadersReceived.listeners) listener(redirect);
    for (const listener of webRequest.onBeforeRedirect.listeners) listener({...details, redirectUrl: to, statusCode: 302});
    const next = {...details, url: to};
    for (const listener of webRequest.onBeforeRequest.listeners) listener(next);
    for (const listener of webRequest.onBeforeSendHeaders.listeners) listener(next);
    return next;
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
   * A tab opens (tabs.onCreated): a page's pop-up or a link, when it names its opener.
   * @param {{id: number, openerTabId?: number, url?: string}} tab - The new tab.
   * @return {Promise<void>}
   */
  bg.opened = async (tab) => {
    const created = {url: 'about:blank', ...tab};
    bg.tabs.push(created);
    for (const listener of tabEvents.onCreated.listeners) listener({...created});
    await settle();
  };

  /**
   * The tab is closed.
   * @param {number} tabId - The tab.
   * @param {{isWindowClosing?: boolean}} [removeInfo] - Its window closed with it.
   * @return {Promise<void>}
   */
  bg.closed = async (tabId, removeInfo = {}) => {
    bg.tabs = bg.tabs.filter((t) => t.id !== tabId);
    for (const listener of tabEvents.onRemoved.listeners) listener(tabId, {windowId: 1, isWindowClosing: false, ...removeInfo});
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
   * The right-click menu opens in a tab (menus.onShown): its items are named for the tab.
   * @param {number} tabId - The tab.
   * @return {Promise<void>}
   */
  bg.menuShown = async (tabId) => {
    const tab = bg.tabs.find((t) => t.id === tabId) || {id: tabId};
    for (const listener of chrome.menus.onShown.listeners) await listener({contexts: ['page'], menuIds: [...bg.menuItems.keys()]}, {...tab});
    await settle();
  };

  /**
   * An item of the right-click menu is clicked in a tab (menus.onClicked).
   * @param {string} menuItemId - The item.
   * @param {number} tabId - The tab.
   * @param {Object} [info] - The rest of what Firefox tells (linkUrl, ...).
   * @return {Promise<void>}
   */
  bg.menuClick = async (menuItemId, tabId, info = {}) => {
    const tab = bg.tabs.find((t) => t.id === tabId) || {id: tabId};
    for (const listener of chrome.menus.onClicked.listeners) listener({menuItemId, ...info}, {...tab});
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
    if (realDigest) {
      globalThis.crypto.subtle.digest = realDigest;
    } else {
      delete globalThis.crypto.subtle.digest;
    }
  };

  return bg;
}
