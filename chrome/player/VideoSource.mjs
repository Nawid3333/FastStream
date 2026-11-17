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

// Login headers a link must not carry (#185). A copied stream link (the time readout,
// the Sources browser) put the session's Cookie or Authorization in the clipboard, for
// whoever the link was pasted to; and a crafted link (a page can open the player on one)
// could have the player send credentials of its choosing. The player still sends the ones
// it captured from the page, and ones typed into the Sources browser's header box.
const credentialHeaders = ['cookie', 'authorization', 'proxy-authorization'];

/**
 * The headers without the login ones, whatever their case.
 * @param {Object<string, string>} headers - Header name to value.
 * @return {Object<string, string>} A new object.
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


// Second-level labels under a two-letter country code that are public (co.uk, com.au, ne.jp):
// a site there is one label longer. Firefox's public suffix list is not open to extensions.
const PublicSecondLevel = /^(ac|co|com|edu|gov|go|ne|net|or|org)$/;

/**
 * The site a host belongs to, as near as can be told without the public suffix list: its last
 * two labels (three under a public second level), an IP address or a one-label host as it is.
 * @param {string} host - A URL's hostname.
 * @return {string}
 */
export function siteOfHost(host) {
  // A host's trailing dot (the root) names the same host: kept, every "x.com." was the
  // site "com.".
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
    return siteOfHost(first.hostname) === siteOfHost(second.hostname);
  } catch (e) {
    return false;
  }
}

/**
 * VideoSource.headersFor, for any source with a url and headers.
 * @param {{url: string, headers?: Object<string, string>}} source
 * @param {string} url - The request's address.
 * @return {Object<string, string>}
 */
export function sourceHeadersFor(source, url) {
  const headers = source.headers || {};
  return sameSite(source.url, url) ? headers : withoutCredentials(headers);
}

export class VideoSource {
  /**
   * @param {string|File} source - The stream's URL, or a file the user opened.
   * @param {Object<string, string>|Array<{name: string, value?: string}>|null|undefined} headers - The
   *   request's headers: by name, or as the browser listed them (name and value).
   * @param {string} [mode] - A PlayerModes value; DIRECT when none is given.
   */
  constructor(source, headers, mode) {
    if (source instanceof File) {
      this.fromFile(source);
    } else {
      /** @type {string} */
      this.url = source;
      // Set either way: here or by fromFile.
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
    // The qualities the page's own player offers this file in, as files of their own
    // ([{url, label, height}], page-qualities.js), or null (setQualities).
    this.qualities = null;
    // The frame of the page that asked for it (the background's frameId), or null: where it can
    // be loaded through when FastStream itself is refused (PageFetch.mjs).
    /** @type {?number} */
    this.pageFrameId = null;
  }

  /**
   * The headers a request of this source's sends (a playlist's, a segment's, a key's): all of
   * them to an address of the source's own site, and without the login ones (withoutCredentials)
   * to another site. The source's are what the page's request sent to the source's host, its
   * Cookie included, and a header rule sets them on each request: a playlist that named another
   * host for a segment or a key had the source site's session cookie sent there, which the
   * browser itself never does. Referer and Origin go everywhere: a
   * CDN checks them, and the browser sends them across sites too.
   * @param {string} url - The request's address.
   * @return {Object<string, string>}
   */
  headersFor(url) {
    return sourceHeadersFor(this, url);
  }

  /**
   * Gives the source the qualities its page's player offers it in. They are one video: the
   * remembered time goes by the list's first file, whichever is played (it went by the URL
   * played, and a hoster's redirect target, the same for every film on its CDN node, shared
   * one remembered time between them).
   * @param {?Array<{url: string, label: string, height: number}>|undefined} qualities - None
   *     when the page offered none.
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
   * @param {boolean} [apply=true] - Whether to use them as well: only for a trusted source.
   *   An untrusted one plays its URL without them.
   */
  parseHeadersParam(apply = true) {
    try {
      const url = new URL(this.url);
      const headers = url.searchParams.get('faststream-headers');
      if (headers) {
        if (apply) {
          const parsedHeaders = withoutCredentials(JSON.parse(headers));
          for (const key in parsedHeaders) {
            if (Object.hasOwn(parsedHeaders, key)) {
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
   * The source as a link to copy: its URL with its headers, minus the login ones, and its
   * mode in the query, which parseHeadersParam reads back when the link is pasted into
   * the Sources browser or opened.
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
      // Gone: a destroyed source is not used again (the client destroys the one it replaced).
      /** @type {{url: ?string}} */ (this).url = null;
    }
  }

  /**
   * The headers without those the browser sets itself, names in lower case.
   * @param {Object<string, string>} headers - Header name to value.
   * @return {Object<string, string>} A new object.
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
