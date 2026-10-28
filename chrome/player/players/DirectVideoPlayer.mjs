// @ts-check
import {DefaultPlayerEvents} from '../enums/DefaultPlayerEvents.mjs';
import {MessageTypes} from '../enums/MessageTypes.mjs';
import {EmitterRelay, EventEmitter} from '../modules/eventemitter.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {RequestUtils} from '../utils/RequestUtils.mjs';
import {URLUtils} from '../utils/URLUtils.mjs';
import {VideoUtils} from '../utils/VideoUtils.mjs';

// Headers a rule on the element's requests must not set: Firefox's player asks for its own
// ranges, and these describe the connection or the request itself, not the site's wishes.
const NOT_FOR_THE_ELEMENT = new Set(['range', 'if-range', 'accept-encoding', 'host', 'connection', 'content-length',
  'transfer-encoding', 'te', 'upgrade', 'keep-alive', 'expect', 'trailer']);

/**
 * The background's header commands (SET_HEADERS) that give the element's requests a source's
 * headers: the value false removes a header.
 * @param {Object<string, string|boolean>|null|undefined} headers
 * @return {FSHeaderCommand[]}
 */
export function elementHeaderCommands(headers) {
  /** @type {FSHeaderCommand[]} */
  const commands = [];
  for (const header in headers || {}) {
    if (!Object.hasOwn(/** @type {Object<string, string|boolean>} */ (headers), header)) continue;
    const name = header.toLowerCase();
    if (NOT_FOR_THE_ELEMENT.has(name) || name.startsWith('proxy-')) continue;
    const value = /** @type {Object<string, string|boolean>} */ (headers)[header];
    commands.push(value === false ? {operation: 'remove', header} : {operation: 'set', header, value: String(value)});
  }
  return commands;
}

// How long the background keeps the element's header rule, and how often the player renews
// it while it has the source. Firefox's player asks for ranges when it needs them: on a
// seek, after a long pause, for a Matroska file's index at its end. A request's rule lives
// 5 s, and those went out without the page's Referer or cookie: a hoster's server answered
// the first one after 5 s with a redirect to a decoy, and the source was reloaded. The most
// the background grants (MAX_RULE_LIFETIME_MS): Firefox may hold a hidden tab's timers back,
// and a renewal up to 50 s late still comes before the rule ends.
export const HEADER_RULE_LIFETIME_MS = 60000;
export const HEADER_RULE_RENEW_MS = 10000;

// What a direct video can be saved as. A URL without an extension (".../watch?v=1") was saved
// as .webm, and one ending in .php as .php: most direct videos are MP4.
const MEDIA_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'ogg', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'weba', 'oga']);

/**
 * The file extension to save a direct source as.
 * @param {{identifier?: string, url?: string}|null|undefined} source - The player's source (its
 *   file name or URL), if it has one.
 * @return {string}
 */
export function saveExtension(source) {
  const extension = URLUtils.get_url_extension(source?.identifier || source?.url || '');
  return MEDIA_EXTENSIONS.has(extension) ? extension : 'mp4';
}

export default class DirectVideoPlayer extends EventEmitter {
  /**
   * @param {import('../FastStreamClient.mjs').FastStreamClient} client
   * @param {{isPreview?: boolean, isAudioOnly?: boolean, isAnalyzer?: boolean}} [config] - What the
   *   player is for (PlayerLoader.createPlayer's callers).
   */
  constructor(client, config) {
    super();
    this.client = client;

    this.video = /** @type {HTMLVideoElement} */ (document.createElement(config?.isAudioOnly ? 'audio' : 'video'));
    /** @type {?ReturnType<typeof setInterval>} */
    this.headerRenewal = null;
  }

  load() {

  }

  getClient() {
    return this.client;
  }


  async setup() {
    const preEvents = new EventEmitter();
    const emitterRelay = new EmitterRelay([preEvents, this]);
    VideoUtils.addPassthroughEventListenersToVideo(this.video, emitterRelay);
  }


  getVideo() {
    return this.video;
  }

  /** @param {import('../VideoSource.mjs').VideoSource} source */
  async setSource(source) {
    this.source = source;
    this.stopHeaderRenewal();
    const url = URLUtils.playableUrl(source.url, document.baseURI);
    if (!url) {
      // As the media element reports a source it cannot load: an ERROR after this call,
      // which the client answers with the next source or the load error.
      setTimeout(() => this.emit(DefaultPlayerEvents.ERROR, 'The source is not an http(s), blob, data or file URL'));
      return;
    }
    // Firefox's own loader sends the page's headers only if the background's rule for this URL
    // sets them (the rule the MP4 player's requests get through FetchLoader): the Referer or
    // cookie a site asks for, so a source handed over from the MP4 player (playDirectly) plays.
    // Renewed while this is the source: the element's later requests need it as much.
    if (await this.setHeaderRule(source, url) && this.source === source && this.video) {
      this.headerRenewal = setInterval(() => this.setHeaderRule(source, url), HEADER_RULE_RENEW_MS);
    }
    this.video.src = url;
  }

