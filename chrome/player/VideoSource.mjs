// @ts-check
import {PlayerModes} from './enums/PlayerModes.mjs';
import {URLUtils} from './utils/URLUtils.mjs';

const headerBlacklist = [
  'accept',
  'accept-charset',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'pragma',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'user-agent',
  'range',
  'host',
  'connection',
  'dnt',
  'sec-fetch-storage-access',
  'sec-fetch-user',
  'upgrade-insecure-requests',
  'access-control-request-method',
  'access-control-request-headers',
];

// Login headers a copied or crafted link must not carry.
const credentialHeaders = ['cookie', 'authorization', 'proxy-authorization'];

/**
 * The headers without the login ones, whatever their case.
 * @param {Object<string, string>} headers
 * @return {Object<string, string>}
 */
export function withoutCredentials(headers) {
  /** @type {Object<string, string>} */
  const kept = {};
  for (const key in headers) {
    if (Object.hasOwn(headers, key) && !credentialHeaders.includes(key.toLowerCase())) {
      kept[key] = headers[key];
    }
  }
  return kept;
}


// Public second levels under a country code (co.uk); Firefox's public suffix list is not open to extensions.
const PublicSecondLevel = /^(ac|co|com|edu|gov|go|ne|net|or|org)$/;

/**
 * The site a host belongs to, without the public suffix list: its last two labels (three under a public
 * second level); an IP address or a one-label host as it is.
 * @param {string} host
 * @return {string}
 */
export function siteOfHost(host) {
  // A trailing dot (the root) names the same host.
  host = host.replace(/\.$/, '');
  const labels = host.toLowerCase().split('.');
  if (labels.length <= 2 || /^\d+$/.test(labels[labels.length - 1]) || host.includes(':')) return host.toLowerCase();
  const second = labels[labels.length - 2];
  const count = labels[labels.length - 1].length === 2 && PublicSecondLevel.test(second) ? 3 : 2;
  return labels.slice(-count).join('.');
}

/**
 * Whether two addresses are http(s) of the same site (siteOfHost).
 * @param {string} a
 * @param {string} b
 * @return {boolean}
 */
function sameSite(a, b) {
  try {
    const first = new URL(a);
    const second = new URL(b);
    if (!/^https?:$/.test(first.protocol) || !/^https?:$/.test(second.protocol)) return false;
    // Not from https to plain http: Firefox sends a Secure cookie over https only.
    if (first.protocol === 'https:' && second.protocol === 'http:') return false;
    return siteOfHost(first.hostname) === siteOfHost(second.hostname);
  } catch (e) {
    return false;
  }
}

/**
 * VideoSource.headersFor, for any source with a url and headers.
 * @param {{url: string, headers?: Object<string, string>}} source
 * @param {string} url
 * @return {Object<string, string>}
 */
export function sourceHeadersFor(source, url) {
  const headers = source.headers || {};
  return sameSite(source.url, url) ? headers : withoutCredentials(headers);
}

export class VideoSource {
  /**
   * @param {string|File} source
   * @param {Object<string, string>|Array<{name: string, value?: string}>|null|undefined} headers
   * @param {string} [mode]
   */
  constructor(source, headers, mode) {
    if (source instanceof File) {
      this.fromFile(source);
    } else {
      /** @type {string} */
      this.url = source;
      /** @type {string} */
      this.identifier = URLUtils.mediaIdentifier(this.url);
    }
    this.mode = mode || PlayerModes.DIRECT;

    if (Array.isArray(headers)) {
      /** @type {Object<string, string>} */
      this.headers = {};
      headers.forEach((header) => {
        if (header.name && header.value) {
          this.headers[header.name] = header.value;
        }
      });
    } else {
      this.headers = headers || {};
    }

    this.headers = this.filterHeaders(this.headers);
    // The quality and audio track to start with (a reload keeps what the user had), or null.
    /** @type {?{level?: string|number, audioLevel?: string|number}} */
    this.defaultLevelInfo = null;
    this.loadedFromArchive = false;
    // The page player's own qualities as separate files ([{url, label, height}], page-qualities.js), or null.
    this.qualities = null;
    // The asking page's frame, or null: what loads it when FastStream itself is refused (PageFetch.mjs).
    /** @type {?number} */
    this.pageFrameId = null;
  }

