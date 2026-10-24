// @ts-check

import {relayWatch} from './MpvRelayWatch.mjs';
import {cutText, cutToLength, isStreamUrl, mpvTargetUrl, relayHeaderFields, startOf, streamTitle} from './MpvTarget.mjs';

/**
 * Native messaging client for the FastStream mpv host
 * (see native-host/ in the repository root for the host application and
 * its installers).
 *
 * The host is registered under the name com.faststream.mpv. It receives
 * small JSON messages and launches mpv on the user's machine:
 *   {type: 'ping', mpvPath?}                      -> {ok, mpv, path}
 *   {type: 'open', url, headers?, contentType?, pageUrl?, title?, start?, subtitles?,
 *    mpvPath?, fullscreen?, singleInstance?}      -> {ok, error?, reused?, focus?, foreground?}
 *   {type: 'status', waitMs?}                     -> {ok, running, decoder}
 *   {type: 'watch'} over a port (connectNative)    -> watching, path, ended, request, closed
 * Every answer carries the host's `hostVersion` (see RequiredHostVersion below).
 *
 * The thin helper (host 15, 2026-10-13). The helper is installed by hand and never updates
 * itself, and it changed 14 times in 10 days, each one a reinstall for the owner, because
 * policy lived in it: the fs-* tags of the URL, the title, the end of a file for MPV
 * autoplay. He chose to move the policy here, where it updates with the extension, and to
 * keep in the helper only the mechanics, offered as allowlisted primitives:
 *   {type: 'play', target, title?, start?, headers?, subtitles?, mpvPath?, fullscreen?, newWindow?}
 *     -> as open's answer; target, title and the rest built here (MpvTarget.mjs)
 *   {type: 'ipc', commands}                       -> {ok, replies} (decoderStatus)
 *   {type: 'relay', heartbeat?, onStop?} over a port -> mpv's lines (MpvRelayWatch.mjs)
 * Each of its answers names them (`capabilities: ['play', 'ipc', 'relay']`), and this
 * client remembers what the helper can do from every answer. An older helper answers
 * "unknown message" to them, and gets the messages above from then on: no helper is too old
 * to use, and no feature waits for a reinstall any more.
 *
 * An open that worked on Windows (host version 3 and later) says how raising mpv's window
 * went: `focus` ("True", "False", "nowindow", ...) and `foreground` ("True" when mpv's
 * window was the foreground window 250 ms after it was raised), and `reused` when the
 * stream went into the mpv already open. openStream passes the three on as the host sent
 * them (the message list at the top of native-host/faststream-mpv-host.mjs says what each
 * value means), so a caller can log or show an mpv that opened behind the browser.
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
// outdated host: the stream still goes to it, and the toolbar button's tooltip and "Test
// mpv connection" say to install the host again. Only that: no "!" on the button and no
// warning in the player since the thin helper (2026-10-13), as an older helper still works
// (through the messages it knows) and lacks only newer features.
export const RequiredHostVersion = 19;

// The largest message the host reads (MaxMessageBytes in native-host/faststream-mpv-host.mjs),
// as Firefox sends it: the JSON in UTF-8. A bigger one was never read: the host quit
// without a word, and the hand-off failed with "is the host installed?".
export const HostMaxMessageBytes = 1024 * 1024;

// What the thin helper takes in a play message (its checks refuse the whole message past
// them): the target's length, and the title's, in UTF-16 units.
export const MaxPlayTargetChars = 512 * 1024;
export const MaxPlayTitleChars = 1000;
// The start a play message may name: seconds, to the millisecond.
const PlayStart = /^\d{1,7}(\.\d{1,3})?$/;

// The thin helper's primitives (host 15), as its answers name them.
export const Capabilities = Object.freeze({PLAY: 'play', IPC: 'ipc', RELAY: 'relay'});

// How long a decoder question may wait for mpv to start decoding (the host's MaxStatusWaitMs),
// and how often it asks meanwhile.
export const MaxStatusWaitMs = 30000;
const StatusPollMs = 1000;

// What mpv is asked about its video decoder, in this order (decoderFromReplies): the host's
// status message asked the same.
export const DecoderProperties = ['hwdec-current', 'hwdec', 'video-format', 'width', 'height'];

const TooLongError = 'the stream\'s address is too long to send to mpv';
const PrivateNeedsNewerHostError = 'a private window\'s stream needs mpv helper 15 or newer: update the helper';

/**
 * Which video decoder an mpv started by the host uses (the host's `status` answer).
 * @typedef {Object} MpvDecoder
 * @property {boolean} hardware - False when mpv decodes in software (hwdec-current "no").
 * @property {string} api - mpv's hwdec-current: "d3d11va", "vulkan", "d3d11va-copy", "no"...
 * @property {?string} format - mpv's video-format: "av1", "h264", "hevc", "vp9"...
 * @property {?number} width
 * @property {?number} height
 */

