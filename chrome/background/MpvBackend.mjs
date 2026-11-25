// @ts-check

import {EnvUtils} from '../player/utils/EnvUtils.mjs';
import {relayWatch} from './MpvRelayWatch.mjs';
import {cutText, cutToLength, isStreamUrl, mpvTargetUrl, relayHeaderFields, startOf, streamTitle} from './MpvTarget.mjs';
import {windowOf} from './MpvWindows.mjs';

/** Native messaging client for the mpv helper; its messages: the top of native-host/faststream-mpv-host.mjs. */

const NativeHostName = 'com.faststream.mpv';

// The helper this extension speaks to, at least: an older one gets no stream, only the update message (checkHost).
// HostVersion in native-host/faststream-mpv-host.mjs; mpvHostVersion.test.mjs keeps it no higher.
export const RequiredHostVersion = 33;

// The host's MaxMessageBytes, of the UTF-8 JSON: a bigger message is answered with an error.
export const HostMaxMessageBytes = 16 * 1024 * 1024;

// Past these (UTF-16 units) the helper refuses the whole play message.
export const MaxPlayTargetChars = 512 * 1024;
export const MaxPlayTitleChars = 1000;
const MaxSubtitleChars = 1024 * 1024;
// The start a play message may name: seconds, to the millisecond.
const PlayStart = /^\d{1,7}(\.\d{1,3})?$/;

// How long a decoder question may wait (until a slow stream opens, mpv names no decoder), and how often it asks.
export const MaxStatusWaitMs = 30000;
const StatusPollMs = 1000;

// What mpv is asked about its video decoder, in this order (decoderFromReplies).
export const DecoderProperties = ['hwdec-current', 'hwdec', 'video-format', 'width', 'height'];

const TooLongError = 'the stream\'s address is too long to send to mpv';
// The options page's words for an outdated helper (options_mpv_test_outdated*), for a locale without them.
const OutdatedError = 'The mpv helper on this computer is out of date: run "Update mpv" from the Start menu ' +
  '(in a FastStream checkout: update-local.cmd or native-host\\install.ps1).';
const OutdatedUnixError = 'The mpv helper on this computer is out of date: update the faststream-mpv-host.mjs that ' +
  'your native messaging manifest points to (git pull in your FastStream checkout; see native-host/README.md).';

/**
 * @typedef {Object} MpvDecoder
 * @property {boolean} hardware
 * @property {string} api
 * @property {?string} format
 * @property {?number} width
 * @property {?number} height
 */

/**
 * choice: mpv-config's answer to an offer (MpvOffer.mjs); queued: how many wait in mpv-config's queue.
 * @typedef {{type: 'watching'}|{type: 'path'|'ended', path: *}|{type: 'request', action: *}|
 *   {type: 'closed', reason: *}|{type: 'decoder', decoder: ?MpvDecoder}|{type: 'choice', id: string, choice: string}|
 *   {type: 'queued', count: number}} MpvWatchEvent
 */

/**
 * @typedef {{type: 'watching'}|{type: 'path'|'ended', path: string}|{type: 'request', action: string}|
 *   {type: 'closed', reason: string}|{type: 'decoder-replies', replies: Array<{error: string, data?: *}>}|
 *   {type: 'choice', id: string, choice: string}|{type: 'queued', count: number}} RelayEvent
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
 * @typedef {{type: 'play', target: string, title: string, start?: string, headers?: Array<string>,
 *   mpvPath?: string, fullscreen?: boolean, newWindow?: boolean, paused?: boolean, window?: string, queue?: boolean,
 *   subtitles?: Array<{label: string, srt: string}>, hls?: {files: Array<{name: string, text: string}>}}} PlayMessage
 */

/**
 * One that does not fit is left out, and the stream still goes; added last, so the rest counts.
 * @param {PlayMessage} message
 * @param {*} subtitles
 */
