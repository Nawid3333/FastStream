import {DefaultPlayerEvents} from '../enums/DefaultPlayerEvents.mjs';
import {MessageTypes} from '../enums/MessageTypes.mjs';
import {EmitterRelay, EventEmitter} from '../modules/eventemitter.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {RequestUtils} from '../utils/RequestUtils.mjs';
import {URLUtils} from '../utils/URLUtils.mjs';
import {VideoUtils} from '../utils/VideoUtils.mjs';

export default class DirectVideoPlayer extends EventEmitter {
  constructor(client, config) {
    super();
    this.client = client;

    this.video = document.createElement(config?.isAudioOnly ? 'audio' : 'video');
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

  async setSource(source) {
    this.source = source;
    this.video.src = source.url;
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
    VideoUtils.destroyVideo(this.video);
    this.video = null;

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
      extension: URLUtils.get_url_extension(this.source.identifier || this.source.url) || 'webm',
    };
  }

  async saveVideo(options) {
    const controller = new AbortController();
    if (options?.registerCancel) {
      options.registerCancel(() => {
        controller.abort();
      });
    }

    const fetchHeaders = {};
    const headers = this.source?.headers;
    if (headers) {
      const {customHeaderCommands, regularHeaders} = RequestUtils.splitSpecialHeaders(headers);
      for (const header in regularHeaders) {
        if (!Object.hasOwn(regularHeaders, header)) continue;
        fetchHeaders[header] = regularHeaders[header];
      }

      if (customHeaderCommands.length && EnvUtils.isExtension()) {
        await chrome.runtime.sendMessage({
          type: MessageTypes.SET_HEADERS,
          url: this.source.url,
          commands: customHeaderCommands,
        });
      }
    }

    let response;
    try {
      response = await fetch(this.source.url, {
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
    const total = parseInt(response.headers.get('content-length'), 10) || 0;
    let loaded = 0;

    try {
      const reader = response.body.getReader();
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
      extension: URLUtils.get_url_extension(this.source?.identifier || this.source?.url) || 'webm',
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

  setCurrentVideoLevelID(levelID) {
  }

  setCurrentAudioLevelID(levelID) {
  }
}
