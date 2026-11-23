// @ts-check

// Firefox VPN skips an extension's requests: FastStream's to a host go the way the page's latest request to it went.

/** Proxy types whose every setting webRequest reports, so a copy is the same proxy. */
const CopyableTypes = ['http', 'https'];

const MaxHosts = 200;

/**
 * @typedef {Object} HostEntry
 * @property {string} key
 * @property {number} tabId
 */

/** Not xmlhttprequest: a content script's fetch looks like the page's and always goes direct. */
const PageLoadTypes = ['main_frame', 'sub_frame', 'script', 'stylesheet', 'image', 'font', 'media'];

/**
 * A frame's own loads, not its document: Firefox VPN decides by the loading document's site,
 * so a frame's document goes its embedder's way.
 */
const FrameLoadTypes = ['script', 'stylesheet', 'image', 'font', 'media'];

/** Per tab: a page with more frames or streams than this is not one a person watches. */
const MaxSourceFrames = 32;

/**
 * The frames of a tab's page that streams came from.
 * @typedef {Object} SourceFrames
 * @property {Map<number, string>} ways - The way each frame's loads go: a Firefox VPN proxy's key, '' for any other.
 * @property {Map<string, number>} hosts - A stream's host, and the frame it last came from.
 * @property {number} newest - The frame of the newest stream.
 */

/**
 * @typedef {{type: string, host: string, port: number, proxyAuthorizationHeader?: string,
 *   connectionIsolationKey?: string, failoverTimeout?: number}} ProxyInfo
 */

/**
 * @typedef {Object} SeenProxy
 * @property {string} type
 * @property {string} host
 * @property {number} port
 * @property {string} [proxyAuthorizationHeader]
 * @property {string} [connectionIsolationKey]
 * @property {number} [failoverTimeout]
 */

/**
 * @param {string} url
 * @return {string}
 */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

export class VpnProxyMirror {
  /**
   * @param {Object} env
   * @param {string} env.origin
   * @param {() => any} env.getProxyApi
   */
  constructor({origin, getProxyApi}) {
    this.origin = origin;
    this.getProxyApi = getProxyApi;
    /** @type {Map<string, HostEntry>} */
    this.hosts = new Map();
    /** @type {Map<number, string>} */
    this.tabs = new Map();
    /** @type {Map<number, SourceFrames>} */
    this.sources = new Map();
    /** @type {Map<string, SeenProxy>} */
    this.proxies = new Map();
    this.permitted = false;
    /** @type {Array<(details: Parameters<VpnProxyMirror['proxyFor']>[0]) => ReturnType<VpnProxyMirror['proxyFor']>>} */
    this.listeners = [];
    /** @type {string[]} */
    this.listenerUrls = [];
  }

  /**
   * @param {{originUrl?: string, documentUrl?: string}} details
   * @return {boolean}
   */
  isOwnRequest(details) {
    const from = details.originUrl || details.documentUrl || '';
    return from.startsWith(this.origin);
  }

  /**
   * @param {SeenProxy} info
   * @return {string}
   */
  static keyOf(info) {
    return `${info.type}://${info.host}:${info.port}`;
  }

  /**
   * @param {boolean|undefined} incognito
   * @param {string} host
   * @return {string}
   */
  static hostKey(incognito, host) {
    return (incognito ? 'p|' : 'n|') + host;
  }

  /**
   * @param {?ProxyInfo|undefined} info
   * @return {?string}
   */
  rememberProxy(info) {
    if (!info || !info.type || info.type === 'direct') return null;
    /** @type {SeenProxy} */
    const seen = {
      type: String(info.type),
      host: String(info.host),
      port: Number(info.port),
      proxyAuthorizationHeader: info.proxyAuthorizationHeader || undefined,
      connectionIsolationKey: info.connectionIsolationKey || undefined,
      failoverTimeout: typeof info.failoverTimeout === 'number' ? info.failoverTimeout : undefined,
    };
    const key = VpnProxyMirror.keyOf(seen);
    this.proxies.set(key, seen);
    if (this.proxies.size > MaxHosts * 2) this.forgetUnusedProxies(key);
    return key;
  }

