// @ts-check

/**
 * Native messaging client for the FastStream mpv host
 * (see native-host/ in the repository root for the host application and
 * its installers).
 *
 * The host is registered under the name com.faststream.mpv. It receives
 * small JSON messages and launches mpv on the user's machine:
 *   {type: 'ping'}                 -> {ok, mpv, path}
 *   {type: 'open', url, headers?}  -> {ok, error?}
 *
 * `headers` is the subset of the original request headers mpv needs to
 * fetch CDN streams. Only Referer, Origin and User-Agent are relayed --
 * without the browser's User-Agent mpv identifies itself as "libmpv", which
 * CDNs that gate on a browser UA reject. Cookies and everything else stay in
 * the browser.
 */

const NativeHostName = 'com.faststream.mpv';

export class MpvBackend {
  constructor() {
    /** @type {boolean} */
    this.warnedAboutHost = false;
    /** @type {string} */
    this.mpvPath = '';
    /** @type {boolean} */
    this.fullscreen = false;
    /** @type {boolean} */
    this.singleInstance = true;
  }

  /**
   * Picks the headers worth relaying to mpv from a webRequest header list.
   * Duplicates are dropped, keeping the first value seen for each name.
   * @param {Array<{name: string, value: string}>|undefined} headerList
   * @return {Array<{name: string, value: string}>|undefined} The filtered
   *   header list, or undefined when there is nothing to relay.
   */
  static pickRelayHeaders(headerList) {
    if (!Array.isArray(headerList)) {
      return undefined;
    }

    const seen = new Set();
    const picked = headerList.filter((header) => {
      if (!header || !header.name || !header.value) {
        return false;
      }
      if (!/^(referer|origin|user-agent)$/i.test(header.name)) {
        return false;
      }
      const key = header.name.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    return picked.length > 0 ? picked : undefined;
  }

  /**
   * Opens a stream URL in mpv via the native messaging host.
   * @param {string} url - The stream URL to play.
   * @param {Object} [tab] - TabHolder the source was detected in, used to
   *   deduplicate repeated detections of the same URL.
   * @param {Array<{name: string, value: string}>} [headers] - Optional
   *   Referer/Origin headers to relay.
   * @return {Promise<{ok: boolean, error?: string}>} Host response.
   */
  openStream(url, tab, headers) {
    if (tab && tab.mpvSentUrls) {
      if (tab.mpvSentUrls.has(url)) {
        return Promise.resolve({ok: true});
      }
      tab.mpvSentUrls.add(url);
    }

    /** @type {Object} */
    const message = {
      type: 'open',
      url: url,
    };

    // Relay the user's mpv path preference (options page) so the host does
    // not have to guess where mpv is installed.
    if (this.mpvPath) {
      message.mpvPath = this.mpvPath;
    }

    if (this.fullscreen) {
      message.fullscreen = true;
    }

    if (this.singleInstance) {
      message.singleInstance = true;
    }

    const relayHeaders = MpvBackend.pickRelayHeaders(headers);
    if (relayHeaders) {
      message.headers = relayHeaders;
    }

    return new Promise((resolve) => {
      try {
        chrome.runtime.sendNativeMessage(NativeHostName, message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            // Allow a retry after the user (hopefully) installs the host.
            if (tab && tab.mpvSentUrls) {
              tab.mpvSentUrls.delete(url);
            }
            if (!this.warnedAboutHost) {
              this.warnedAboutHost = true;
              console.warn('MPV native host not available:', lastError.message);
            }
            resolve({ok: false, error: lastError.message});
            return;
          }

          if (response && response.ok === false) {
            resolve({ok: false, error: response.error || 'mpv host error'});
            return;
          }

          resolve({ok: true});
        });
      } catch (e) {
        if (tab && tab.mpvSentUrls) {
          tab.mpvSentUrls.delete(url);
        }
        resolve({ok: false, error: String(e)});
      }
    });
  }

  /**
   * Pings the native host and asks it to locate mpv.
   * @return {Promise<{ok: boolean, mpv?: boolean, path?: string, error?: string}>}
   */
  testConnection() {
    return new Promise((resolve) => {
      try {
        /** @type {Object} */
        const pingMessage = {
          type: 'ping',
        };
        if (this.mpvPath) {
          pingMessage.mpvPath = this.mpvPath;
        }
        chrome.runtime.sendNativeMessage(NativeHostName, pingMessage, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ok: false, error: lastError.message});
            return;
          }
          resolve({
            ok: true,
            mpv: !!(response && response.mpv),
            path: response ? response.path : undefined,
          });
        });
      } catch (e) {
        resolve({ok: false, error: String(e)});
      }
    });
  }
}
