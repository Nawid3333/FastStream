/**
 * The Firefox-only parts of the chrome.* API that FastStream reads, merged into
 * @types/chrome.
 *
 * FastStream runs only in Firefox. @types/chrome describes Chrome's API, which is what the
 * code calls (`chrome.*`, with callbacks or promises; Firefox supports both), but it lacks
 * the fields only Firefox has. Firefox's own @types/firefox-webext-browser describes the
 * promise-only `browser.*` instead, which would reject every callback call. So: Chrome's
 * types, and these additions. Ambient, like messages.d.ts: no import or export.
 */

declare namespace chrome.tabs {
  interface Tab {
    /** The tab's cookie store: 'firefox-default', 'firefox-private' or a container's. */
    cookieStoreId?: string;
  }

  interface CreateProperties {
    /** The cookie store to open the tab in (a container). */
    cookieStoreId?: string;
  }
}