  /**
   * Not the one just seen: its caller names it next.
   * @param {string} keep
   */
  forgetUnusedProxies(keep) {
    const used = new Set([keep, ...this.tabs.values()]);
    for (const tab of this.sources.values()) for (const key of tab.ways.values()) used.add(key);
    for (const entry of this.hosts.values()) used.add(entry.key);
    for (const key of this.proxies.keys()) {
      if (!used.has(key)) this.proxies.delete(key);
    }
  }

  /**
   * A host goes off once its own tab's page reaches it directly: a content script's fetch, or another tab, may go direct by itself.
   * @param {{url: string, tabId: number, frameId?: number, parentFrameId?: number, type?: string, incognito?: boolean,
   *   originUrl?: string, documentUrl?: string, proxyInfo?: ?ProxyInfo}} details
   */
  noteRequest(details) {
    const host = hostOf(details.url);
    if (!host) return;
    if (this.isOwnRequest(details)) {
      this.noteOwnRequest(details, host);
      return;
    }
    const hostKey = VpnProxyMirror.hostKey(details.incognito, host);
    const key = this.rememberProxy(details.proxyInfo);
    if (details.tabId >= 0) this.noteFrameLoad(details, key);
    if (!key) {
      // The top frame's: a frame of a site left out of the VPN loads its parts directly.
      if (details.frameId === 0 && PageLoadTypes.includes(details.type || '')) this.tabs.delete(details.tabId);
      const entry = this.hosts.get(hostKey);
      if (entry && details.tabId >= 0 && entry.tabId === details.tabId &&
          !this.guessFor(details.tabId, {frameId: details.frameId, host})) {
        this.hosts.delete(hostKey);
        this.updateListener();
      }
      return;
    }
    // Only Firefox VPN's (a token): a network-settings or PAC proxy applies to FastStream's requests by itself, per host.
    if (details.tabId >= 0 && (details.frameId ?? 0) === 0) {
      if (details.proxyInfo?.proxyAuthorizationHeader) this.tabs.set(details.tabId, key);
      else this.tabs.delete(details.tabId);
    }
    const entry = this.hosts.get(hostKey);
    if (entry) {
      const copyable = this.copyable(entry.key);
      entry.key = key;
      if (details.tabId >= 0) entry.tabId = details.tabId;
      if (this.copyable(key) !== copyable) this.updateListener();
    }
  }

  /**
   * @param {string} key
   * @return {boolean}
   */
  copyable(key) {
    return CopyableTypes.includes(this.proxies.get(key)?.type || '');
  }

  /**
   * A new page starts over; later, a stream's frame's own loads tell its way (the VPN turned off or on for its site).
   * @param {{tabId: number, frameId?: number, type?: string, proxyInfo?: ?ProxyInfo}} details
   * @param {?string} key
   */
  noteFrameLoad(details, key) {
    if (details.type === 'main_frame') {
      this.sources.delete(details.tabId);
      return;
    }
    const ways = this.sources.get(details.tabId)?.ways;
    const frameId = details.frameId ?? 0;
    if (!ways?.has(frameId) || details.type === 'sub_frame') return;
    // Firefox VPN's never carries a content script's fetch, and a content script's may go direct or through a PAC file's.
    if (key && details.proxyInfo?.proxyAuthorizationHeader) ways.set(frameId, key);
    else if (FrameLoadTypes.includes(details.type || '')) ways.set(frameId, '');
  }

  /**
   * @param {{url: string, tabId: number, frameId?: number, incognito?: boolean, originUrl?: string,
   *   documentUrl?: string, proxyInfo?: ?ProxyInfo}} details
   * @param {{stream?: boolean}} [options] - Not a stream (a subtitle file, which a content script may fetch): its way is not the frame's.
   */
  noteSource(details, {stream = true} = {}) {
    const host = hostOf(details.url);
    if (!host || details.tabId < 0 || this.isOwnRequest(details)) return;
    const key = this.rememberProxy(details.proxyInfo);
    if (stream) this.noteSourceFrame(details.tabId, details.frameId ?? 0, host, key && details.proxyInfo?.proxyAuthorizationHeader ? key : '');
    if (key) this.addHost(VpnProxyMirror.hostKey(details.incognito, host), key, details.tabId);
  }

