// @ts-check
import {PlayerModes} from './enums/PlayerModes.mjs';

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
      this.identifier = this.url.split(/[?#]/)[0];
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
    this.identifier = this.qualities[0].url.split(/[?#]/)[0];
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
    return newsource;
  }
}