/**
 * What a watch of mpv tells (watch): {type: 'watching'}, {type: 'path', path},
 * {type: 'ended', path}, {type: 'request', action}, {type: 'decoder', decoder} (the relay's
 * decoder-replies, read) and {type: 'closed', reason} last (MpvRelayWatch). A watch over a
 * helper before host 15 (legacyWatch) passes the host's own messages on as they came: the
 * same types but decoder, with whatever the host put in them; mpv's path is its property's
 * value as mpv sent it.
 * @typedef {{type: 'watching'}|{type: 'path'|'ended', path: *}|{type: 'request', action: *}|
 *   {type: 'closed', reason: *}|{type: 'decoder', decoder: ?MpvDecoder}} MpvWatchEvent
 */

/**
 * What relayWatch (MpvRelayWatch.mjs) tells: the events of a watch but decoder, and in its
 * place the decoder properties' values whenever one changed, as the ipc message's replies.
 * @typedef {{type: 'watching'}|{type: 'path'|'ended', path: string}|{type: 'request', action: string}|
 *   {type: 'closed', reason: string}|{type: 'decoder-replies', replies: Array<{error: string, data?: *}>}} RelayEvent
 */

// mpv's video-format names as people know them.
const FormatNames = new Map([
  ['av1', 'AV1'],
  ['h264', 'H.264'],
  ['hevc', 'HEVC'],
  ['vp9', 'VP9'],
  ['vp8', 'VP8'],
  ['mpeg2video', 'MPEG-2'],
]);

/**
 * The size of a message as it reaches the host.
 * @param {Object} message - The message.
 * @return {number} Bytes.
 */
function messageBytes(message) {
  return new TextEncoder().encode(JSON.stringify(message)).length;
}

/**
 * The open message for a helper before host 15 (openMessage): the helper builds mpv's URL,
 * title and the rest from it.
 * @typedef {{type: 'open', url: string, contentType?: string, pageUrl?: string, title?: string,
 *   start?: number, mpvPath?: string, fullscreen?: boolean, singleInstance?: boolean,
 *   headers?: Array<{name: string, value: string}>,
 *   qualities?: Array<{url: string, label: string, height: number}>,
 *   subtitles?: Array<{label: string, srt: string}>}} OpenMessage
 */

/**
 * The play message for the thin helper, host 15 (playMessage): the start in seconds as text,
 * the header fields as `Name: value` lines (relayHeaderFields).
 * @typedef {{type: 'play', target: string, title: string, start?: string, headers?: Array<string>,
 *   mpvPath?: string, fullscreen?: boolean, newWindow?: boolean,
 *   subtitles?: Array<{label: string, srt: string}>}} PlayMessage
 */

/**
 * Adds the subtitles that fit under the host's limit to a message, in order: one that does
 * not fit is left out, and the stream still goes. Last, so the rest of the message counts.
 * @param {OpenMessage|PlayMessage} message - The open or play message, all else in it.
 * @param {*} subtitles - The player's or the page's tracks: [{label, srt}].
 */
function addSubtitles(message, subtitles) {
  if (!Array.isArray(subtitles)) {
    return;
  }
  const candidates = subtitles
      .filter((s) => s && typeof s.srt === 'string' && s.srt.trim())
      .slice(0, 8)
      .map((s) => ({label: typeof s.label === 'string' ? cutText(s.label, 100) : '', srt: s.srt}));
  /** @type {Array<{label: string, srt: string}>} */
  const fitting = [];
  message.subtitles = fitting;
  for (const subtitle of candidates) {
    fitting.push(subtitle);
    if (messageBytes(message) > HostMaxMessageBytes) {
      fitting.pop();
      console.warn(`A subtitle track (${subtitle.label || 'no label'}) is too large to send to mpv, left out`);
    }
  }
  if (fitting.length === 0) {
    delete message.subtitles;
  }
}

/**
 * Follows mpv over a port to a helper before host 15 (host 7's watch message): the helper
 * itself tells the end of a file and the keys for the next or the previous episode.
 * @param {*} port - A connectNative port, nothing sent on it yet.
 * @param {(message: MpvWatchEvent) => void} onEvent - watching, path, ended, request, closed.
 * @return {import('./MpvRelayWatch.mjs').MpvWatcher}
 */
