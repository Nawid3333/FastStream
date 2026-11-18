// @ts-check
import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {DownloadStatus} from '../../enums/DownloadStatus.mjs';
import {ReferenceTypes} from '../../enums/ReferenceTypes.mjs';
import {MediaPlayer} from '../../modules/dash.mjs';
import {EmitterRelay, EventEmitter} from '../../modules/eventemitter.mjs';
import {Utils} from '../../utils/Utils.mjs';
import {VideoUtils} from '../../utils/VideoUtils.mjs';
import {DashFragment} from './DashFragment.mjs';
import {DashFragmentRequester} from './DashFragmentRequester.mjs';
import {stuckAfterStart} from './DashErrors.mjs';
import {DASHLoaderFactory} from './DashLoader.mjs';
import {DashTrackUtils} from './DashTrackUtils.mjs';
import {audioProbeFor, describeDashRepresentation, probeDecoding, videoProbeFor} from '../DecodingCapabilities.mjs';
import {SaveFragmentFetcher, savedEntry} from '../SaveFragmentFetcher.mjs';

/** @typedef {import('../../modules/dash.mjs').Representation} Representation */

export default class DashPlayer extends EventEmitter {
  /**
   * @param {import('../../FastStreamClient.mjs').FastStreamClient} client
   * @param {{isPreview?: boolean, isAudioOnly?: boolean}} [config]
   */
  constructor(client, config) {
    super();
    this.client = client;
    this.isPreview = config?.isPreview || false;
    this.isAudioOnly = config?.isAudioOnly || false;
    this.defaultQuality = client.options.defaultQuality || 'Auto';
    this.video = /** @type {HTMLVideoElement} */ (document.createElement(this.isAudioOnly ? 'audio' : 'video'));

    this.fragmentRequester = new DashFragmentRequester(this);
    // Download-manager keys of the manifests loaded: a second load of one is a live refresh.
    this.loadedManifests = new Set();
    this.representationDetails = new Map();
  }

  /**
   * Never removes anything: answers true, and a probe gives up after PROBE_TIMEOUT_MS.
   * @param {Representation} rep
   * @return {Promise<boolean>}
   */
  async probeRepresentation(rep) {
    try {
      const info = describeDashRepresentation(rep);
      if (!info.type || rep?.id === undefined || rep?.id === null) {
        return true;
      }
      const probe = info.type === 'video' ? videoProbeFor(info) : audioProbeFor(info);
      this.representationDetails.set(`${info.type}-${rep.id}`, {
        probe,
        frameRate: info.frameRate,
        videoRange: info.videoRange,
      });
      await probeDecoding(probe);
    } catch (e) {
      console.warn('[DashPlayer] probing a representation failed', e);
    }
    return true;
  }

