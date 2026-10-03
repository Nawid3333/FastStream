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
function withoutCredentials(headers) {
  const kept = {};
  for (const key in headers) {
    if (Object.hasOwn(headers, key) && !credentialHeaders.includes(key.toLowerCase())) {
      kept[key] = headers[key];
    }
  }
  return kept;
}


export class VideoSource {
  constructor(source, headers, mode) {
    if (source instanceof File) {
      this.fromFile(source);
    } else {
      this.url = source;
      this.identifier = this.url.split(/[?#]/)[0];
    }
    this.mode = mode || PlayerModes.DIRECT;

    if (Array.isArray(headers)) {
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
    this.defaultLevelInfo = null;
    this.loadedFromArchive = false;
  }

  /**
   * Should only be called when the source is trusted.
   */
  parseHeadersParam() {
    try {
      const url = new URL(this.url);
      const headers = url.searchParams.get('faststream-headers');
      if (headers) {
        const parsedHeaders = withoutCredentials(JSON.parse(headers));
        for (const key in parsedHeaders) {
          if (Object.hasOwn(parsedHeaders, key)) {
            this.headers[key] = parsedHeaders[key];
          }
        }
        this.headers = this.filterHeaders(this.headers);
        url.searchParams.delete('faststream-headers');
        this.url = url.toString();
      }

      const mode = url.searchParams.get('faststream-mode');
      if (mode) {
        if (Object.values(PlayerModes).includes(mode)) {
          this.mode = mode;
        }
        url.searchParams.delete('faststream-mode');
        this.url = url.toString();
      }
    } catch (e) {
    }
  }

  countHeaders() {
    return Object.keys(this.headers).length;
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

  fromFile(file) {
    this.url = URL.createObjectURL(file);
    this.identifier = file.name;

    this.shouldRevoke = true;
  }

  destroy() {
    if (this.shouldRevoke) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }

  filterHeaders(headers) {
    const filteredHeaders = {};
    for (const key in headers) {
      if (headerBlacklist.includes(key.toLowerCase())) {
        continue;
      }
      filteredHeaders[key.toLowerCase()] = headers[key];
    }
    return filteredHeaders;
  }

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
    return newsource;
  }
}
