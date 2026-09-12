// @ts-check

/**
 * Native messaging client for the FastStream mpv host
 * (see native-host/ in the repository root for the host application and
 * its installers).
 *
 * The host is registered under the name com.faststream.mpv. It receives
 * small JSON messages and launches mpv on the user's machine:
 *   {type: 'ping'}                                -> {ok, mpv, path}
 *   {type: 'open', url, headers?, contentType?}  -> {ok, error?}
 *
 * `headers` is the subset of the original request headers mpv needs to
 * fetch CDN streams. Only Referer, Origin and User-Agent are relayed --
 * without the browser's User-Agent mpv identifies itself as "libmpv", which
 * CDNs that gate on a browser UA reject. Cookies and everything else stay in
 * the browser.
 *
 * `contentType` ('anime'|'movie', optional) is the MPV allowlist tag or the
 * player's manual override (see background.mjs's Mpv.openStream call
 * sites) for gpu-toggles.lua's content-aware shader selection on the mpv
 * side. The host appends it to the stream URL as a `#fs-content=` fragment
 * marker, which is never sent to the CDN.
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
   * @param {string} [contentType] - 'anime' or 'movie', from the MPV
   *   allowlist tag or the player's manual override. Anything else is
   *   dropped rather than relayed.
   * @return {Promise<{ok: boolean, error?: string}>} Host response.
   */
  openStream(url, tab, headers, contentType) {
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

    if (contentType === 'anime' || contentType === 'movie') {
      message.contentType = contentType;
    }

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
            // The host answered but mpv never started (bad path, no mpv
            // installed). Forget the URL so the user can retry it after
            // fixing the cause; leaving it recorded would make every later
            // attempt at this URL report success without playing anything.
            if (tab && tab.mpvSentUrls) {
              tab.mpvSentUrls.delete(url);
            }
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