  async setup() {
    /** @type {import('../../modules/dash.mjs').MediaPlayerClass} */
    // eslint-disable-next-line new-cap
    this.dash = MediaPlayer().create();

    // A codec that fails to decode twice is left out of the pick, and the client loads the source again.
    if (!this.isPreview) {
      this.videoErrorListener = () => this.onVideoError();
      this.video.addEventListener('error', this.videoErrorListener);
    }

    const preEvents = new EventEmitter();
    const emitterRelay = new EmitterRelay([preEvents, this]);
    VideoUtils.addPassthroughEventListenersToVideo(this.video, emitterRelay);

    // dash.js retries nothing itself: the download manager does, and DashLoader counts failures.
    /** @type {Object<string, number>} */
    const retryAttempts = {};
    for (const type of Object.keys(this.dash.getSettings().streaming?.retryAttempts || {})) {
      if (type !== 'lowLatencyMultiplyFactor') retryAttempts[type] = 0;
    }

    const newSettings = {
      streaming: {
        retryAttempts,
        abr: {
          autoSwitchBitrate: {audio: false, video: false},
        },
        buffer: {
          bufferToKeep: 10,
          bufferTimeAtTopQuality: 10,
          bufferTimeAtTopQualityLongForm: 10,
          bufferPruningInterval: 1,

        },
        text: {
          defaultEnabled: false,
        },
        capabilities: {
          useMediaCapabilitiesApi: false,
        },
      },
      errors: {
        recoverAttempts: {
          // The seek preview has no client to rebuild it: dash.js's own reset is all it has.
          mediaErrorDecode: this.isPreview ? 5 : 1000000,
        },
      },
    };

    this.dash.updateSettings(newSettings);
    this.dash.registerCustomCapabilitiesFilter((rep) => this.probeRepresentation(rep));

    this.dash.setCustomInitialTrackSelectionFunction((tracks) => {
      const type = tracks[0]?.type;
      if (type === 'video') {
        const levels = DashTrackUtils.getVideoLevelList(tracks, this.representationDetails);
        const chosen = this.client.getLevelManager().pickVideoLevel(Array.from(levels.values()));
        if (chosen) {
          return [chosen.track];
        } else {
          console.warn('No matching video track found for chosen level, falling back to all tracks', tracks, chosen);
          return tracks;
        }
      } else if (type === 'audio') {
        const levels = DashTrackUtils.getAudioLevelList(tracks, this.representationDetails);
        const chosen = this.client.getLevelManager().pickAudioLevel(Array.from(levels.values()));
        if (chosen) {
          return [chosen.track];
        } else {
          console.warn('No matching audio track found for chosen level, falling back to all tracks', tracks, chosen);
          return tracks;
        }
      }
      return tracks;
    });

    this.dash.setCustomBitrateSelectionFunction((representations, bitrate, mediaInfo) => {
      const type = mediaInfo.type;
      if (type === 'video') {
        const levels = DashTrackUtils.getVideoLevelList([mediaInfo], this.representationDetails);
        const chosen = this.client.getLevelManager().pickVideoLevel(Array.from(levels.values()));
        const result = representations.filter((rep) => {
          return chosen && DashTrackUtils.getLevelFromRepresentation(rep) === chosen.id;
        });
        if (result.length === 0) {
          return representations;
        } else {
          return result;
        }
      } else if (type === 'audio') {
        const levels = DashTrackUtils.getAudioLevelList([mediaInfo], this.representationDetails);
        const chosen = this.client.getLevelManager().pickAudioLevel(Array.from(levels.values()));
        const result = representations.filter((rep) => {
          return chosen && DashTrackUtils.getLevelFromRepresentation(rep) === chosen.id;
        });
        if (result.length === 0) {
          console.warn('No matching audio representation found for chosen level, falling back to all representations', representations, chosen);
          return representations;
        } else {
          return result;
        }
      }
      return representations;
    });

    this.dash.on('needkey', (e) => {
      this.emit(DefaultPlayerEvents.NEED_KEY);
    });

    let initAlready = false;

    const initialize = () => {
      if (initAlready) return;
      initAlready = true;
      this.emit(DefaultPlayerEvents.MANIFEST_PARSED);
    };

    this.dash.on('initialInit', (a) => {
      this.extractAllFragments();
      initialize();
    });

    // A manifest dash.js could not load or parse is reported only here: <video> gets no error.
    /** @type {number[]} */
    const manifestErrors = [
      MediaPlayer.errors.MANIFEST_LOADER_PARSING_FAILURE_ERROR_CODE,
      MediaPlayer.errors.MANIFEST_LOADER_LOADING_FAILURE_ERROR_CODE,
      MediaPlayer.errors.DOWNLOAD_ERROR_ID_MANIFEST_CODE,
    ];
    const stuck = stuckAfterStart(MediaPlayer.errors);
    const stuckLive = stuckAfterStart(MediaPlayer.errors, true);
    this.dash.on('error', (e) => {
      // A string error (dash.js has some) has no code: undefined, which no list holds.
      const code = /** @type {{code: number}} */ (e.error)?.code;
      let live = false;
      try {
        live = initAlready && this.dash.isDynamic();
      } catch (err) {
        // Not known yet: as for a video on demand.
      }
      if (initAlready ? (live ? stuckLive : stuck).has(code) : (manifestErrors.includes(code) || stuck.has(code))) {
        this.emit(DefaultPlayerEvents.ERROR, e);
      }
    });

    // The event patches/dashjs@*.patch adds.
    this.dash.on('REPRESENTATION_UPDATED', (/** @type {import('../../modules/dash.mjs').MediaPlayerEvent & {representation: import('../../modules/dash.mjs').Representation}} */ a) => {
      const rep = a.representation;
      this.extractFragments(rep);
    });

    this.dash.on('dataUpdateCompleted', (a) => {
      this.extractAllFragments();
    });

    this.dash.on('currentTrackChanged', (a) => {
      this.extractAllFragments();
    });

    // eslint-disable-next-line new-cap
    this.dash.extend('XHRLoader', DASHLoaderFactory(this), false);
  }