  /**
   * @param {number} tabId
   * @param {number} frameId
   * @param {string} host
   * @param {string} way
   */
  noteSourceFrame(tabId, frameId, host, way) {
    let tab = this.sources.get(tabId);
    if (!tab) {
      tab = {ways: new Map(), hosts: new Map(), newest: frameId};
      this.sources.set(tabId, tab);
    }
    tab.ways.delete(frameId);
    tab.ways.set(frameId, way);
    tab.hosts.delete(host);
    tab.hosts.set(host, frameId);
    tab.newest = frameId;
    // The oldest go first; never the frame just seen.
    while (tab.ways.size > MaxSourceFrames) tab.ways.delete(/** @type {number} */ (tab.ways.keys().next().value));
    while (tab.hosts.size > MaxSourceFrames) tab.hosts.delete(/** @type {string} */ (tab.hosts.keys().next().value));
  }

  /**
   * Firefox VPN decides by the site of the frame that loads: the way of the frame a stream came from, else the page's.
   * Which frame: the one asking (the player's own requests name its frame as their parent), else the one the host's
   * stream came from, else the newest stream's.
   * @param {number|undefined} tabId
   * @param {{frameId?: number, host?: string}} [from]
   * @return {string|undefined} The key of the Firefox VPN proxy a host the page was not seen asking would go through.
   */
  guessFor(tabId, {frameId, host} = {}) {
    if (tabId === undefined || tabId < 0) return undefined;
    const tab = this.sources.get(tabId);
    if (!tab) return this.tabs.get(tabId);
    let frame = frameId !== undefined && tab.ways.has(frameId) ? frameId : undefined;
    if (frame === undefined && host) frame = tab.hosts.get(host);
    if (frame === undefined || !tab.ways.has(frame)) frame = tab.newest;
    return tab.ways.get(frame) || undefined;
  }

  /**
   * From the next request on: the proxy is chosen before webRequest hears of a request.
   * @param {{tabId: number, parentFrameId?: number, incognito?: boolean}} details
   * @param {string} host
   */
  noteOwnRequest(details, host) {
    const key = this.guessFor(details.tabId, {frameId: details.parentFrameId, host});
    if (key) this.addHost(VpnProxyMirror.hostKey(details.incognito, host), key, details.tabId);
  }

  /**
   * @param {string} hostKey
   * @param {string} key
   * @param {number} tabId
   */
  addHost(hostKey, key, tabId) {
    const known = this.hosts.get(hostKey);
    // Re-inserted, so the most recently used host is the last to go.
    this.hosts.delete(hostKey);
    this.hosts.set(hostKey, {key, tabId});
    if (known) {
      if (this.copyable(known.key) !== this.copyable(key)) this.updateListener();
      return;
    }
    while (this.hosts.size > MaxHosts) {
      // Uncopyable hosts (kept only for throughBrowserVpn) go first: they must not push out those the mirror serves.
      const uncopyable = Array.from(this.hosts).find(([, entry]) =>
        !this.copyable(entry.key));
      this.hosts.delete(uncopyable ? uncopyable[0] : /** @type {string} */ (this.hosts.keys().next().value));
    }
    this.updateListener();
  }

  /**
   * Its hosts go too: no page going direct could take them off any more.
   * @param {number} tabId
   */
  forgetTab(tabId) {
    this.tabs.delete(tabId);
    this.sources.delete(tabId);
    let changed = false;
    for (const [hostKey, entry] of this.hosts) {
      if (entry.tabId === tabId) {
        this.hosts.delete(hostKey);
        changed = true;
      }
    }
    if (changed) this.updateListener();
  }

  /**
   * @param {string} url
   * @param {boolean} [incognito]
   * @param {number} [tabId]
   * @return {?SeenProxy}
   */
  proxyForUrl(url, incognito, tabId) {
    const host = hostOf(url);
    let key = host ? this.hosts.get(VpnProxyMirror.hostKey(incognito, host))?.key : undefined;
    if (!key) key = this.guessFor(tabId, {host});
    return key ? this.proxies.get(key) || null : null;
  }

