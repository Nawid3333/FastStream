// @ts-check

/**
 * Native messaging client for the FastStream mpv host
 * (see native-host/ in the repository root for the host application and
 * its installers).
 *
 * The host is registered under the name com.faststream.mpv. It receives
 * small JSON messages and launches mpv on the user's machine:
 *   {type: 'ping', mpvPath?}                      -> {ok, mpv, path}
 *   {type: 'open', url, headers?, contentType?, pageUrl?, title?, start?, subtitles?,
 *    mpvPath?, fullscreen?, singleInstance?}      -> {ok, error?}
 * Every answer carries the host's `hostVersion` (see RequiredHostVersion below).
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
 *
 * `pageUrl` is the tab's page URL (the episode page). The host hashes it into
 * an `fs-id=` marker in the same fragment, which mpv's stream-resume.lua
 * uses to save and restore the playback position -- the stream URL itself
 * usually carries an expiring token and cannot serve as that key.
 */

const NativeHostName = 'com.faststream.mpv';

// The host this extension was released with: HostVersion in
// native-host/faststream-mpv-host.mjs at that commit (tests/unit/mpvHostVersion.test.mjs
// keeps the two equal). The host is not part of the extension: a PC runs the copy
// install.ps1 made, and neither an extension update nor a `git pull` changes that copy.
// An answer with a lower version, or none (a host from before 2026-10-04), is an
// outdated host: the stream still goes to it, and the toolbar button, the player's mpv
// button and "Test mpv connection" say to install the host again.
export const RequiredHostVersion = 1;

// The largest message the host reads (MaxMessageBytes in native-host/faststream-mpv-host.mjs),
// as Firefox sends it: the JSON in UTF-8. A bigger one was never read: the host quit
// without a word, and the hand-off failed with "is the host installed?".
export const HostMaxMessageBytes = 1024 * 1024;

// Where a YouTube watch page is (youTubeVideoUrl).
const YouTubeHosts = ['www.youtube.com', 'youtube.com', 'm.youtube.com'];

/**
 * The size of a message as it reaches the host.
 * @param {Object} message - The message.
 * @return {number} Bytes.
 */