function legacyWatch(port, onEvent) {
  let stopped = false;
  /**
   * Ends the watch the first time it is called, and tells the watcher why; with a null
   * reason (stop()) no 'closed' event goes.
   * @param {string|null} reason - The host's error or close reason, or why the port went.
   * @return {boolean} Whether this call ended it.
   */
  const end = (reason) => {
    if (stopped) return false;
    stopped = true;
    if (reason) onEvent({type: 'closed', reason});
    return true;
  };
  /**
   * @param {{type: 'notify', title: string, detail: string, seconds?: number}|{type: 'hide'}|
   *   {type: 'state', autoplay: boolean}} message - For the host's watch (host 9 and 11).
   */
  const post = (message) => {
    if (stopped) return;
    try {
      port.postMessage(message);
    } catch (e) {
      // The host went meanwhile: onDisconnect says so.
    }
  };
  // The host's message as it came: checked here before use.
  port.onMessage.addListener((/** @type {*} */ message) => {
    if (stopped || !message || typeof message !== 'object') return;
    if (message.ok === false) {
      // A host before 7: "unknown message", and it exits.
      end(message.error || 'the mpv host cannot watch mpv');
      return;
    }
    if (message.type === 'closed') {
      end(message.reason || 'closed');
      return;
    }
    onEvent(message);
  });
  port.onDisconnect.addListener(() => {
    end(chrome.runtime.lastError?.message || 'the mpv host went');
  });
  port.postMessage({type: 'watch'});
  return {
    // Host 11: seconds, how long mpv shows it (notify.lua's own 2 s without).
    notify: (title, detail = '', seconds) => post(typeof seconds === 'number' ?
      {type: 'notify', title, detail, seconds} : {type: 'notify', title, detail}),
    // Host 11: takes the notice down before its time.
    hide: () => post({type: 'hide'}),
    // Host 9: what mpv's autoplay button shows ({autoplay: boolean}).
    state: (state) => post({type: 'state', ...state}),
    stop: () => {
      if (!end(null)) return;
      try {
        port.disconnect();
      } catch (e) {
        // Gone already.
      }
    },
  };
}

/**
 * What a send of a stream needs (openStream's arguments).
 * @typedef {{url: string, headers?: Array<{name: string, value: string}>, contentType?: string,
 *   pageUrl?: string, pageTitle?: string, extras: {startTime?: number, private?: boolean,
 *   subtitles?: Array<{label: string, srt: string}>,
 *   qualities?: Array<{url: string, label: string, height: number}>}}} MpvStream
 */