  stopHeaderRenewal() {
    if (this.headerRenewal !== null) clearInterval(this.headerRenewal);
    this.headerRenewal = null;
  }

  /**
   * Asks the background to set the source's headers on the requests for its URL.
   * @param {?import('../VideoSource.mjs').VideoSource} source
   * @param {string} url - The URL the element loads.
   * @return {Promise<boolean>} Whether the source has headers to set.
   */
  async setHeaderRule(source, url) {
    if (!EnvUtils.isExtension() || !/^https?:/i.test(url)) return false;
    const commands = elementHeaderCommands(source?.headers);
    if (!commands.length) return false;
    try {
      await chrome.runtime.sendMessage({type: MessageTypes.SET_HEADERS, url, commands, lifetimeMs: HEADER_RULE_LIFETIME_MS});
    } catch (e) {
      // Without the rule it plays as it did before: without the headers.
      console.warn('Could not set the headers of the source', e);
    }
    return true;
  }

  getSource() {
    return this.source;
  }

  get buffered() {
    return this.video.buffered;
  }

  async play() {
    return this.video.play();
  }

  async pause() {
    return this.video.pause();
  }

  destroy() {
    this.stopHeaderRenewal();
    VideoUtils.destroyVideo(this.video);
    this.video = /** @type {any} */ (null);

    this.emit(DefaultPlayerEvents.DESTROYED);
  }


  set currentTime(value) {
    this.video.currentTime = value;
  }

  get currentTime() {
    return this.video.currentTime;
  }

  get readyState() {
    return this.video.readyState;
  }

  get paused() {
    return this.video.paused;
  }

  get levels() {
    return null;
  }

  get duration() {
    return this.video.duration;
  }

  get currentFragment() {
    return null;
  }

  canSave() {
    if (!this.source?.url) {
      return {
        cantSave: true,
        canSave: false,
        isComplete: true,
      };
    }

    return {
      canSave: true,
      canStream: true,
      isComplete: true,
      extension: saveExtension(this.source),
    };
  }

  /**
   * Downloads the file again into the stream SaveManager opened.
   * @param {{filestream: WritableStream<Uint8Array>, partialSave?: boolean,
   *   registerCancel?: (cancel: () => void) => void, onProgress?: (progress: number) => void}} options
   */
  async saveVideo(options) {
    const controller = new AbortController();
    if (options?.registerCancel) {
      options.registerCancel(() => {
        controller.abort();
      });
    }

    /** @type {Object<string, string>} */
    const fetchHeaders = {};
    const headers = this.source?.headers;
    if (headers) {
      const {customHeaderCommands, regularHeaders} = RequestUtils.splitSpecialHeaders(headers);
      for (const header in regularHeaders) {
        if (!Object.hasOwn(regularHeaders, header)) continue;
        // Its text: only special headers are false (removed).
        fetchHeaders[header] = /** @type {string} */ (regularHeaders[header]);
      }

      if (customHeaderCommands.length && EnvUtils.isExtension()) {
        await chrome.runtime.sendMessage({
          type: MessageTypes.SET_HEADERS,
          // Set: a video is saved once it has its source.
          url: /** @type {import('../VideoSource.mjs').VideoSource} */ (this.source).url,
          commands: customHeaderCommands,
        });
      }
    }

    let response;
    try {
      response = await fetch(/** @type {import('../VideoSource.mjs').VideoSource} */ (this.source).url, {
        headers: fetchHeaders,
        credentials: 'same-origin',
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error('Cancelled');
      }
      throw e;
    }

    if (!response.ok) {
      throw new Error('Bad status code: ' + response.status);
    }

    const writer = options.filestream.getWriter();
    // Without the header, parseInt reads null as NaN, and the total is 0.
    const total = parseInt(/** @type {string} */ (response.headers.get('content-length')), 10) || 0;
    let loaded = 0;

    try {
      // A GET answer has a body.
      const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        await writer.write(value);
        loaded += value.byteLength;
        if (options.onProgress && total) {
          options.onProgress(loaded / total);
        }
      }
      await writer.close();
    } catch (e) {
      await writer.abort();
      if (controller.signal.aborted) {
        throw new Error('Cancelled');
      }
      throw e;
    }

    return {
      extension: saveExtension(this.source),
      blob: null,
    };
  }

  get volume() {
    return this.video.volume;
  }

  set volume(value) {
    this.video.volume = value;
    if (value === 0) this.video.muted = true;
    else this.video.muted = false;
  }

  get playbackRate() {
    return this.video.playbackRate;
  }

  set playbackRate(value) {
    this.video.playbackRate = value;
  }

  getVideoLevels() {
    return null;
  }

  getAudioLevels() {
    return null;
  }

  getCurrentVideoLevelID() {
    return null;
  }

  getCurrentAudioLevelID() {
    return null;
  }

  /** @param {string|number|null} levelID - A direct video has one level: nothing to change. */
  setCurrentVideoLevelID(levelID) {
  }

  /** @param {string|number|null} levelID - As setCurrentVideoLevelID. */
  setCurrentAudioLevelID(levelID) {
  }
}
