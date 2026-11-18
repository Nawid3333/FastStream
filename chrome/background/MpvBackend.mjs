// @ts-check

import {relayWatch} from './MpvRelayWatch.mjs';
import {cutText, cutToLength, isMpvContentType, isStreamUrl, mpvTargetUrl, relayHeaderFields, startOf, streamTitle} from './MpvTarget.mjs';

/** Native messaging client for the mpv helper; its messages: the top of native-host/faststream-mpv-host.mjs. */

const NativeHostName = 'com.faststream.mpv';

// HostVersion in native-host/faststream-mpv-host.mjs (mpvHostVersion.test.mjs keeps them equal); a lower one still plays.
export const RequiredHostVersion = 19;

// The host's MaxMessageBytes, of the UTF-8 JSON: a bigger message made it quit without a word.
export const HostMaxMessageBytes = 1024 * 1024;

// Past these (UTF-16 units) the thin helper refuses the whole play message.
export const MaxPlayTargetChars = 512 * 1024;
export const MaxPlayTitleChars = 1000;
// The start a play message may name: seconds, to the millisecond.
const PlayStart = /^\d{1,7}(\.\d{1,3})?$/;

export const Capabilities = Object.freeze({PLAY: 'play', IPC: 'ipc', RELAY: 'relay'});

// The host's MaxStatusWaitMs, and how often a decoder question asks meanwhile.
export const MaxStatusWaitMs = 30000;
const StatusPollMs = 1000;

// The host's status message asked the same, in this order (decoderFromReplies).
export const DecoderProperties = ['hwdec-current', 'hwdec', 'video-format', 'width', 'height'];

const TooLongError = 'the stream\'s address is too long to send to mpv';
const PrivateNeedsNewerHostError = 'a private window\'s stream needs mpv helper 15 or newer: update the helper';

/**
 * @typedef {Object} MpvDecoder
 * @property {boolean} hardware
 * @property {string} api
 * @property {?string} format
 * @property {?number} width
 * @property {?number} height
 */

/**
 * @typedef {{type: 'watching'}|{type: 'path'|'ended', path: *}|{type: 'request', action: *}|
 *   {type: 'closed', reason: *}|{type: 'decoder', decoder: ?MpvDecoder}} MpvWatchEvent
 */

/**
 * @typedef {{type: 'watching'}|{type: 'path'|'ended', path: string}|{type: 'request', action: string}|
 *   {type: 'closed', reason: string}|{type: 'decoder-replies', replies: Array<{error: string, data?: *}>}} RelayEvent
 */

const FormatNames = new Map([
  ['av1', 'AV1'],
  ['h264', 'H.264'],
  ['hevc', 'HEVC'],
  ['vp9', 'VP9'],
  ['vp8', 'VP8'],
  ['mpeg2video', 'MPEG-2'],
]);

/**
 * @param {Object} message
 * @return {number}
 */
function messageBytes(message) {
  return new TextEncoder().encode(JSON.stringify(message)).length;
}

/**
 * @typedef {{type: 'open', url: string, contentType?: string, pageUrl?: string, title?: string,
 *   start?: number, mpvPath?: string, fullscreen?: boolean, singleInstance?: boolean,
 *   headers?: Array<{name: string, value: string}>,
 *   qualities?: Array<{url: string, label: string, height: number}>,
 *   subtitles?: Array<{label: string, srt: string}>}} OpenMessage
 */

/**
 * @typedef {{type: 'play', target: string, title: string, start?: string, headers?: Array<string>,
 *   mpvPath?: string, fullscreen?: boolean, newWindow?: boolean,
 *   subtitles?: Array<{label: string, srt: string}>}} PlayMessage
 */

/**
 * One that does not fit is left out, and the stream still goes; added last, so the rest counts.
 * @param {OpenMessage|PlayMessage} message
 * @param {*} subtitles
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
 * @param {*} port
 * @param {(message: MpvWatchEvent) => void} onEvent
 * @return {import('./MpvRelayWatch.mjs').MpvWatcher}
 */