/**
 * What the browser said to a message for the host: the host's answer, or why there is none.
 * @typedef {{response?: *, error?: string, noHost?: boolean}} HostAnswer
 */

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
    // What the helper can do, from its last answer (its `capabilities`): null until one
    // came, an empty list for a helper from before host 15, which names none. Unknown, the
    // thin helper's message goes first: its answer says which one it is (learn()).
    /** @type {?Array<string>} */
    this.capabilities = null;
    // The last stream's send, which the next one waits for (sendStream).
    /** @type {Promise<*>} */
    this.lastSend = Promise.resolve();
    // The watch of mpv for MPV autoplay (watch()), while one runs.
    /** @type {?import('./MpvRelayWatch.mjs').MpvWatcher} */
    this.watcher = null;
  }

  /**
   * Remembers what the helper can do from one of its answers: host 15 names its primitives
   * in every answer, and an answer without them comes from an older helper, which has none
   * of them (it answers "unknown message" to them). A helper installed again meanwhile is
   * noticed at its next answer, whichever message that was.
   * @param {*} response - The helper's answer.
   */
  learn(response) {
    if (!response || typeof response !== 'object') {
      return;
    }
    this.capabilities = Array.isArray(response.capabilities) ?
      response.capabilities.filter((/** @type {*} */ capability) => typeof capability === 'string') : [];
  }

  /**
   * Whether to ask the helper through one of host 15's primitives: it has it, or nothing is
   * known yet (its answer will say; an older one answers "unknown message").
   * @param {string} capability - One of Capabilities.
   * @return {boolean}
   */
  mayUse(capability) {
    return this.capabilities === null || this.capabilities.includes(capability);
  }

  /**
   * Whether an answer says the helper does not know the message: a helper's answer to a
   * primitive it lacks, which the caller then asks the old way.
   * @param {*} response - The helper's answer.
   * @return {boolean}
   */
  static isUnknownMessage(response) {
    return !!response && typeof response === 'object' && response.ok === false && response.error === 'unknown message';
  }

  /**
   * Sends one message to the helper, remembering what its answer says of it (its version,
   * its capabilities).
   * @param {Object} message
   * @return {Promise<HostAnswer>} noHost when Firefox could not run the helper at all (not
   *   installed, or it died); error alone for a throw.
   */
  ask(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendNativeMessage(NativeHostName, message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({error: lastError.message, noHost: true});
            return;
          }
          this.learn(response);
          this.hostOutdated = MpvBackend.isHostOutdated(response);
          resolve({response});
        });
      } catch (e) {
        resolve({error: String(e)});
      }
    });
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
   * How the host's raising of mpv's window went, from an open's answer: focus, foreground
   * and reused as the host sent them, each only when it has the expected type.
   * @param {*} response - The host's answer.
   * @return {{focus?: string, foreground?: string, reused?: boolean}}
   */
  static focusOf(response) {
    /** @type {{focus?: string, foreground?: string, reused?: boolean}} */
    const fields = {};
    if (!response || typeof response !== 'object') {
      return fields;
    }
    if (typeof response.focus === 'string') {
      fields.focus = response.focus;
    }
    if (typeof response.foreground === 'string') {
      fields.foreground = response.foreground;
    }
    if (response.reused === true) {
      fields.reused = true;
    }
    return fields;
  }

  /**
   * A result with what is known about the host's version.
   * @template {{ok: boolean}} T
   * @param {T} result - The result.
   * @return {T & {hostOutdated?: boolean}} The result, with hostOutdated when the host is
   *   outdated.
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
    return isStreamUrl(url);
  }

  /**
   * The page's qualities as the host gets them (openStream): http(s) files of at most 2048
   * characters (a page's list could fill the host's message limit otherwise), each with a
   * label of at most 40 characters and its height (0 when unknown), at most 12; none for
   * fewer than two.
   * @param {*} qualities - [{url, label, height}] (PageQualityPick).
   * @return {?Array<{url: string, label: string, height: number}>}
   */
  static relayQualities(qualities) {
    if (!Array.isArray(qualities)) return null;
    const relayed = qualities
        .filter((entry) => entry && MpvBackend.isStreamUrl(entry.url) && entry.url.length <= 2048)
        .slice(0, 12)
        .map((entry) => ({
          url: entry.url,
          label: typeof entry.label === 'string' ? cutText(entry.label, 40) : '',
          height: Number.isFinite(entry.height) && entry.height > 0 ? Math.round(entry.height) : 0,
        }));
    return relayed.length >= 2 ? relayed : null;
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
   * The tab's title as mpv gets it in an open message (the host made streamTitle of it):
   * trimmed, at most 300 characters (whole ones: a cut through an emoji left half of it,
   * which mpv drew as a broken character, #470); undefined for none.
   * @param {*} pageTitle
   * @return {string|undefined}
   */
  static sentTitle(pageTitle) {
    return typeof pageTitle === 'string' && pageTitle.trim() ? cutText(pageTitle.trim(), 300) : undefined;
  }

  /**
   * The tab's page URL as mpv's fs-id and fs-page are made of: http(s) pages only, and only
   * a well-formed text. One with half of a surrogate pair cannot be percent-encoded
   * (encodeURIComponent throws): the helper until host 14 threw on it and answered nothing,
   * and the hand-off said the helper was not installed. Firefox's tab URLs are encoded
   * already; this is for whatever else names a page.
   * @param {*} pageUrl
   * @return {string|undefined}
   */
  static sentPageUrl(pageUrl) {
    if (typeof pageUrl !== 'string' || !/^https?:\/\//i.test(pageUrl)) {
      return undefined;
    }
    try {
      encodeURIComponent(pageUrl);
    } catch (e) {
      return undefined;
    }
    return pageUrl;
  }

  /**
   * Opens a stream URL in mpv via the native messaging host: a play message, built here,
   * for the thin helper (host 15); the open message, as before, for an older helper.
   * @param {string} url - The stream URL to play.
   * @param {import('./TabTracker.mjs').TabHolder|null} [tab] - TabHolder the source was
   *   detected in, used to deduplicate repeated detections of the same URL; null for a
   *   send no tab dedupes (the player's button, the MPV key's play).
   * @param {Array<{name: string, value: string}>} [headers] - Optional
   *   Referer/Origin headers to relay.
   * @param {string} [contentType] - 'anime' or 'movie', from the MPV
   *   allowlist tag or the player's manual override. Anything else is
   *   dropped rather than relayed.
   * @param {string} [pageUrl] - The tab's page URL, the key mpv resumes the
   *   playback position by. Only http(s) URLs are relayed.
   * @param {string} [pageTitle] - The tab's title, which mpv shows for the stream
   *   (window, taskbar, top bar); without one the host shows the stream's host name.
   * @param {{startTime?: number, private?: boolean, subtitles?: Array<{label: string, srt: string}>,
   *   qualities?: Array<{url: string, label: string, height: number}>}} [extras]
   *   - Where the browser's player was, whether the tab is a private window's, the subtitles
   *   it shows (the player's button), and the qualities the page's player offers the file in.
   * @return {Promise<{ok: boolean, error?: string, noHost?: boolean, hostOutdated?: boolean,
   *   focus?: string, foreground?: string, reused?: boolean}>}
   *   Host response; noHost when the host itself could not be reached, hostOutdated when
   *   it answered as a version older than RequiredHostVersion; focus, foreground and reused
   *   as the host sent them for an open that worked (focusOf; none for a URL already sent,
   *   which asks the host nothing).
   */
  openStream(url, tab, headers, contentType, pageUrl, pageTitle, extras = {}) {
    if (!MpvBackend.isStreamUrl(url)) {
      return Promise.resolve({ok: false, error: 'mpv is only given http(s) streams'});
    }

    if (tab && tab.mpvSentUrls) {
      // One still on its way: its own answer. An "ok" at once was wrong when that one then
      // failed: the player said it was sent and paused the page for nothing (glm's look at
      // a noted edge case, 2026-10-13).
      const sending = tab.mpvSending?.get(url);
      if (sending) {
        return sending;
      }
      if (tab.mpvSentUrls.has(url)) {
        return Promise.resolve(this.withHostState({ok: true}));
      }
      tab.mpvSentUrls.add(url);
    }

    /** @type {MpvStream} */
    const stream = {url, headers, contentType, pageUrl, pageTitle, extras: extras || {}};
    // Never a rejection: the callers take the answer as it comes, and a throw while the
    // message was built is a send that did not go.
    const sent = this.sendStream(stream).catch((e) => ({ok: false, error: String(e)})).then((result) => {
      // Not sent, or the host answered but mpv never started (bad path, no mpv installed):
      // forget the URL so the user can retry it after fixing the cause. Left recorded, every
      // later attempt at this URL reported success without playing anything.
      if (!result.ok && tab && tab.mpvSentUrls) {
        tab.mpvSentUrls.delete(url);
      }
      return result;
    });
    if (tab && tab.mpvSentUrls) {
      if (!tab.mpvSending) tab.mpvSending = new Map();
      tab.mpvSending.set(url, sent);
      // Off the list once answered (it always is: it never rejects).
      sent.then(() => {
        if (tab.mpvSending.get(url) === sent) tab.mpvSending.delete(url);
      }).catch(() => {});
    }
    return sent;
  }

  /**
   * Sends a stream to the helper, one at a time (sendStreamNow): each send is a helper
   * process of its own, and two at once with no mpv running each found no pipe and started
   * an mpv - the second on the same pipe name, with no IPC for good, which no later send
   * reached. The next starts once the last has its answer, by when its mpv has the pipe.
   * @param {MpvStream} stream
   * @return {Promise<{ok: boolean, error?: string, noHost?: boolean, hostOutdated?: boolean,
   *   focus?: string, foreground?: string, reused?: boolean}>}
   */
  sendStream(stream) {
    const mine = this.lastSend.then(() => this.sendStreamNow(stream));
    this.lastSend = mine.catch(() => {});
    return mine;
  }

  /**
   * Sends a stream to the helper: as a play message while the helper may have it (host 15,
   * or nothing known yet), else, or when it answers that it does not know it, as an open
   * message.
   * @param {MpvStream} stream
   * @return {Promise<{ok: boolean, error?: string, noHost?: boolean, hostOutdated?: boolean,
   *   focus?: string, foreground?: string, reused?: boolean}>}
   */
  async sendStreamNow(stream) {
    if (this.mayUse(Capabilities.PLAY)) {
      const play = await this.playMessage(stream);
      if (!play.message) {
        return this.withHostState({ok: false, error: play.error || TooLongError});
      }
      const answer = await this.ask(play.message);
      if (!(MpvBackend.isUnknownMessage(answer.response) && !this.mayUse(Capabilities.PLAY))) {
        return this.streamResult(answer);
      }
      // A helper from before host 15: the same stream once more, as it knows it.
    }
    // Not a private window's: the open message has no fs-private, and mpv kept where such a
    // stream was left, on disk (stream-resume.json).
    if (stream.extras.private === true) {
      return this.withHostState({ok: false, error: PrivateNeedsNewerHostError});
    }
    const message = this.openMessage(stream);
    if (!message) {
      return this.withHostState({ok: false, error: TooLongError});
    }
    return this.streamResult(await this.ask(message));
  }

  /**
   * What a send of a stream says: the helper's own reason when it gave one, focus, foreground
   * and reused for one that worked.
   * @param {HostAnswer} answer
   * @return {{ok: boolean, error?: string, noHost?: boolean, hostOutdated?: boolean,
   *   focus?: string, foreground?: string, reused?: boolean}}
   */
  streamResult(answer) {
    if (answer.noHost) {
      if (!this.warnedAboutHost) {
        this.warnedAboutHost = true;
        console.warn('MPV native host not available:', answer.error);
      }
      // noHost: Firefox could not run the host at all (not installed, or it died), as
      // opposed to a reason the host itself gave.
      return {ok: false, error: answer.error, noHost: true};
    }
    if (!('response' in answer)) {
      return {ok: false, error: answer.error};
    }
    const response = answer.response;
    if (response && response.ok === false) {
      return this.withHostState({ok: false, error: response.error || 'mpv host error'});
    }
    return this.withHostState({ok: true, ...MpvBackend.focusOf(response)});
  }

  /**
   * The open message for a helper before host 15: the helper builds mpv's URL, title and
   * the rest from it.
   * @param {MpvStream} stream
   * @return {?OpenMessage} The message; null when even without subtitles it is over the host's
   *   limit (a stream address near Firefox's own URL limit, 1 MB, made the host quit unread,
   *   which said "is the helper installed?", and every later detection of the stream tried
   *   again; glm's review, 2026-10-13).
   */
  openMessage({url, headers, contentType, pageUrl, pageTitle, extras}) {
    /** @type {OpenMessage} */
    const message = {
      type: 'open',
      url: url,
    };

    if (contentType === 'anime' || contentType === 'movie') {
      message.contentType = contentType;
    }

    const sentPageUrl = MpvBackend.sentPageUrl(pageUrl);
    if (sentPageUrl) {
      message.pageUrl = sentPageUrl;
    }

    const title = MpvBackend.sentTitle(pageTitle);
    if (title) {
      message.title = title;
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

    // The qualities the page's player offers the file in (page-qualities.js), the one sent
    // among them, for mpv to switch between: http(s) files with a short label, at most 12.
    const qualities = MpvBackend.relayQualities(extras.qualities);
    if (qualities) {
      message.qualities = qualities;
    }

    addSubtitles(message, extras.subtitles);

    return messageBytes(message) > HostMaxMessageBytes ? null : message;
  }

  /**
   * The play message for the thin helper (host 15): mpv's URL with its fs-* tags, the title,
   * the header fields and the start, built as the helper built them from an open message
   * (MpvTarget.mjs), so mpv and its scripts see the same for the same stream. The helper
   * checks each field again and refuses the whole message past its limits, so they are kept
   * here: a header field ending in a backslash is left out (the helper's loadfile left it out
   * too: mpv would join the next field to it), a target over MaxPlayTargetChars goes without
   * the page's qualities first.
   *
   * The options page's mpv path goes along as in the open message: the helper takes it by
   * the same rule (an mpv executable, or the folder it is in; else its config.json's).
   * @param {MpvStream} stream
   * @return {Promise<{message?: PlayMessage, error?: string}>}
   */
  async playMessage({url, headers, contentType, pageUrl, pageTitle, extras}) {
    const tags = {
      url,
      contentType,
      pageUrl: MpvBackend.sentPageUrl(pageUrl),
      qualities: MpvBackend.relayQualities(extras.qualities),
      // A private window's: mpv keeps no resume position (fs-private). The helper before
      // host 15 builds the URL itself, from the open message, and cannot say it.
      private: extras.private === true,
    };
    let target = await mpvTargetUrl(tags);
    if (target.length > MaxPlayTargetChars && tags.qualities) {
      // mpv's quality menu goes without the list, as the helper's command line did (#470).
      target = await mpvTargetUrl({...tags, qualities: null});
    }
    if (target.length > MaxPlayTargetChars) {
      return {error: TooLongError};
    }

    /** @type {PlayMessage} */
    const message = {
      type: 'play',
      target,
      title: cutToLength(streamTitle({url, title: MpvBackend.sentTitle(pageTitle)}), MaxPlayTitleChars),
    };

    const start = startOf({start: extras.startTime});
    if (start !== undefined && PlayStart.test(String(start))) {
      message.start = String(start);
    }

    const fields = relayHeaderFields(MpvBackend.pickRelayHeaders(headers)).filter((field) => !field.endsWith('\\'));
    if (fields.length > 0) {
      message.headers = fields;
    }

    // The user's mpv path preference (options page), so the helper does not have to guess
    // where mpv is installed.
    if (this.mpvPath) {
      message.mpvPath = this.mpvPath;
    }

    if (this.fullscreen) {
      message.fullscreen = true;
    }

    // The options page's "one mpv window" off: a window of its own for this stream.
    if (!this.singleInstance) {
      message.newWindow = true;
    }

    addSubtitles(message, extras.subtitles);

    return messageBytes(message) > HostMaxMessageBytes ? {error: TooLongError} : {message};
  }

  /**
   * Follows the mpv the host started (host 7's watch; over the thin helper's relay since host
   * 15): the end of its file and its keys for the next or the previous episode come as they
   * happen, for MPV autoplay (2026-10-11). One at a time: a second watch ends the first. While
   * the port is open, Firefox keeps this background page running, with nothing sent over it
   * (measured on Firefox 158: 12 minutes at the 30 s idle timeout, tools/native-port-idle and
   * docs/notes/mpv.md), so the end is heard however long the episode runs.
   *
   * The thin helper only relays mpv's lines; what counts as an end is MpvRelayWatch.mjs's.
   * An older helper (or one not known yet that turns out older: it answers "unknown message")
   * is followed with its own watch message, and the events are the same either way.
   * @param {(message: MpvWatchEvent) => void} onEvent - Each message: watching, path, ended,
   *   request, decoder, closed (last; also for a host too old to watch, which answers ok: false).
   * @return {import('./MpvRelayWatch.mjs').MpvWatcher}
   */
  watch(onEvent) {
    this.watcher?.stop();
    /** @type {?import('./MpvRelayWatch.mjs').MpvWatcher} */
    let current = null;
    let stopped = false;
    /** @type {import('./MpvRelayWatch.mjs').MpvWatcher} */
    const handle = {
      notify: (title, detail = '', seconds) => current?.notify(title, detail, seconds),
      hide: () => current?.hide(),
      state: (state) => current?.state(state),
      stop: () => {
        stopped = true;
        if (this.watcher === handle) this.watcher = null;
        current?.stop();
      },
    };
    /** @param {MpvWatchEvent} event */
    const emit = (event) => {
      if (event.type === 'closed' && this.watcher === handle) this.watcher = null;
      onEvent(event);
    };
    /** @param {boolean} relay - Over the thin helper's relay (host 15), else host 7's watch. */
    const start = (relay) => {
      /** @type {*} */
      let port;
      try {
        port = chrome.runtime.connectNative(NativeHostName);
      } catch (e) {
        current = null;
        emit({type: 'closed', reason: String(e)});
        return;
      }
      current = relay ? relayWatch(port, (/** @type {RelayEvent} */ event) => {
        // mpv's decoder, observed over the relay: read as decoderStatus reads it.
        if (event.type === 'decoder-replies') {
          emit({type: 'decoder', decoder: MpvBackend.readDecoder(MpvBackend.decoderFromReplies(event.replies))});
        } else {
          emit(event);
        }
      }, {
        onLegacy: () => {
          // It is older than host 15: followed the old way, and asked the old way from now on.
          this.capabilities = [];
          if (!stopped) start(false);
        },
        decoderProperties: DecoderProperties,
      }) : legacyWatch(port, emit);
    };
    this.watcher = handle;
    start(this.mayUse(Capabilities.RELAY));
    return handle;
  }

  /**
   * Asks which video decoder the mpv the host started uses (only an mpv started for
   * single-instance use can be asked). Read-only: mpv.conf stays the only authority on
   * hardware decoding, and FastStream only says what mpv does. The thin helper (host 15) is
   * asked mpv's properties over its ipc primitive, once a second while mpv has no decoder
   * yet, as the host's status message did itself; an older helper gets that message.
   * @param {number} [waitMs] - How long to wait for mpv to load a decoder.
   * @return {Promise<{ok: boolean, running?: boolean, decoder?: ?MpvDecoder, error?: string,
   *   hostOutdated?: boolean}>} running:false when no mpv of ours is open; decoder null
   *   while it has none loaded (or from a host too old to ask).
   */
  async decoderStatus(waitMs = 0) {
    if (!this.mayUse(Capabilities.IPC)) {
      return this.legacyDecoderStatus(waitMs);
    }
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), MaxStatusWaitMs);
    const commands = DecoderProperties.map((name) => ['get_property', name]);
    const started = Date.now();
    for (;;) {
      const answer = await this.ask({type: 'ipc', commands});
      if (!('response' in answer)) {
        return {ok: false, error: answer.error};
      }
      const response = answer.response;
      if (MpvBackend.isUnknownMessage(response) && !this.mayUse(Capabilities.IPC)) {
        return this.legacyDecoderStatus(waitMs);
      }
      if (!response || typeof response !== 'object') {
        return this.withHostState({ok: false, error: 'mpv host error'});
      }
      /** @type {?Object} */
      let decoder = null;
      if (response.ok !== true) {
        // A command the helper's allowlist refused: no question to ask again.
        if (response.error === 'refused') {
          return this.withHostState({ok: false, error: 'the mpv host refused the question'});
        }
        // No pipe: no mpv of ours. A busy one runs, and may answer next time.
        if (response.busy !== true && response.error !== 'mpv did not answer') {
          return this.withHostState({ok: true, running: false, decoder: null});
        }
      } else {
        decoder = MpvBackend.decoderFromReplies(response.replies);
      }
      if (decoder || Date.now() - started + StatusPollMs > wait) {
        return this.withHostState({ok: true, running: true, decoder: MpvBackend.readDecoder(decoder)});
      }
      await new Promise((resolve) => setTimeout(resolve, StatusPollMs));
    }
  }

  /**
   * decoderStatus for a helper before host 15: its status message.
   * @param {number} waitMs
   * @return {Promise<{ok: boolean, running?: boolean, decoder?: ?MpvDecoder, error?: string,
   *   hostOutdated?: boolean}>}
   */
  async legacyDecoderStatus(waitMs) {
    const answer = await this.ask({type: 'status', waitMs});
    if (!('response' in answer)) {
      return {ok: false, error: answer.error};
    }
    const response = answer.response;
    if (!response || response.ok !== true) {
      // A host from before the status message answers "unknown message".
      return this.withHostState({ok: false, error: (response && response.error) || 'mpv host error'});
    }
    return this.withHostState({
      ok: true,
      running: response.running === true,
      decoder: MpvBackend.readDecoder(response.decoder),
    });
  }

  /**
   * Reads mpv's answers about its video decoder (DecoderProperties, in that order), as the
   * host's decoderFromReplies did. `hwdec-current` is the hardware decoding API in use
   * ("d3d11va", "vulkan", "nvdec", or "-copy" forms of them), "no" when mpv decodes in
   * software, and unavailable while no video decoder is loaded.
   * @param {*} replies - The ipc answer's replies: [{error, data}], one per property.
   * @return {?{hardware: boolean, api: string, requested: ?string, format: ?string,
   *   width: ?number, height: ?number}} null while no decoder is loaded.
   */
  static decoderFromReplies(replies) {
    /**
     * @param {number} index - The property's place in DecoderProperties.
     * @return {*} Its value, or undefined for an error or no reply.
     */
    const value = (index) => {
      const reply = Array.isArray(replies) ? replies[index] : undefined;
      return reply && typeof reply === 'object' && (reply.error === undefined || reply.error === 'success') ?
        reply.data : undefined;
    };
    const api = value(0);
    if (typeof api !== 'string' || !api) {
      return null;
    }
    /**
     * @param {*} v - A property's value as mpv sent it.
     * @return {?string}
     */
    const text = (v) => (typeof v === 'string' && v ? v : null);
    /**
     * @param {*} v - A property's value as mpv sent it.
     * @return {?number}
     */
    const size = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
    return {
      hardware: api !== 'no',
      api,
      requested: text(value(1)),
      format: text(value(2)),
      width: size(value(3)),
      height: size(value(4)),
    };
  }

  /**
   * The host's decoder answer, checked field by field.
   * @param {*} value
   * @return {?MpvDecoder}
   */
  static readDecoder(value) {
    if (!value || typeof value !== 'object' || typeof value.api !== 'string' || !value.api) {
      return null;
    }
    /**
     * @param {*} v - A field of the host's answer, as it sent it.
     * @return {?string}
     */
    const text = (v) => (typeof v === 'string' && v ? v.slice(0, 40) : null);
    /**
     * @param {*} v - A field of the host's answer, as it sent it.
     * @return {?number}
     */
    const size = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
    return {
      hardware: value.api !== 'no',
      api: value.api.slice(0, 40),
      format: text(value.format),
      width: size(value.width),
      height: size(value.height),
    };
  }

  /**
   * How the toolbar tooltip and "Test mpv connection" name a decoder:
   * "d3d11va, AV1 1920x1080", or "AV1 1920x1080" in software.
   * @param {?MpvDecoder} decoder
   * @return {string}
   */
  static describeDecoder(decoder) {
    if (!decoder) {
      return '';
    }
    const parts = [];
    if (decoder.hardware) {
      parts.push(decoder.api);
    }
    const format = decoder.format ? (FormatNames.get(decoder.format) || decoder.format.toUpperCase()) : '';
    const size = decoder.width && decoder.height ? `${decoder.width}x${decoder.height}` : '';
    const video = [format, size].filter(Boolean).join(' ');
    if (video) {
      parts.push(video);
    }
    return parts.join(', ');
  }

  /**
   * Pings the native host and asks it to locate mpv. Its answer also says what it can do
   * (learn()).
   * @return {Promise<{ok: boolean, mpv?: boolean, path?: string, error?: string, hostOutdated?: boolean}>}
   */
  async testConnection() {
    /** @type {{type: 'ping', mpvPath?: string}} */
    const pingMessage = {
      type: 'ping',
    };
    if (this.mpvPath) {
      pingMessage.mpvPath = this.mpvPath;
    }
    const answer = await this.ask(pingMessage);
    if (!('response' in answer)) {
      return {ok: false, error: answer.error};
    }
    const response = answer.response;
    return this.withHostState({
      ok: true,
      mpv: !!(response && response.mpv),
      path: response ? response.path : undefined,
    });
  }
}