function messageBytes(message) {
  return new TextEncoder().encode(JSON.stringify(message)).length;
}

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
    // Whether the last answer came from an outdated host. One host serves the whole
    // browser, so it is kept here and goes with every result, the one for a stream
    // already sent (which asks the host nothing) included.
    /** @type {boolean} */
    this.hostOutdated = false;
  }

  /**
   * Whether an answer came from a host older than this extension was released with.
   * @param {*} response - The host's answer.
   * @return {boolean} True for a lower version, or an answer without one.
   */
  static isHostOutdated(response) {
    const version = response && typeof response === 'object' ? response.hostVersion : undefined;
    return !(Number.isInteger(version) && version >= RequiredHostVersion);
  }

  /**
   * A result with what is known about the host's version.
   * @param {{ok: boolean, error?: string, mpv?: boolean, path?: string}} result - The result.
   * @return {{ok: boolean, error?: string, mpv?: boolean, path?: string, hostOutdated?: boolean}}
   *   The result, with hostOutdated when the host is outdated.
   */
  withHostState(result) {
    return this.hostOutdated ? {...result, hostOutdated: true} : result;
  }

  /**
   * Whether a URL may be handed to mpv: http or https, and nothing else. mpv opens
   * local files and UNC paths too, and a UNC path makes Windows sign in to that host
   * with the user's credentials. FastStream only ever finds http(s) streams, so the
   * rest can only come from a page that made one up (the player page is web-accessible).
   * The string itself has to start with the scheme: the URL parser alone would read
   * `https:\\host\share` as https://host/share.
   * @param {*} url - The candidate.
   * @return {boolean}
   */
  static isStreamUrl(url) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return false;
    }
    try {
      const {protocol} = new URL(url);
      return protocol === 'http:' || protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  /**
   * The video a YouTube watch page plays, as the address mpv opens it by: its yt-dlp
   * finds the streams, which FastStream cannot. The video's own address, without the
   * page's list=, t= and the like: it is also the key mpv resumes the video by, which
   * would differ with each of them.
   * @param {*} page - The page's address.
   * @return {?string} https://www.youtube.com/watch?v=<id>, or null for any other page.
   */
  static youTubeVideoUrl(page) {
    let url;
    try {
      url = new URL(page);
    } catch (e) {
      return null;
    }
    if (url.protocol !== 'https:' || !YouTubeHosts.includes(url.hostname) || url.pathname !== '/watch') {
      return null;
    }
    const id = url.searchParams.get('v');
    return id && /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
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
      // Printable ASCII only, as the host requires too: a value can come from a page
      // (a player's source headers), and mpv needs nothing else. No CR/LF, no quote
      // characters beyond ASCII.
      if (typeof header.value !== 'string' || !/^[ -~]{1,4096}$/.test(header.value)) {
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
   * @param {string} [pageUrl] - The tab's page URL, the key mpv resumes the
   *   playback position by. Only http(s) URLs are relayed.
   * @param {string} [pageTitle] - The tab's title, which mpv shows for the stream
   *   (window, taskbar, top bar); without one the host shows the stream's host name.
   * @param {{startTime?: number, subtitles?: Array<{label: string, srt: string}>}} [extras]
   *   - Where the browser's player was, and the subtitles it shows (the player's button).
   * @return {Promise<{ok: boolean, error?: string, noHost?: boolean, hostOutdated?: boolean}>}
   *   Host response; noHost when the host itself could not be reached, hostOutdated when
   *   it answered as a version older than RequiredHostVersion.
   */
  openStream(url, tab, headers, contentType, pageUrl, pageTitle, extras = {}) {
    if (!MpvBackend.isStreamUrl(url)) {
      return Promise.resolve({ok: false, error: 'mpv is only given http(s) streams'});
    }

    if (tab && tab.mpvSentUrls) {
      if (tab.mpvSentUrls.has(url)) {
        return Promise.resolve(this.withHostState({ok: true}));
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

    if (typeof pageUrl === 'string' && /^https?:\/\//i.test(pageUrl)) {
      message.pageUrl = pageUrl;
    }

    if (typeof pageTitle === 'string' && pageTitle.trim()) {
      message.title = pageTitle.trim().slice(0, 300);
    }

    if (typeof extras.startTime === 'number' && Number.isFinite(extras.startTime) && extras.startTime >= 1) {
      message.start = extras.startTime;
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

    // Last, so the rest of the message counts: the subtitles that fit under the host's
    // limit, in order. One that does not fit is left out and the stream still goes.
    if (Array.isArray(extras.subtitles)) {
      const candidates = extras.subtitles
          .filter((s) => s && typeof s.srt === 'string' && s.srt.trim())
          .slice(0, 8)
          .map((s) => ({label: typeof s.label === 'string' ? s.label.slice(0, 100) : '', srt: s.srt}));
      const subtitles = [];
      message.subtitles = subtitles;
      for (const subtitle of candidates) {
        subtitles.push(subtitle);
        if (messageBytes(message) > HostMaxMessageBytes) {
          subtitles.pop();
          console.warn(`A subtitle track (${subtitle.label || 'no label'}) is too large to send to mpv, left out`);
        }
      }
      if (subtitles.length === 0) {
        delete message.subtitles;
      }
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
            // noHost: Firefox could not run the host at all (not installed, or it
            // died), as opposed to a reason the host itself gave.
            resolve({ok: false, error: lastError.message, noHost: true});
            return;
          }

          this.hostOutdated = MpvBackend.isHostOutdated(response);

          if (response && response.ok === false) {
            // The host answered but mpv never started (bad path, no mpv
            // installed). Forget the URL so the user can retry it after
            // fixing the cause; leaving it recorded would make every later
            // attempt at this URL report success without playing anything.
            if (tab && tab.mpvSentUrls) {
              tab.mpvSentUrls.delete(url);
            }
            resolve(this.withHostState({ok: false, error: response.error || 'mpv host error'}));
            return;
          }

          resolve(this.withHostState({ok: true}));
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
   * @return {Promise<{ok: boolean, mpv?: boolean, path?: string, error?: string, hostOutdated?: boolean}>}
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
          this.hostOutdated = MpvBackend.isHostOutdated(response);
          resolve(this.withHostState({
            ok: true,
            mpv: !!(response && response.mpv),
            path: response ? response.path : undefined,
          }));
        });
      } catch (e) {
        resolve({ok: false, error: String(e)});
      }
    });
  }
}