function addSubtitles(message, subtitles) {
  if (!Array.isArray(subtitles)) {
    return;
  }
  /** @param {string} label */
  const leftOut = (label) => console.warn(`A subtitle track (${label || 'no label'}) is too large to send to mpv, left out`);
  const candidates = subtitles
      .filter((s) => s && typeof s.srt === 'string' && s.srt.trim())
      .map((s) => ({label: typeof s.label === 'string' ? cutText(s.label, 100) : '', srt: s.srt}))
      .filter((s) => {
        if (s.srt.length > MaxSubtitleChars) leftOut(s.label);
        return s.srt.length <= MaxSubtitleChars;
      })
      .slice(0, 8);
  /** @type {Array<{label: string, srt: string}>} */
  const fitting = [];
  message.subtitles = fitting;
  for (const subtitle of candidates) {
    fitting.push(subtitle);
    if (messageBytes(message) > HostMaxMessageBytes) {
      fitting.pop();
      leftOut(subtitle.label);
    }
  }
  if (fitting.length === 0) {
    delete message.subtitles;
  }
}

/**
 * @typedef {{url: string, headers?: Array<{name: string, value: string}>, contentType?: string,
 *   pageUrl?: string, pageTitle?: string, extras: {startTime?: number, private?: boolean,
 *   subtitles?: Array<{label: string, srt: string}>,
 *   qualities?: Array<{url: string, label: string, height: number}>,
 *   hls?: {files: Array<{name: string, text: string}>}, window?: string, newWindow?: boolean,
 *   paused?: boolean, queue?: boolean}}} MpvStream
 */