function legacyWatch(port, onEvent) {
  let stopped = false;
  /**
   * A null reason (stop()) sends no 'closed' event.
   * @param {string|null} reason
   * @return {boolean}
   */
  const end = (reason) => {
    if (stopped) return false;
    stopped = true;
    if (reason) onEvent({type: 'closed', reason});
    return true;
  };
  /**
   * @param {{type: 'notify', title: string, detail: string, seconds?: number}|{type: 'hide'}|
   *   {type: 'state', autoplay: boolean}} message
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
    // Seconds, how long mpv shows it (notify.lua's own 2 s without).
    notify: (title, detail = '', seconds) => post(typeof seconds === 'number' ?
      {type: 'notify', title, detail, seconds} : {type: 'notify', title, detail}),
    // Takes the notice down before its time.
    hide: () => post({type: 'hide'}),
    // What mpv's autoplay button shows ({autoplay: boolean}).
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
 * @typedef {{url: string, headers?: Array<{name: string, value: string}>, contentType?: string,
 *   pageUrl?: string, pageTitle?: string, extras: {startTime?: number, private?: boolean,
 *   subtitles?: Array<{label: string, srt: string}>,
 *   qualities?: Array<{url: string, label: string, height: number}>}}} MpvStream
 */

/** @typedef {{response?: *, error?: string, noHost?: boolean}} HostAnswer */

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
    // One host serves the whole browser, so it is kept here and goes with every result.
    /** @type {boolean} */
    this.hostOutdated = false;
    // null until an answer came; [] for a helper before host 15. Unknown, the thin helper's message goes first.
    /** @type {?Array<string>} */
    this.capabilities = null;
    /** @type {Promise<*>} */
    this.lastSend = Promise.resolve();
    /** @type {?import('./MpvRelayWatch.mjs').MpvWatcher} */
    this.watcher = null;
  }

  /**
   * A helper installed again meanwhile is noticed at its next answer.
   * @param {*} response
   */
  learn(response) {
    if (!response || typeof response !== 'object') {
      return;
    }
    this.capabilities = Array.isArray(response.capabilities) ?
      response.capabilities.filter((/** @type {*} */ capability) => typeof capability === 'string') : [];
  }

  /**
   * Unknown yet counts as yes: an older helper answers "unknown message".
   * @param {string} capability
   * @return {boolean}
   */
  mayUse(capability) {
    return this.capabilities === null || this.capabilities.includes(capability);
  }

  /**
   * @param {*} response
   * @return {boolean}
   */
  static isUnknownMessage(response) {
    return !!response && typeof response === 'object' && response.ok === false && response.error === 'unknown message';
  }

  /**
   * noHost when Firefox could not run the helper at all; error alone for a throw.
   * @param {Object} message
   * @return {Promise<HostAnswer>}
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
   * @param {*} response
   * @return {boolean}
   */
  static isHostOutdated(response) {
    const version = response && typeof response === 'object' ? response.hostVersion : undefined;
    return !(Number.isInteger(version) && version >= RequiredHostVersion);
  }

  /**
   * @param {*} response
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
   * @template {{ok: boolean}} T
   * @param {T} result
   * @return {T & {hostOutdated?: boolean}}
   */
  withHostState(result) {
    return this.hostOutdated ? {...result, hostOutdated: true} : result;
  }

  /**
   * http(s) only, the string itself starting with the scheme: a UNC path makes Windows sign in with the user's credentials.
   * @param {*} url
   * @return {boolean}
   */
  static isStreamUrl(url) {
    return isStreamUrl(url);
  }

  /**
   * Files of at most 2048 characters (the host's message limit), labels of 40, at most 12; none for fewer than two.
   * @param {*} qualities
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
   * Duplicates are dropped, keeping the first value.
   * @param {Array<{name: string, value: string}>|undefined} headerList
   * @return {Array<{name: string, value: string}>|undefined}
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
      // Printable ASCII only, as the host requires: a value can come from a page.
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
   * Whole characters: a cut through an emoji left half of it, drawn broken by mpv.
   * @param {*} pageTitle
   * @return {string|undefined}
   */
  static sentTitle(pageTitle) {
    return typeof pageTitle === 'string' && pageTitle.trim() ? cutText(pageTitle.trim(), 300) : undefined;
  }

  /**
   * Half a surrogate pair cannot be percent-encoded: a helper before host 15 threw on it and answered nothing.
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
   * A play message for the thin helper, an open message for an older one.
   * @param {string} url
   * @param {import('./TabTracker.mjs').TabHolder|null} [tab]
   * @param {Array<{name: string, value: string}>} [headers]
   * @param {string} [contentType]
   * @param {string} [pageUrl]
   * @param {string} [pageTitle]
   * @param {{startTime?: number, private?: boolean, subtitles?: Array<{label: string, srt: string}>,
   *   qualities?: Array<{url: string, label: string, height: number}>}} [extras]
   * @return {Promise<{ok: boolean, error?: string, noHost?: boolean, hostOutdated?: boolean,
   *   focus?: string, foreground?: string, reused?: boolean}>}
   */
  openStream(url, tab, headers, contentType, pageUrl, pageTitle, extras = {}) {
    if (!MpvBackend.isStreamUrl(url)) {
      return Promise.resolve({ok: false, error: 'mpv is only given http(s) streams'});
    }

    if (tab && tab.mpvSentUrls) {
      // One still on its way: its own answer, as an "ok" at once was wrong when that one failed.
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
    // Never a rejection: a throw while the message was built is a send that did not go.
    const sent = this.sendStream(stream).catch((e) => ({ok: false, error: String(e)})).then((result) => {
      // Not sent, or mpv never started: forget the URL so the user can retry it.
      if (!result.ok && tab && tab.mpvSentUrls) {
        tab.mpvSentUrls.delete(url);
      }
      return result;
    });
    if (tab && tab.mpvSentUrls) {
      if (!tab.mpvSending) tab.mpvSending = new Map();
      tab.mpvSending.set(url, sent);
      sent.then(() => {
        if (tab.mpvSending.get(url) === sent) tab.mpvSending.delete(url);
      }).catch(() => {});
    }
    return sent;
  }

  /**
   * One at a time: two at once with no mpv running each started an mpv on the same pipe name.
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
    // Not a private window's: the open message has no fs-private, and mpv would keep the position on disk.
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
      // noHost: Firefox could not run the host at all, not a reason the host gave.
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
   * null when over the host's limit even without subtitles: the host quit unread.
   * @param {MpvStream} stream
   * @return {?OpenMessage}
   */
  openMessage({url, headers, contentType, pageUrl, pageTitle, extras}) {
    /** @type {OpenMessage} */
    const message = {
      type: 'open',
      url: url,
    };

    if (isMpvContentType(contentType)) {
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

    const qualities = MpvBackend.relayQualities(extras.qualities);
    if (qualities) {
      message.qualities = qualities;
    }

    addSubtitles(message, extras.subtitles);

    return messageBytes(message) > HostMaxMessageBytes ? null : message;
  }

  /**
   * Built as the helper built them (MpvTarget.mjs), within the helper's limits, which refuse the whole message.
   * @param {MpvStream} stream
   * @return {Promise<{message?: PlayMessage, error?: string}>}
   */
  async playMessage({url, headers, contentType, pageUrl, pageTitle, extras}) {
    const tags = {
      url,
      contentType,
      pageUrl: MpvBackend.sentPageUrl(pageUrl),
      qualities: MpvBackend.relayQualities(extras.qualities),
      // A private window's: mpv keeps no resume position (fs-private).
      private: extras.private === true,
    };
    let target = await mpvTargetUrl(tags);
    if (target.length > MaxPlayTargetChars && tags.qualities) {
      // Over MaxPlayTargetChars: the target goes without the qualities.
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

    if (this.mpvPath) {
      message.mpvPath = this.mpvPath;
    }

    if (this.fullscreen) {
      message.fullscreen = true;
    }

    if (!this.singleInstance) {
      message.newWindow = true;
    }

    addSubtitles(message, extras.subtitles);

    return messageBytes(message) > HostMaxMessageBytes ? {error: TooLongError} : {message};
  }

  /**
   * One at a time; while its port is open Firefox keeps the background running (docs/notes/mpv.md).
   * @param {(message: MpvWatchEvent) => void} onEvent
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
    /** @param {boolean} relay */
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
   * Read-only: mpv.conf stays the only authority on hardware decoding.
   * @param {number} [waitMs]
   * @return {Promise<{ok: boolean, running?: boolean, decoder?: ?MpvDecoder, error?: string,
   *   hostOutdated?: boolean}>}
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
   * `hwdec-current`: the API in use, "no" in software, unavailable while no decoder is loaded.
   * @param {*} replies
   * @return {?{hardware: boolean, api: string, requested: ?string, format: ?string,
   *   width: ?number, height: ?number}}
   */
  static decoderFromReplies(replies) {
    /**
     * @param {number} index
     * @return {*}
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
     * @param {*} v
     * @return {?string}
     */
    const text = (v) => (typeof v === 'string' && v ? v : null);
    /**
     * @param {*} v
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
   * @param {*} value
   * @return {?MpvDecoder}
   */
  static readDecoder(value) {
    if (!value || typeof value !== 'object' || typeof value.api !== 'string' || !value.api) {
      return null;
    }
    /**
     * @param {*} v
     * @return {?string}
     */
    const text = (v) => (typeof v === 'string' && v ? v.slice(0, 40) : null);
    /**
     * @param {*} v
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

  /** @return {Promise<{ok: boolean, mpv?: boolean, path?: string, error?: string, hostOutdated?: boolean}>} */
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
