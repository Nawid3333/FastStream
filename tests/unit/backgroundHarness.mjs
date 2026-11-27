import nodeCrypto from 'node:crypto';
import {vi} from 'vitest';
import {RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';
import {withoutFsTags} from '../../chrome/background/MpvTarget.mjs';

/**
 * What a play message hands mpv, read back from its target (MpvTarget.mjs): url, the stream's address without the
 * fs-* tags; contentType, pageUrl, qualities and private from those tags; start as a number; headers as
 * {name, value}. The message's other fields as sent.
 * @param {Object} message - The play message.
 * @return {Object}
 */
export function playOf(message) {
  const target = String(message.target);
  const hash = target.indexOf('#');
  /** @type {Object<string, string>} */
  const tags = {};
  for (const part of hash === -1 ? [] : target.slice(hash + 1).split('&')) {
    const equals = part.indexOf('=');
    if (part.startsWith('fs-') && equals !== -1) tags[part.slice(0, equals)] = part.slice(equals + 1);
  }
  const played = {...message, url: withoutFsTags(target)};
  if (tags['fs-content']) played.contentType = tags['fs-content'];
  if (tags['fs-page']) played.pageUrl = decodeURIComponent(tags['fs-page']);
  if (tags['fs-quality']) played.qualities = JSON.parse(decodeURIComponent(tags['fs-quality']));
  if (tags['fs-private'] === '1') played.private = true;
  if (message.start !== undefined) played.start = Number(message.start);
  if (Array.isArray(message.headers)) {
    played.headers = message.headers.map((field) => {
      const colon = field.indexOf(': ');
      return {name: field.slice(0, colon), value: field.slice(colon + 2)};
    });
  }
  return played;
}

/**
 * The helper's answer as the real one sends it: with its version, unless the test names one (an older helper's), and
 * a play's with the window it played in (the one on its own pipe, unless the test names one).
 * @param {Object} message - What the background sent.
 * @param {*} answer - The test's answer.
 * @return {*}
 */
function asHelper(message, answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return answer;
  const versioned = 'hostVersion' in answer ? answer : {...answer, hostVersion: RequiredHostVersion};
  return message?.type === 'play' && !('window' in versioned) ? {...versioned, window: ''} : versioned;
}

/**
 * The helper and mpv behind a relay port by default: connected at once, and mpv has none of the properties it is asked,
 * so a window that plays takes a stream at once (askWindow), as one without mpv-config's faststream-offer.lua.
 * @param {Object} message - What the background posted.
 * @return {Object|undefined} The answer.
 */
export function plainMpv(message) {
  if (message.type === 'relay') return {type: 'relaying'};
  if (message.type === 'mpv' && message.id !== undefined && message.command?.[0] === 'get_property') {
    return {type: 'mpv-reply', id: message.id, error: 'property unavailable'};
  }
  return undefined;
}

/**
 * A relay port (backgroundHarness's) spoken to in watch events, for tests about what the background does with them:
 * emit takes {type: 'watching'|'path'|'ended'|'request'|'closed'} and sends mpv's own lines for it (MpvRelayWatch.mjs
 * reads them back as those events); sent reads what the background told mpv back as {type: 'notify', title, detail,
 * seconds?}, {type: 'hide'} and {type: 'state', autoplay}, with every other message as posted. The helper is told
 * connected to mpv at once, as it says when it is.
 * @param {Object} port - A port from bg.ports.
 * @return {{emit: function(Object): void, drop: function(): void, sent: Array<Object>, disconnected: boolean, port: Object}}
 */
export function mpvEvents(port) {
  const line = (data) => port.emit({type: 'mpv', data});
  const path = (data) => {
    port.mpvPath = data;
    line({event: 'property-change', id: 1, name: 'path', data});
  };
  if (!port.relaying) {
    port.relaying = true;
    port.emit({type: 'relaying'});
  }
  return {
    port,
    emit(event) {
      if (event.type === 'watching') {
        port.emit({type: 'relaying'});
      } else if (event.type === 'path') {
        path(event.path);
      } else if (event.type === 'ended') {
        if (port.mpvPath !== event.path) path(event.path);
        line({event: 'end-file', reason: 'eof'});
      } else if (event.type === 'request') {
        line({event: 'client-message', args: ['faststream-' + event.action]});
      } else {
        port.emit(event);
      }
    },
    drop: () => port.drop(),
    get disconnected() {
      return port.disconnected;
    },
    get sent() {
      return port.sent.map((m) => {
        const [name, ...args] = m.type === 'mpv' && Array.isArray(m.command) ? m.command : [];
        if (name === 'script-message-to' && args[0] === 'notify' && args[1] === 'show') {
          return {type: 'notify', title: args[3], detail: args[4], ...(args[5] !== undefined ? {seconds: Number(args[5])} : {})};
        }
        if (name === 'script-message-to' && args[0] === 'notify' && args[1] === 'hide') return {type: 'hide'};
        if (name === 'set_property' && args[0] === 'user-data/faststream/autoplay') return {type: 'state', autoplay: args[1]};
        return m;
      });
    },
  };
}

// Runs background.mjs in Node against a stand-in for the WebExtension API: the order of events
// between listeners.
// Each load is a fresh background (vi.resetModules) with fake timers: a test moves time itself
// (bg.wait).

// What tabs.onUpdated's filter may name on the desktop (Firefox's tabs.json, UpdatePropertyName).
const TabUpdateProperties = ['attention', 'audible', 'autoDiscardable', 'discarded', 'favIconUrl', 'groupId', 'hidden',
  'isArticle', 'mutedInfo', 'pinned', 'sharingState', 'splitViewId', 'status', 'title', 'url'];

/**
 * An event a listener can be added to.
 * @param {function(*): void} [checkFilter] - Throws for a filter Firefox refuses.
 * @return {{addListener: function(Function): void, listeners: Array<Function>}}
 */
function event(checkFilter) {
  const listeners = [];
  // Firefox's filter, by listener (tabs.onUpdated's {properties}).
  const filters = new Map();
  return {
    addListener: (fn, filter) => {
      if (filter !== undefined) checkFilter?.(filter);
      listeners.push(fn);
      if (filter) filters.set(fn, filter);
    },
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    listeners,
    filters,
  };
}

/**
 * A response for the background's own reads of a stream's length (StreamLengths), which
 * reads a body through arrayBuffer() when it has no stream.
 * @param {string|Uint8Array} body - What the server sends.
 * @param {number} [status] - Its status.
 * @param {string} [contentType] - Its Content-Type, none by default.
 * @return {Object} A stand-in for fetch()'s Response.
 */
export function response(body, status = 200, contentType = '') {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    headers: new Headers(contentType ? {'Content-Type': contentType} : {}),
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
 * @param {function(Object): *} [setup.onNative] - The mpv host's answer, {ok: true} by default; with the current
 *   version unless it names one.
 * @param {function(Object, Object): (Object|Array<Object>|undefined)} [setup.onPortMessage] - What mpv answers over a
 *   port the background opened (relay), to a message it posted there: emitted back a moment later. plainMpv by default.
 * @param {string} [setup.os] - What runtime.getPlatformInfo says ('win', 'linux', 'mac'):
 *   Windows, whatever the system the tests run on.
 * @param {function(): void} [setup.beforeImport] - Runs once the stand-in is in place,
 *   before the background loads: to make an API fail from the start.
 * @param {Promise<void>} [setup.sessionReady] - storage.session answers once it settles: a
 *   message can then come before the kept tab state is back, as the message that wakes an
 *   event page does.
 * @return {Promise<Object>} The background's handle.
 */
export async function loadBackground({
  options = {},
  tabs = [],
  session = {},
  fetch = async () => response('', 404),
  onTabMessage = () => undefined,
  onNative = () => ({ok: true}),
  onPortMessage = plainMpv,
  os = 'win',
  beforeImport = () => {},
  sessionReady = Promise.resolve(),
  filterResponseData = undefined,
} = {}) {
  vi.useFakeTimers();
  vi.resetModules();
  // fs-id's SHA-256 runs on Node's thread pool, which fake timers never wait for: the same hash as
  // a microtask.
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
    // storage.local beside the options.
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
    alarms: new Map(),
  };

  const onMessage = event();
  const webRequest = {
    onBeforeRequest: event(),
    onBeforeSendHeaders: event(),
    onHeadersReceived: event(),
    onErrorOccurred: event(),
    onBeforeRedirect: event(),
    // Firefox's StreamFilter, for the manifest a response's first bytes tell (ManifestSniffer).
    ...(filterResponseData ? {filterResponseData} : {}),
  };
  const tabEvents = {
    onRemoved: event(),
    onCreated: event(),
    onUpdated: event((filter) => {
      const unknown = (filter.properties ?? []).filter((name) => !TabUpdateProperties.includes(name));
      if (unknown.length) throw new Error(`Type error for parameter filter (Invalid enumeration value "${unknown[0]}") for tabs.onUpdated.`);
    }),
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
      onStartup: event(),
      onMessage,
      // A player's port to its page (PageFetchRelay.mjs).
      onConnect: event(),
      sendMessage: async (message) => {
        bg.runtimeSent.push(message);
      },
      sendNativeMessage: (name, message, callback) => {
        bg.native.push(message);
        answer(callback, Promise.resolve(onNative(message)).then((reply) => asHelper(message, reply)));
      },
      connectNative: () => {
        const port = {
          sent: [], disconnected: false, onMessage: event(), onDisconnect: event(),
          postMessage: (message) => {
            port.sent.push(message);
            const reply = onPortMessage(message, port);
            if (reply) Promise.resolve().then(() => [reply].flat().forEach((m) => port.emit(m)));
          },
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
        get: async () => {
          await sessionReady;
          return structuredClone(session);
        },
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
    // Each goes off at its time on the fake clock; bg.alarms has those set.
    alarms: {
      create: (name, {when}) => {
        clearTimeout(bg.alarms.get(name)?.timer);
        const timer = setTimeout(() => {
          bg.alarms.delete(name);
          for (const listener of chrome.alarms.onAlarm.listeners.slice()) listener({name, scheduledTime: when});
        }, Math.max(0, when - Date.now()));
        bg.alarms.set(name, {when, timer});
      },
      clear: async (name) => {
        clearTimeout(bg.alarms.get(name)?.timer);
        return bg.alarms.delete(name);
      },
      onAlarm: event(),
    },
  };

  globalThis.chrome = chrome;
  bg.chrome = chrome;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => fetch(String(url), init);
  beforeImport(chrome);

  const log = console.log;
  console.log = () => {};
  /** @type {Object<string, 'own'|'any'>} */
  let senders = {};
  try {
    ({MessageSenders: senders} = await import('../../chrome/background/background.mjs'));
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
   *   Without a url, one of FastStream's own messages comes from its player page.
   * @return {Promise<*>} The background's answer, once given (undefined for none).
   */
  bg.message = async (message, {tabId = 1, frameId = 0, url, tab, onAnswer} = {}) => {
    const sender = {
      tab: tab || {id: tabId, url: (bg.tabs.find((t) => t.id === tabId) || {}).url},
      frameId,
      // A message only FastStream's own pages send (MessageSenders) comes from the player,
      // unless the test names another sender: a content script's is ignored.
      url: url ?? (senders[message?.type] === 'own' ? 'moz-extension://bg-test/player/index.html' : undefined),
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
    await bg.tabChanged(tabId, {url});
  };

  /**
   * Something of a tab changes (tabs.onUpdated): its address, title, sound, loading state.
   * A listener added with Firefox's filter hears only a change of a property it lists.
   * @param {number} tabId - The tab.
   * @param {Object} changeInfo - What changed, as Firefox tells it.
   * @return {Promise<void>}
   */
  bg.tabChanged = async (tabId, changeInfo) => {
    const tab = {id: tabId, ...changeInfo};
    for (const listener of tabEvents.onUpdated.listeners) {
      const properties = tabEvents.onUpdated.filters.get(listener)?.properties;
      if (!properties || properties.some((name) => name in changeInfo)) listener(tabId, changeInfo, tab);
    }
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
   * Firefox starts (runtime.onStartup).
   * @return {Promise<void>}
   */
  bg.startup = async () => {
    for (const listener of chrome.runtime.onStartup.listeners) listener();
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
   * The play messages the background sent, read back (playOf).
   * @return {Array<Object>}
   */
  bg.played = () => bg.native.filter((m) => m.type === 'play').map(playOf);

  /**
   * The URLs the background handed to mpv.
   * @return {Array<string>}
   */
  bg.toMpv = () => bg.played().map((m) => m.url);

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
