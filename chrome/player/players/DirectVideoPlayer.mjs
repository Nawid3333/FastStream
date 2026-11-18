// @ts-check
import {DefaultPlayerEvents} from '../enums/DefaultPlayerEvents.mjs';
import {MessageTypes} from '../enums/MessageTypes.mjs';
import {EmitterRelay, EventEmitter} from '../modules/eventemitter.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {RequestUtils} from '../utils/RequestUtils.mjs';
import {URLUtils} from '../utils/URLUtils.mjs';
import {VideoUtils} from '../utils/VideoUtils.mjs';

// Headers a rule on the element's requests must not set: they describe the request, not the site.
const NOT_FOR_THE_ELEMENT = new Set(['range', 'if-range', 'accept-encoding', 'host', 'connection', 'content-length',
  'transfer-encoding', 'te', 'upgrade', 'keep-alive', 'expect', 'trailer']);

/**
 * The background's header commands (SET_HEADERS) for the element's requests: false removes a header.
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

// Firefox's player asks for ranges later (a seek, a long pause, an index at the end): the rule is renewed.
export const HEADER_RULE_LIFETIME_MS = 60000;
export const HEADER_RULE_RENEW_MS = 10000;

// Most direct videos are MP4: any other extension saves as .mp4.
const MEDIA_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'ogg', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'weba', 'oga']);

/**
 * @param {{identifier?: string, url?: string}|null|undefined} source
 * @return {string}
 */
export function saveExtension(source) {
  const extension = URLUtils.get_url_extension(source?.identifier || source?.url || '');
  return MEDIA_EXTENSIONS.has(extension) ? extension : 'mp4';
}

export default class DirectVideoPlayer extends EventEmitter {
  /**
   * @param {import('../FastStreamClient.mjs').FastStreamClient} client
   * @param {{isPreview?: boolean, isAudioOnly?: boolean}} [config]
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
      // As the element reports a source it cannot load: an ERROR after this call.
      setTimeout(() => this.emit(DefaultPlayerEvents.ERROR, 'The source is not an http(s), blob, data or file URL'));
      return;
    }
    // Firefox's loader sends the page's headers only through the background's rule, renewed while this is the source.
    const hasHeaders = await this.setHeaderRule(source, url);
    // Destroyed, or given another source, while the rule was set.
    if (this.source !== source || !this.video) return;
    if (hasHeaders) {
      // The same source set twice meanwhile: one renewal, not two.
      this.stopHeaderRenewal();
      this.headerRenewal = setInterval(() => this.setHeaderRule(source, url), HEADER_RULE_RENEW_MS);
    }
    this.video.src = url;
  }

  stopHeaderRenewal() {
    if (this.headerRenewal !== null) clearInterval(this.headerRenewal);
    this.headerRenewal = null;
  }

  /**
   * @param {?import('../VideoSource.mjs').VideoSource} source
   * @param {string} url
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
        fetchHeaders[header] = /** @type {string} */ (regularHeaders[header]);
      }

      if (customHeaderCommands.length && EnvUtils.isExtension()) {
        await chrome.runtime.sendMessage({
          type: MessageTypes.SET_HEADERS,
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

  /** @param {string|number|null} levelID */
  setCurrentAudioLevelID(levelID) {
  }
}
