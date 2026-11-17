// @ts-check

/** @typedef {{negative: boolean, regex: boolean, exclude_domain: boolean, contentType: string|null, match: RegExp|string|null}} Entry */
/** An allowlist in the "Auto-enable URLs" format, evaluated last to first: a later `!` entry overrides those above. */
export class UrlMatchList {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.domainEntriesExclude]
   */
  constructor({domainEntriesExclude = false} = {}) {
    /** @type {Array<Entry>} */
    this.entries = [];
    this.domainEntriesExclude = domainEntriesExclude;
  }

  /**
   * @param {Array<string>} lines
   * @return {void}
   */
  setEntries(lines) {
    this.entries = [];
    for (const line of lines || []) {
      const entry = UrlMatchList.parseEntry(line);
      if (entry) {
        if (entry.exclude_domain && this.domainEntriesExclude) {
          entry.negative = true;
        }
        this.entries.push(entry);
      }
    }
  }

  /** @return {Array<string>} */
  excludedDomains() {
    return this.entries.filter((entry) => entry.exclude_domain).map((entry) => /** @type {string} */ (entry.match));
  }

  /**
   * @param {string} raw
   * @return {Entry|null}
   */
  static parseEntry(raw) {
    let urlStr = String(raw || '').trim();
    if (urlStr.length === 0 || urlStr[0] === '#') {
      return null;
    }

    const entry = {
      negative: false,
      regex: false,
      exclude_domain: false,
      contentType: /** @type {string|null} */ (null),
      match: /** @type {RegExp|string|null} */ (null),
    };

    const tagMatch = /(?:^|\s+)@(anime|movie)\s*$/i.exec(urlStr);
    if (tagMatch) {
      entry.contentType = tagMatch[1].toLowerCase();
      urlStr = urlStr.slice(0, tagMatch.index).trim();
    }

    while (urlStr.length > 0) {
      if (urlStr[0] === '!') {
        entry.negative = true;
        urlStr = urlStr.substring(1);
      } else if (urlStr[0] === '~') {
        entry.regex = true;
        urlStr = urlStr.substring(1);
      } else if (urlStr[0] === '-') {
        entry.exclude_domain = true;
        urlStr = urlStr.substring(1);
      } else {
        break;
      }
    }

    if (entry.exclude_domain) {
      try {
        // Any letter case: `-HTTPS://example.com` is no bare hostname.
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlStr)) {
          urlStr = 'http://' + urlStr;
        }

        entry.match = new URL(urlStr).hostname.toLowerCase();
      } catch (e) {
        return null;
      }
    } else if (entry.regex) {
      // An empty regex (a stray `~`) would match every URL.
      if (urlStr.length === 0) {
        return null;
      }
      try {
        entry.match = new RegExp(urlStr, 'i');
      } catch (e) {
        return null;
      }
    } else {
      urlStr = UrlMatchList.punycodeHost(urlStr.toLowerCase());
      if (urlStr.length === 0) {
        return null;
      }
      entry.match = urlStr;
    }

    return entry;
  }

  /**
   * Firefox gives a page's address with its host in punycode.
   * @param {string} entry
   * @return {string}
   */
  static punycodeHost(entry) {
    const parts = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#:@]*)([\s\S]*)$/.exec(entry);
    if (!parts || !/[\u0080-￿]/.test(parts[2])) {
      return entry;
    }
    try {
      return (parts[1] || '') + new URL('http://' + parts[2]).hostname + parts[3];
    } catch (e) {
      return entry;
    }
  }

  /**
   * @param {string} url
   * @return {boolean}
   */
  matches(url) {
    const entry = this.findMatchingEntry(url);
    return entry ? !entry.negative : false;
  }

  /**
   * @param {string} [url]
   * @return {string|null}
   */
  getContentType(url) {
    const entry = this.findMatchingEntry(url);
    if (!entry || entry.negative) {
      return null;
    }
    return entry.contentType || null;
  }

  /**
   * Later entries take precedence.
   * @param {string} [url]
   * @return {Entry|null}
   */
  findMatchingEntry(url) {
    if (!url) {
      return null;
    }

    const normalized = url.toLowerCase();

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (UrlMatchList.entryMatches(entry, normalized)) {
        return entry;
      }
    }

    return null;
  }

  /**
   * @param {Entry} entry
   * @param {string} normalizedUrl
   * @return {boolean}
   */
  static entryMatches(entry, normalizedUrl) {
    if (entry.exclude_domain) {
      try {
        const hostname = new URL(normalizedUrl).hostname;
        return hostname === entry.match;
      } catch (e) {
        return false;
      }
    } else if (entry.regex) {
      return /** @type {RegExp} */ (entry.match).test(normalizedUrl);
    } else {
      return UrlMatchList.prefixMatches(/** @type {string} */ (entry.match), normalizedUrl);
    }
  }

  /**
   * As users write sites: no scheme matches http and https, `www.` counts on neither side, a site alone matches only itself.
   * @param {string} match
   * @param {string} normalizedUrl
   * @return {boolean}
   */
  static prefixMatches(match, normalizedUrl) {
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//;
    const entryScheme = scheme.exec(match)?.[0];
    const urlScheme = scheme.exec(normalizedUrl)?.[0];
    if (entryScheme ? entryScheme !== urlScheme : !/^https?:\/\/$/.test(urlScheme || '')) {
      return false;
    }
    /** @type {(text: string) => string} */
    const withoutWww = (text) => text.replace(/^www\./, '');
    const written = match.slice(entryScheme ? entryScheme.length : 0);
    const site = withoutWww(written);
    // `www.` alone is no page; a scheme alone is every page of it, on purpose.
    if (site === '') {
      return written === '';
    }
    // Less a user name and password: `example.com` must not match https://example.com:x@evil.com/.
    let address;
    try {
      address = new URL(normalizedUrl);
    } catch (e) {
      return false;
    }
    address.username = '';
    address.password = '';
    const page = withoutWww(address.href.slice(/** @type {string} */ (urlScheme).length));
    if (!page.startsWith(site)) {
      return false;
    }
    // Only a host (and port): the page's host ends there too.
    return site.includes('/') || /^$|^[/?#:]/.test(page.slice(site.length));
  }
}