  extractAllFragments() {
    const processors = /** @type {import('../../modules/dash.mjs').DashStream} */ (this.dash.getStreamController().getActiveStream()).getStreamProcessors();
    processors.forEach((processor) => {
      const mediaInfo = processor.getMediaInfo();
      mediaInfo.representations.forEach((rep) => {
        rep.processor = processor;
        this.extractFragments(rep);
      });
    });
  }

  /** @param {Representation} rep */
  extractFragments(rep) {
    const processor = rep.processor;
    if (!processor) {
      return;
    }
    const mediaInfo = processor.getMediaInfo();
    const segmentsController = processor.getSegmentsController();
    const dashHandler = processor.getDashHandler();
    if (rep.hasInitialization()) {
      const init = dashHandler.getInitRequest(mediaInfo, rep);
      if (init) {
        init.level = DashTrackUtils.getLevelFromRepresentation(rep);
        init.index = -1;
        init.startTime = init.duration = 0;
        if (!this.client.getFragment(init.level, -1)) {
          this.client.makeFragment(init.level, -1, new DashFragment(init));
        }
      }
    }
    if (rep.hasSegments() || rep.segments) {
      const segments = /** @type {Array<import('../../modules/dash.mjs').Segment>} */ (segmentsController.getAllSegments(rep)).map((segment) => {
        return dashHandler._getRequestForSegment(mediaInfo, segment);
      });
      segments.forEach((request) => {
        if (!request) return;
        request.level = DashTrackUtils.getLevelFromRepresentation(rep);
        const fragment = new DashFragment(request);
        if (!this.client.getFragment(fragment.level, fragment.sn)) {
          this.client.makeFragment(fragment.level, fragment.sn, fragment);
        }
      });
    }
  }

  load() {

  }

  getClient() {
    return this.client;
  }

  getVideo() {
    return this.video;
  }

  /** @param {import('../../VideoSource.mjs').VideoSource} source */
  async setSource(source) {
    this.source = source;
    this.dash.initialize(this.video, this.source.url, false);
    // dash.js's initialize adds time.akamai.com as a time server: cleared (docs/privacy-policy.md).
    this.dash.clearDefaultUTCTimingSources();
  }

  getSource() {
    return this.source;
  }