  /**
   * @param {string} url
   * @param {boolean} [incognito]
   * @param {number} [tabId]
   * @return {{proxied: boolean, copyable: boolean, permitted: boolean}}
   */
  status(url, incognito, tabId) {
    const host = hostOf(url);
    const tabKey = this.guessFor(tabId, {host});
    if (host && tabKey && !this.hosts.has(VpnProxyMirror.hostKey(incognito, host))) {
      this.addHost(VpnProxyMirror.hostKey(incognito, host), tabKey, /** @type {number} */ (tabId));
    }
    const seen = this.proxyForUrl(url, incognito, tabId);
    return {
      proxied: !!seen,
      copyable: !!seen && CopyableTypes.includes(seen.type),
      permitted: this.permitted,
    };
  }

  /**
   * Firefox VPN's proxy carries a bearer token, which nothing outside Firefox (mpv) can use.
   * @param {string} url
   * @param {boolean} [incognito]
   * @return {boolean}
   */
  throughBrowserVpn(url, incognito) {
    const host = hostOf(url);
    if (!host) return false;
    return (incognito === undefined ? [false, true] : [incognito]).some((incognito) => {
      const entry = this.hosts.get(VpnProxyMirror.hostKey(incognito, host));
      const header = entry ? this.proxies.get(entry.key)?.proxyAuthorizationHeader : '';
      return /^Bearer\s/i.test(header || '');
    });
  }

  /**
   * @param {{url: string, tabId?: number, incognito?: boolean, originUrl?: string,
   *   documentUrl?: string}} details
   * @return {Object|undefined}
   */
  proxyFor(details) {
    if (!this.isOwnRequest(details)) return undefined;
    const host = hostOf(details.url);
    const key = host ? this.hosts.get(VpnProxyMirror.hostKey(details.incognito, host))?.key : undefined;
    const seen = key ? this.proxies.get(key) : undefined;
    if (!seen || !CopyableTypes.includes(seen.type)) return undefined;
    /** @type {SeenProxy} */
    const answer = {type: seen.type, host: seen.host, port: seen.port};
    if (seen.proxyAuthorizationHeader) answer.proxyAuthorizationHeader = seen.proxyAuthorizationHeader;
    if (seen.connectionIsolationKey) answer.connectionIsolationKey = seen.connectionIsolationKey;
    if (seen.failoverTimeout !== undefined) answer.failoverTimeout = seen.failoverTimeout;
    return answer;
  }

  /** @param {boolean} permitted */
  setPermitted(permitted) {
    this.permitted = permitted;
    this.updateListener();
  }

  /** A request to a listed host waits for the background's answer, so only remembered hosts are listened for. */
  updateListener() {
    const api = this.permitted ? this.getProxyApi() : null;
    // A proxy FastStream cannot copy (MASQUE) would only hold its host's requests up.
    const urls = Array.from(new Set(Array.from(this.hosts)
        .filter(([, entry]) => this.copyable(entry.key))
        .map(([hostKey]) => `*://${hostKey.slice(2)}/*`)));
    const same = urls.length === this.listenerUrls.length && urls.every((u, i) => u === this.listenerUrls[i]);
    if (same && api) return;
    for (const listener of this.listeners) {
      try {
        this.getProxyApi()?.onRequest.removeListener(listener);
      } catch (e) {
        // The permission went: so did the listener.
      }
    }
    this.listeners = [];
    this.listenerUrls = [];
    if (!api || !urls.length) return;
    this.listenerUrls = urls;
    try {
      /**
       * @param {{url: string, tabId?: number, incognito?: boolean, originUrl?: string,
       *   documentUrl?: string}} details
       */
      const listener = (details) => this.proxyFor(details);
      api.onRequest.addListener(listener, {urls});
      this.listeners = [listener];
    } catch (e) {
      // A pattern Firefox refuses throws for the whole filter: one listener per host then.
      console.warn('Could not listen for proxy requests to all hosts at once', e);
      for (const url of urls) {
        /**
         * @param {{url: string, tabId?: number, incognito?: boolean, originUrl?: string,
         *   documentUrl?: string}} details
         */
        const listener = (details) => this.proxyFor(details);
        try {
          api.onRequest.addListener(listener, {urls: [url]});
          this.listeners.push(listener);
        } catch (err) {
          console.warn('Could not listen for proxy requests to', url, err);
        }
      }
    }
  }
}
