// @ts-check

/**
 * Parses and evaluates a URL allowlist in the same format as the
 * "Auto-enable URLs" option: one entry per line, pages starting with the
 * entry match, `~` marks a regex, `!` marks a negative (exclude) entry and
 * `-` matches by hostname only. Lines starting with `#` are comments.
 *
 * Matching follows the same precedence as the AutoEnableList in
 * background.mjs: entries are evaluated from last to first, so a negative
 * entry on a later line overrides positive entries above it.
 */
export class UrlMatchList {
  constructor() {
    /** @type {Array<Object>} */
    this.entries = [];
  }

  /**
   * Replaces the list contents with entries parsed from raw strings.
   * Invalid entries (unparseable regexes, empty lines) are skipped.
   * @param {Array<string>} lines - Raw allowlist entries.
   * @return {void}
   */
  setEntries(lines) {
    this.entries = [];
    for (const line of lines || []) {
      const entry = UrlMatchList.parseEntry(line);
      if (entry) {
        this.entries.push(entry);
      }
    }
  }

  /**
   * Parses a single allowlist entry.
   * @param {string} raw - Raw entry string.
   * @return {Object|null} Parsed entry, or null when the entry is empty, a
   *   comment, or an invalid regex.
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
      match: /** @type {RegExp|string|null} */ (null),
    };

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
        // Check if starts with http or https, add it if not
        if (!urlStr.startsWith('http')) {
          urlStr = 'http://' + urlStr;
        }

        entry.match = new URL(urlStr).hostname.toLowerCase();
      } catch (e) {
        return null;
      }
    } else if (entry.regex) {
      try {
        entry.match = new RegExp(urlStr, 'i');
      } catch (e) {
        return null;
      }
    } else {
      urlStr = urlStr.toLowerCase();
      if (urlStr.length === 0) {
        return null;
      }
      entry.match = urlStr;
    }

    return entry;
  }

  /**
   * Tests a URL against the list.
   * @param {string} url - The URL to test.
   * @return {boolean} True when the URL is allowed (a positive entry
   *   matched, or a negative entry did not override it).
   */
  matches(url) {
    if (!url) {
      return false;
    }

    const normalized = url.toLowerCase();

    // Later entries take precedence, mirroring the reversed AutoEnableList.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (UrlMatchList.entryMatches(entry, normalized)) {
        return !entry.negative;
      }
    }

    return false;
  }

  /**
   * Tests a single parsed entry against a normalized URL.
   * @param {Object} entry - Parsed entry.
   * @param {string} normalizedUrl - Lowercased URL.
   * @return {boolean} True when the entry matches the URL.
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
      return normalizedUrl.startsWith(/** @type {string} */ (entry.match));
    }
  }
}