/**
 * window: the helper's id of the mpv it played in ('' for its own pipe's; none for a stream the tab sent already);
 * closed: the window named was gone, and nothing was started. hostOutdated: the helper is older than
 * RequiredHostVersion, and no stream was sent. dropped: not sent, no longer wanted when its turn came.
 * @typedef {{ok: boolean, error?: string, noHost?: boolean, hostOutdated?: boolean, focus?: string,
 *   foreground?: string, reused?: boolean, local?: string, window?: string, closed?: boolean, dropped?: boolean}} StreamResult
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
    // The last answer's hostVersion, 0 for an answer without one; null until one came. One host serves the whole
    // browser, so it is kept here.
    /** @type {?number} */
    this.hostVersion = null;
    /** @type {Promise<*>} */
    this.lastSend = Promise.resolve();
    // One per mpv window, by the helper's id ('' for the one on its own pipe).
    /** @type {Map<string, import('./MpvRelayWatch.mjs').MpvWatcher>} */
    this.watchers = new Map();
  }

  /**
   * Whether the last answer came from a helper older than RequiredHostVersion (none yet: no).
   * @return {boolean}
   */
  get hostOutdated() {
    return this.hostVersion !== null && this.hostVersion < RequiredHostVersion;
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
          this.hostVersion = MpvBackend.versionOf(response);
          resolve({response});
        });
      } catch (e) {
        resolve({error: String(e)});
      }
    });
  }

  /**
   * A helper installed again meanwhile is noticed at its next answer.
   * @param {*} response
   * @return {number} 0 for an answer without a version (a helper from before versions).
   */
  static versionOf(response) {
    const version = response && typeof response === 'object' ? response.hostVersion : undefined;
    return Number.isInteger(version) && version > 0 ? version : 0;
  }

  /**
   * @param {*} response
   * @return {boolean}
   */
  static isHostOutdated(response) {
    return MpvBackend.versionOf(response) < RequiredHostVersion;
  }

  /**
   * What a send answers while the helper is outdated: the options page's words, with what to run.
   * @return {{ok: false, hostOutdated: true, error: string}}
   */
  static outdatedResult() {
    const windows = EnvUtils.isWindows();
    const error = globalThis.chrome?.i18n?.getMessage(windows ? 'options_mpv_test_outdated' : 'options_mpv_test_outdated_unix');
    return {ok: false, hostOutdated: true, error: error || (windows ? OutdatedError : OutdatedUnixError)};
  }

  /**
   * null when the helper is one this extension speaks to; else what a send answers. A ping until a helper answered as
   * current, and again while it answers as outdated: it may have been updated meanwhile.
   * @return {Promise<?StreamResult>}
   */
  async checkHost() {
    if (this.hostVersion !== null && !this.hostOutdated) return null;
    const answer = await this.ask({type: 'ping'});
    if (!('response' in answer)) return this.streamResult(answer);
    return this.hostOutdated ? MpvBackend.outdatedResult() : null;
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
   * Half a surrogate pair cannot be percent-encoded (pageFragmentFor throws on it): no page then.
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
   * Sends a stream to mpv, as a play message.
   * @param {string} url
   * @param {import('./TabTracker.mjs').TabHolder|null} [tab]
   * @param {Array<{name: string, value: string}>} [headers]
   * @param {string} [contentType]
   * @param {string} [pageUrl]
   * @param {string} [pageTitle]
   * @param {MpvStream['extras']} [extras] - window: the helper's id of the open mpv to play in.
   * @param {?(() => boolean)} [wanted] - Asked again when its turn comes: false drops it (its page or MPV went).
   * @return {Promise<StreamResult>}
   */
  openStream(url, tab, headers, contentType, pageUrl, pageTitle, extras = {}, wanted = null) {
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
        return Promise.resolve({ok: true});
      }
      tab.mpvSentUrls.add(url);
    }

    /** @type {MpvStream} */
    const stream = {url, headers, contentType, pageUrl, pageTitle, extras: extras || {}};
    // Never a rejection: a throw while the message was built is a send that did not go.
    const sent = this.sendStream(stream, wanted).catch((e) => ({ok: false, error: String(e)})).then((result) => {
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
   * One at a time: two at once with no mpv running each started an mpv on the same pipe name. One that waited behind
   * another is dropped when it is no longer wanted.
   * @param {MpvStream} stream
   * @param {?(() => boolean)} [wanted]
   * @return {Promise<StreamResult>}
   */
  sendStream(stream, wanted = null) {
    const mine = this.lastSend.then(() => (wanted && !wanted() ?
      /** @type {StreamResult} */ ({ok: false, dropped: true}) : this.sendStreamNow(stream)));
    this.lastSend = mine.catch(() => {});
    return mine;
  }

  /**
   * @param {MpvStream} stream
   * @return {Promise<StreamResult>}
   */
  async sendStreamNow(stream) {
    const refused = await this.checkHost();
    if (refused) {
      return refused;
    }
    const play = await this.playMessage(stream);
    if (!play.message) {
      return {ok: false, error: play.error || TooLongError};
    }
    return this.streamResult(await this.ask(play.message));
  }

  /**
   * @param {HostAnswer} answer
   * @return {StreamResult}
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
    // An older helper put back meanwhile: whatever it made of the message, it is not one this extension speaks to.
    if (this.hostOutdated) {
      return MpvBackend.outdatedResult();
    }
    const response = answer.response;
    if (response && response.ok === false) {
      return {ok: false, error: response.error || 'mpv host error', ...(response.closed === true ? {closed: true} : {})};
    }
    // The playlist file a stream's playlists were written to: mpv's path for it.
    const local = response && typeof response.local === 'string' ? {local: response.local} : {};
    const window = response && typeof response === 'object' && 'window' in response ? windowOf(response.window) : null;
    return {ok: true, ...MpvBackend.focusOf(response), ...local, ...(window !== null ? {window} : {})};
  }

  /**
   * mpv's target and title built here (MpvTarget.mjs), within the helper's limits, which refuse the whole message.
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
    } else if (extras.newWindow) {
      message.newWindow = true;
      if (extras.paused) {
        // It waits minimized: the helper refuses a paused fullscreen one.
        message.paused = true;
        delete message.fullscreen;
      }
    } else {
      if (extras.window) {
        message.window = extras.window;
      }
      if (extras.queue) {
        // Behind what that open window plays (mpv-config's queue): it is not made fullscreen for it.
        message.queue = true;
        delete message.fullscreen;
      }
    }

    if (extras.hls) {
      message.hls = extras.hls;
    }

    addSubtitles(message, extras.subtitles);

    return messageBytes(message) > HostMaxMessageBytes ? {error: TooLongError} : {message};
  }

  /**
   * Brings an open mpv window to the front.
   * @param {string} window - The helper's id of the window, '' for the one on its own pipe.
   * @return {Promise<void>}
   */
  async raise(window) {
    await this.ask(window ? {type: 'raise', window} : {type: 'raise'});
  }

  /**
   * One per mpv window; while its port is open Firefox keeps the background running (docs/notes/mpv.md).
   * @param {(message: MpvWatchEvent) => void} onEvent
   * @param {string} [window] - The helper's id of the window, '' for the one on its own pipe.
   * @return {import('./MpvRelayWatch.mjs').MpvWatcher}
   */
  watch(onEvent, window = '') {
    this.watchers.get(window)?.stop();
    /** @type {?import('./MpvRelayWatch.mjs').MpvWatcher} */
    let current = null;
    const forget = () => {
      if (this.watchers.get(window) === handle) this.watchers.delete(window);
    };
    /** @type {import('./MpvRelayWatch.mjs').MpvWatcher} */
    const handle = {
      notify: (title, detail = '', seconds) => current?.notify(title, detail, seconds),
      hide: () => current?.hide(),
      state: (state) => current?.state(state),
      ask: (commands, timeoutMs) => current ? current.ask(commands, timeoutMs) :
        Promise.resolve(commands.map(() => ({error: 'no watch'}))),
      command: (command) => current?.command(command),
      stop: () => {
        forget();
        current?.stop();
      },
    };
    /** @param {MpvWatchEvent} event */
    const emit = (event) => {
      if (event.type === 'closed') forget();
      onEvent(event);
    };
    this.watchers.set(window, handle);
    /** @type {*} */
    let port;
    try {
      port = chrome.runtime.connectNative(NativeHostName);
    } catch (e) {
      emit({type: 'closed', reason: String(e)});
      return handle;
    }
    current = relayWatch(port, (/** @type {RelayEvent} */ event) => {
      if (event.type === 'decoder-replies') {
        emit({type: 'decoder', decoder: MpvBackend.readDecoder(MpvBackend.decoderFromReplies(event.replies))});
      } else {
        emit(event);
      }
    }, {decoderProperties: DecoderProperties, window});
    return handle;
  }

  /**
   * Read-only: mpv.conf stays the only authority on hardware decoding. Nothing is asked of an outdated helper.
   * @param {number} [waitMs]
   * @return {Promise<{ok: boolean, running?: boolean, decoder?: ?MpvDecoder, error?: string,
   *   hostOutdated?: boolean}>}
   */
  async decoderStatus(waitMs = 0) {
    if (this.hostOutdated) {
      return MpvBackend.outdatedResult();
    }
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), MaxStatusWaitMs);
    const commands = DecoderProperties.map((name) => ['get_property', name]);
    const started = Date.now();
    for (;;) {
      const answer = await this.ask({type: 'ipc', commands});
      if (!('response' in answer)) {
        return {ok: false, error: answer.error};
      }
      if (this.hostOutdated) {
        return MpvBackend.outdatedResult();
      }
      const response = answer.response;
      if (!response || typeof response !== 'object') {
        return {ok: false, error: 'mpv host error'};
      }
      /** @type {?Object} */
      let decoder = null;
      if (response.ok !== true) {
        // A command the helper's allowlist refused: no question to ask again.
        if (response.error === 'refused') {
          return {ok: false, error: 'the mpv host refused the question'};
        }
        // No pipe: no mpv of ours. A busy one runs, and may answer next time.
        if (response.busy !== true && response.error !== 'mpv did not answer') {
          return {ok: true, running: false, decoder: null};
        }
      } else {
        decoder = MpvBackend.decoderFromReplies(response.replies);
      }
      if (decoder || Date.now() - started + StatusPollMs > wait) {
        return {ok: true, running: true, decoder: MpvBackend.readDecoder(decoder)};
      }
      await new Promise((resolve) => setTimeout(resolve, StatusPollMs));
    }
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