  /**
   * @param {DashFragment} fragment
   * @param {number} priority - Higher first (a save's -1).
   * @return {Promise<void>}
   */
  downloadFragment(fragment, priority) {
    return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      this.fragmentRequester.requestFragment(fragment, {
        skipProcess: true,
        onProgress: (e) => {

        },
        onSuccess: (e) => {
          resolve();
        },
        onFail: (e) => {
          reject(new Error('Failed to download fragment'));
        },
        onAbort: (e) => {
          reject(new Error('Aborted download'));
        },
      }, null, priority);
    }));
  }

  async play() {
    return this.video.play();
  }

  async pause() {
    return this.video.pause();
  }

  set currentTime(value) {
    this.video.currentTime = value;
  }

  destroy() {
    try {
      this.dash.destroy();
    } catch (e) {

    }
    this.dash = /** @type {any} */ (null);

    if (this.videoErrorListener) {
      this.video.removeEventListener('error', this.videoErrorListener);
      this.videoErrorListener = null;
    }
    VideoUtils.destroyVideo(this.video);
    this.video = /** @type {any} */ (null);

    this.emit(DefaultPlayerEvents.DESTROYED);
  }

  onVideoError() {
    if (!this.dash || this.video?.error?.code !== MediaError.MEDIA_ERR_DECODE) {
      return;
    }
    // An audio decoder's failure arrives as the same error: Firefox's message names the decoder.
    const message = String(this.video.error.message || '');
    if (/audio/i.test(message) && !/video/i.test(message)) {
      return;
    }
    // Runs before dash.js's own handler, while the failing level is still the current one.
    try {
      const level = this.getVideoLevels().get(this.getCurrentVideoLevelID());
      // A decoder Firefox could not even create (InitIPDL) is not made by a retry.
      const cannotStart = /InitIPDL/.test(message);
      const levelManager = this.client.getLevelManager();
      // Its codec was left out already and it still cannot start: dash.js would reset for ever.
      if (level && cannotStart && levelManager.isVideoCodecFailed(level.videoCodec)) {
        const another = Array.from(this.getVideoLevels().values())
            .some((other) => !levelManager.isVideoCodecFailed(other.videoCodec));
        if (another) {
          this.codecFailedForGood = true;
        } else {
          this.dash.updateSettings({errors: {recoverAttempts: {mediaErrorDecode: 0}}});
        }
      }
      if (level && levelManager.noteVideoDecodeFailure(level.videoCodec, cannotStart)) {
        console.warn('Video codec failed to decode, picking another:', level.videoCodec);
        this.codecFailedForGood = true;
      }
    } catch (e) {
      console.warn('Could not tell which codec failed to decode', e);
    }
  }

  /**
   * Whether a codec just failed for good: the element then never loads the new codec's metadata, a new player does.
   * @return {boolean}
   */
  takeCodecReload() {
    const reload = !!this.codecFailedForGood;
    this.codecFailedForGood = false;
    return reload;
  }

  getVideoLevels() {
    try {
      const tracks = this.dash.getTracksFor('video');
      return DashTrackUtils.getVideoLevelList(tracks, this.representationDetails);
    } catch (e) {
      console.warn(e);
      return new Map();
    }
  }

  getAudioLevels() {
    try {
      const tracks = this.dash.getTracksFor('audio');
      return DashTrackUtils.getAudioLevelList(tracks, this.representationDetails);
    } catch (e) {
      console.warn(e);
      return new Map();
    }
  }

  getCurrentVideoLevelID() {
    return DashTrackUtils.getCurrentLevel(this.dash, 'video');
  }

  /** @param {string|number|null} id - A level's; only a string names a DASH one. */
  setCurrentVideoLevelID(id) {
    if (typeof id !== 'string') return;
    try {
      this.dash.setRepresentationForTypeById('video', /** @type {{type: string, id: string}} */ (DashTrackUtils.deconstructLevel(id)).id);
    } catch (e) {
      console.warn(e);
    }
  }

  getCurrentAudioLevelID() {
    return DashTrackUtils.getCurrentLevel(this.dash, 'audio');
  }

  /** @param {string|number|null} id - A level's; only a string names a DASH one. */
  setCurrentAudioLevelID(id) {
    if (typeof id !== 'string') return;
    try {
      this.dash.setRepresentationForTypeById('audio', /** @type {{type: string, id: string}} */ (DashTrackUtils.deconstructLevel(id)).id, true);
    } catch (e) {
      console.warn(e);
    }
  }

  get duration() {
    return this.video.duration;
  }

  get currentFragment() {
    const frags = /** @type {Array<DashFragment>|undefined} */ (this.client.getFragments(this.getCurrentVideoLevelID()));
    if (!frags) return null;

    const time = this.currentTime;
    return frags.find((frag) => {
      if (!frag) return false;
      return time >= frag.start && time < frag.end;
    });
  }

  get currentAudioFragment() {
    const frags = /** @type {Array<DashFragment>|undefined} */ (this.client.getFragments(this.getCurrentAudioLevelID()));
    if (!frags) return null;

    const time = this.currentTime;
    return frags.find((frag) => {
      if (!frag) return false;
      return time >= frag.start && time < frag.end;
    });
  }

  canSave() {
    let frags = this.client.fragments;
    if (!frags || this.dash.getStreamController().getStreams().length > 1) {
      return {
        canSave: false,
        isComplete: false,
      };
    }

    let incomplete = false;
    for (let i = -1; i < frags.length; i++) {
      if (frags[i] && frags[i].status !== DownloadStatus.DOWNLOAD_COMPLETE) {
        incomplete = true;
        break;
      }
    }

    frags = this.client.audioFragments || [];
    for (let i = -1; i < frags.length; i++) {
      if (frags[i] && frags[i].status !== DownloadStatus.DOWNLOAD_COMPLETE) {
        incomplete = true;
        break;
      }
    }

    return {
      canSave: true,
      isComplete: !incomplete,
    };
  }

  /**
   * @param {{filestream?: WritableStream<Uint8Array>, partialSave: boolean,
   *   registerCancel: (cancel: () => void) => void, onProgress: (progress: number) => void}} options
   * @return {Promise<{extension: string, blob: Blob, release: (removeFiles?: boolean) => void}>}
   */
  async saveVideo(options) {
    const videoFragments = /** @type {Array<DashFragment>} */ (this.client.getFragments(this.getCurrentVideoLevelID()) || []);
    const audioFragments = /** @type {Array<DashFragment>} */ (this.client.getFragments(this.getCurrentAudioLevelID()) || []);

    let zippedFragments = Utils.zipTimedFragments([videoFragments, audioFragments]);

    if (options.partialSave) {
      zippedFragments = zippedFragments.filter((data) => {
        return data.fragment.status === DownloadStatus.DOWNLOAD_COMPLETE;
      });
    }

    const fetcher = new SaveFragmentFetcher(this.fragmentRequester, zippedFragments.map((data) => data.fragment),
        this.client.downloadManager.downloaderLimit());
    if (options?.registerCancel) {
      options.registerCancel(() => {
        fetcher.cancel();
      });
    }

    const videoProcessor = this.dash.getStreamController()?.getActiveStream()?.getStreamProcessors()?.find((o) => o.getType() === 'video');
    const audioProcessor = this.dash.getStreamController()?.getActiveStream()?.getStreamProcessors()?.find((o) => o.getType() === 'audio');

    const videoDuration = videoProcessor?.getMediaInfo()?.streamInfo?.duration || 0;
    const audioDuration = audioProcessor?.getMediaInfo()?.streamInfo?.duration || 0;

    const videoInitSegment = videoFragments?.[-1];
    const audioInitSegment = audioFragments?.[-1];

    if (videoInitSegment && videoInitSegment.status !== DownloadStatus.DOWNLOAD_COMPLETE) {
      await this.downloadFragment(videoInitSegment, -1);
    }

    if (audioInitSegment && audioInitSegment.status !== DownloadStatus.DOWNLOAD_COMPLETE) {
      await this.downloadFragment(audioInitSegment, -1);
    }

    // Downloaded again when the store lost it (savedEntry).
    /** @param {DashFragment|undefined} segment */
    const readInit = async (segment) => !segment ? null :
      (await savedEntry(() => this.client.downloadManager.getEntry(segment.getContext()),
          () => this.downloadFragment(segment, -1))).getDataFromBlob();
    const videoInitSegmentData = await readInit(videoInitSegment);
    const audioInitSegmentData = await readInit(audioInitSegment);

    const {DASH2MP4} = await import('../../modules/dash2mp4/dash2mp4.mjs');

    const dash2mp4 = new DASH2MP4(options.registerCancel);

    dash2mp4.on('progress', (/** @type {number} */ progress) => {
      if (options?.onProgress) {
        options.onProgress(progress);
      }
    });

    const videoMimeType = videoProcessor?.getRepresentation()?.mimeType;
    const audioMimeType = audioProcessor?.getRepresentation()?.mimeType;

    // Pinned last: a pinned fragment is unpinned only by its getEntry or the catch below.
    zippedFragments.forEach((data, index) => {
      data.fragment.addReference(ReferenceTypes.SAVER);
      // Let go of once read, except for the remuxer (keepPinned): it reads the store's Blobs as it writes.
      data.getEntry = async ({keepPinned = false} = {}) => {
        if (keepPinned) data.fragment.addReference(ReferenceTypes.SAVER);
        const entry = await fetcher.entry(index, () => this.client.downloadManager.getEntry(data.fragment.getContext()));
        if (!keepPinned) data.fragment.removeReference(ReferenceTypes.SAVER);
        return entry;
      };
    });

    try {
      const blob = await dash2mp4.convert(videoMimeType, videoDuration, videoInitSegmentData, audioMimeType, audioDuration, audioInitSegmentData, zippedFragments);

      return {
        extension: 'mp4',
        blob: blob,
        // The file reads from the converter's blob store: closed once nothing reads it.
        release: (/** @type {boolean|undefined} */ removeFiles) => dash2mp4.release(removeFiles),
      };
    } catch (e) {
      fetcher.cancel();
      throw e;
    } finally {
      // Whatever is still pinned for the save: what it never read, what the remuxer read.
      zippedFragments.forEach((data) => {
        data.fragment.removeReference(ReferenceTypes.SAVER);
      });
    }
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

  get buffered() {
    return this.video.buffered;
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
}