  /**
   * The headers a request of this source's sends: all of them to the source's own site, without the login
   * ones to another site, as the browser does with cookies. Referer and Origin go everywhere: CDNs check them.
   * @param {string} url
   * @return {Object<string, string>}
   */
  headersFor(url) {
    return sourceHeadersFor(this, url);
  }

  /**
   * Gives the source the qualities its page's player offers. They are one video: the remembered time goes by
   * the list's first file.
   * @param {?Array<{url: string, label: string, height: number}>|undefined} qualities
   */
  setQualities(qualities) {
    if (!Array.isArray(qualities) || qualities.length < 2) {
      this.qualities = null;
      return;
    }
    this.qualities = qualities.map((entry) => ({url: entry.url, label: entry.label || '', height: entry.height || 0}));
    this.identifier = URLUtils.mediaIdentifier(this.qualities[0].url);
  }

  /**
   * Takes the headers and the mode a link carries in its query (toCopyURL) off its URL.
   * @param {boolean} [apply=true] - Whether to use them too: only for a trusted source.
   */
  parseHeadersParam(apply = true) {
    try {
      const url = new URL(this.url);
      const headers = url.searchParams.get('faststream-headers');
      if (headers) {
        if (apply) {
          const parsed = JSON.parse(headers);
          // Names and values, as toCopyURL writes them: a list or a number is no header.
          const parsedHeaders = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? withoutCredentials(parsed) : {};
          for (const key in parsedHeaders) {
            if (Object.hasOwn(parsedHeaders, key) && typeof parsedHeaders[key] === 'string') {
              this.headers[key] = parsedHeaders[key];
            }
          }
          this.headers = this.filterHeaders(this.headers);
        }
        url.searchParams.delete('faststream-headers');
        this.url = url.toString();
      }

      const mode = url.searchParams.get('faststream-mode');
      if (mode) {
        if (apply && Object.values(PlayerModes).includes(mode)) {
          this.mode = mode;
        }
        url.searchParams.delete('faststream-mode');
        this.url = url.toString();
      }
    } catch (e) {
    }
  }

  /**
   * The source as a link to copy: its URL with its non-login headers and its mode in the query (parseHeadersParam).
   * @return {URL} Throws when the source's URL does not parse.
   */
  toCopyURL() {
    const url = new URL(this.url);
    const headers = withoutCredentials(this.headers);
    if (Object.keys(headers).length > 0) {
      url.searchParams.set('faststream-headers', JSON.stringify(headers));
    }
    url.searchParams.set('faststream-mode', this.mode);
    return url;
  }

  /** @param {File} file */
  fromFile(file) {
    this.url = URL.createObjectURL(file);
    this.identifier = file.name;

    this.shouldRevoke = true;
  }

  destroy() {
    if (this.shouldRevoke) {
      URL.revokeObjectURL(this.url);
      /** @type {{url: ?string}} */ (this).url = null;
    }
  }

  /**
   * The headers without those the browser sets itself, names in lower case.
   * @param {Object<string, string>} headers
   * @return {Object<string, string>}
   */
  filterHeaders(headers) {
    /** @type {Object<string, string>} */
    const filteredHeaders = {};
    for (const key in headers) {
      if (headerBlacklist.includes(key.toLowerCase())) {
        continue;
      }
      filteredHeaders[key.toLowerCase()] = headers[key];
    }
    return filteredHeaders;
  }

  /** @param {VideoSource} other */
  equals(other) {
    if (this.url !== other.url) {
      return false;
    }

    if (this.mode !== other.mode) {
      return false;
    }

    if (Object.keys(this.headers).length !== Object.keys(other.headers).length) {
      return false;
    }

    for (const key in this.headers) {
      if (this.headers[key] !== other.headers[key]) {
        return false;
      }
    }

    return true;
  }

  copy() {
    const newsource = new VideoSource(this.url, {}, this.mode);
    newsource.identifier = this.identifier;
    newsource.defaultLevelInfo = this.defaultLevelInfo;
    newsource.loadedFromArchive = this.loadedFromArchive;
    newsource.headers = {...this.headers};
    newsource.qualities = this.qualities ? this.qualities.map((entry) => ({...entry})) : null;
    newsource.pageFrameId = this.pageFrameId;
    return newsource;
  }
}
