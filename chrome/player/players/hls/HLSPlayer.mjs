// @ts-check
import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {DownloadStatus} from '../../enums/DownloadStatus.mjs';
import {ReferenceTypes} from '../../enums/ReferenceTypes.mjs';
import {AudioLevel, VideoLevel} from '../Levels.mjs';
import {audioProbeFor, cachedAnswer, probeDecoding, videoProbeFor} from '../DecodingCapabilities.mjs';
import {EmitterRelay, EventEmitter} from '../../modules/eventemitter.mjs';
import {AbrController, Hls} from '../../modules/hls.mjs';
import {Utils} from '../../utils/Utils.mjs';
import {VideoUtils} from '../../utils/VideoUtils.mjs';
import {storeIndex, storeLevel} from './HLSFragmentStore.mjs';
import {HLSFragmentRequester} from './HLSFragmentRequester.mjs';
import {HLSLoaderFactory} from './HLSLoader.mjs';
import {SaveFragmentFetcher, savedEntry} from '../SaveFragmentFetcher.mjs';

/** @typedef {import('./HLSFragment.mjs').HLSFragment} HLSFragment */

// No mid-fragment quality drop: _abandonRulesCheck is an instance property, reassigned after super().
class FastStreamAbrController extends /** @type {any} */ (AbrController) {
  /** @param {Hls} hls */
  constructor(hls) {
    super(hls);
    this._abandonRulesCheck = () => {};
  }
}

export default class HLSPlayer extends EventEmitter {
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
    this.source = null;
    // The segment downloads hls.js waits for (HLSLoader), dropped when the preview seeks.
    /** @type {import('../../network/DownloadEntry.mjs').DownloadWatcher[]} */
    this.activeRequests = [];
    // Download-manager keys of the playlists loaded: a second load of one is a live refresh.
    /** @type {Set<string>} */
    this.loadedManifests = new Set();
    this.fragmentRequester = new HLSFragmentRequester(this);
    // An audio-only player's <audio> serves only as a media element.
    this.video = /** @type {HTMLVideoElement} */ (document.createElement(this.isAudioOnly ? 'audio' : 'video'));
    if (!Hls.isSupported()) {
      throw new Error('HLS Not supported');
    }

    const workerLocation = 'modules/hls.worker.js';
    const split = import.meta.url.split('/');
    const basePath = split.slice(0, split.length - 3).join('/');
    const workerPath = `${basePath}/${workerLocation}`;

    /** @type {Hls} */
    this.hls = new Hls({
      autoStartLoad: false,
      startPosition: -1,
      debug: false,
      capLevelOnFPSDrop: false,
      capLevelToPlayerSize: true,
      defaultAudioCodec: undefined,
      initialLiveManifestSize: 1,
      maxBufferLength: this.isPreview ? 1 : 10,
      maxMaxBufferLength: this.isPreview ? 1 : 10,
      backBufferLength: this.isPreview ? 0 : 10,
      maxBufferSize: this.isPreview ? 0 : (1000 * 1000),
      maxBufferHole: 0.5,
      highBufferWatchdogPeriod: 2,
      nudgeOffset: 0.1,
      nudgeMaxRetry: 3,
      maxFragLookUpTolerance: 0.25,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: Infinity,
      liveDurationInfinity: false,
      enableWorker: true,
      workerPath: workerPath,
      enableSoftwareAES: true,
      startFragPrefetch: false,
      testBandwidth: false,
      progressive: false,
      lowLatencyMode: false,
      fpsDroppedMonitoringPeriod: 5000,
      fpsDroppedMonitoringThreshold: 0.2,
      appendErrorMaxRetry: 3,
      // eslint-disable-next-line new-cap
      loader: HLSLoaderFactory(this),
      // FastStream shows neither hls.js's text tracks nor its metadata cues: all off.
      enableDateRangeMetadataCues: false,
      enableEmsgMetadataCues: false,
      enableID3MetadataCues: false,
      enableWebVTT: false,
      enableIMSC1: false,
      enableCEA708Captions: false,
      // Interstitials off: hls.js would play them in players FastStream does not drive.
      enableInterstitialPlayback: false,
      stretchShortVideoTrack: false,
      maxAudioFramesDrift: 1,
      forceKeyFrameOnDiscontinuity: true,
      abrEwmaFastLive: 3.0,
      abrEwmaSlowLive: 9.0,
      abrEwmaFastVoD: 3.0,
      abrEwmaSlowVoD: 9.0,
      abrEwmaDefaultEstimate: 5000000,
      abrBandWidthFactor: 0.95,
      abrBandWidthUpFactor: 0.7,
      abrMaxWithRealBitrate: false,
      // Cast as its base is (FastStreamAbrController): hls.js's types call a member it overrides private.
      abrController: /** @type {any} */ (FastStreamAbrController),
      // hls.js's error controller resets a pinned level to auto on a load failure; FastStream picks levels itself.
      preserveManualLevelOnError: true,
      maxStarvationDelay: 4,
      maxLoadingDelay: 4,
      minAutoBitrate: 0,
      emeEnabled: false,
      licenseXhrSetup: undefined,
      drmSystems: {},
      drmSystemOptions: {},
      cmcd: undefined,
    });
  }

  canSave() {
    const frags = this.client.getFragments(this.getCurrentVideoLevelID());
    if (!frags) {
      return {
        canSave: false,
        isComplete: false,
      };
    }
    let incomplete = false;
    for (let i = 0; i < frags.length; i++) {
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
   * Reads an init segment, downloading it first if hls.js has not yet (a level just switched to).
   * @param {HLSFragment} init - The level's fragment -1.
   * @return {Promise<Uint8Array>}
   */
  async readInitSegment(init) {
    if (init.status !== DownloadStatus.DOWNLOAD_COMPLETE) {
      await this.downloadFragment(init, -1);
    }
    // Downloaded again when the store lost it (savedEntry).
    const entry = await savedEntry(() => this.client.downloadManager.getEntry(init.getContext()),
        () => this.downloadFragment(init, -1));
    return new Uint8Array(await entry.getDataFromBlob());
  }

  /**
   * fMP4 levels go through DASH2MP4, transport streams through HLS2MP4.
   * @param {{filestream?: WritableStream<Uint8Array>, partialSave: boolean,
   *   registerCancel: (cancel: () => void) => void, onProgress: (progress: number) => void}} options
   */
  async saveVideo(options) {
    const fragments = /** @type {import('./HLSFragmentStore.mjs').FragmentStore} */ (this.client.getFragments(this.getCurrentVideoLevelID()) || []);
    const audioFragments = /** @type {import('./HLSFragmentStore.mjs').FragmentStore} */ (this.client.getFragments(this.getCurrentAudioLevelID()) || []);

    let zippedFragments = Utils.zipTimedFragments([fragments, audioFragments]);

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

    // A level plays: SaveManager saves only after canSave found its fragments.
    const level = this.hls.levels[this.getIndexes(/** @type {string} */ (this.getCurrentVideoLevelID())).levelID];
    const audioLevel = this.hls.audioTracks[this.hls.audioTrack];

    // Read before the fragments are pinned: a pinned fragment is unpinned only by its getEntry or the catch.
    /** @type {Uint8Array|null} */
    let levelInitData = null;
    /** @type {Uint8Array|null} */
    let audioLevelInitData = null;

    if (fragments[-1]) {
      levelInitData = await this.readInitSegment(fragments[-1]);
    }

    if (audioFragments[-1]) {
      audioLevelInitData = await this.readInitSegment(audioFragments[-1]);
    }

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

    // fMP4 (an init segment) goes to the merger, its audio side only when it is a rendition of its own.
    const mergeable = levelInitData && (audioLevelInitData || audioFragments.length === 0);

    try {
      if (mergeable) {
        // Through DASH2MP4, not MP4Merger, for its remux fallback.
        const {DASH2MP4} = await import('../../modules/dash2mp4/dash2mp4.mjs');

        const dash2mp4 = new DASH2MP4(options.registerCancel);

        dash2mp4.on('progress', (/** @type {number} */ progress) => {
          if (options?.onProgress) {
            options.onProgress(progress);
          }
        });

        // audioLevel exists only for a separate rendition: a muxed level has a zero/null audio side.
        const videoMimeType = level.videoCodec ? `video/mp4; codecs="${level.videoCodec}"` : null;
        const audioMimeType = audioLevel?.audioCodec ? `audio/mp4; codecs="${audioLevel.audioCodec}"` : null;

        const blob = await dash2mp4.convert(
            // Set: mergeable needs it.
            videoMimeType, /** @type {import('../../modules/hls.mjs').LevelDetails} */ (level.details).totalduration, /** @type {Uint8Array} */ (levelInitData).buffer,
            audioMimeType,
            audioLevelInitData ? /** @type {import('../../modules/hls.mjs').LevelDetails} */ (audioLevel.details).totalduration : 0,
            audioLevelInitData ? audioLevelInitData.buffer : null,
            zippedFragments);

        return {
          extension: 'mp4',
          blob: blob,
          // The file reads from the converter's blob store: closed once nothing reads it.
          release: (/** @type {boolean|undefined} */ removeFiles) => dash2mp4.release(removeFiles),
        };
      } else {
        if (levelInitData || audioLevelInitData) {
          console.warn('Unexpected init data');
        }
        const {HLS2MP4} = await import('../../modules/hls2mp4/hls2mp4.mjs');
        const hls2mp4 = new HLS2MP4(options.registerCancel);

        hls2mp4.on('progress', (/** @type {number} */ progress) => {
          if (options?.onProgress) {
            options.onProgress(progress);
          }
        });
        const blob = await hls2mp4.convert(level, levelInitData, audioLevel, audioLevelInitData, zippedFragments);

        return {
          extension: 'mp4',
          blob: blob,
          release: (/** @type {boolean|undefined} */ removeFiles) => hls2mp4.release(removeFiles),
        };
      }
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

  load() {
    this.hls.startLoad();
  }

  getClient() {
    return this.client;
  }


  async setup() {
    this.hls.attachMedia(this.video);

    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      this.hls.on(Hls.Events.MEDIA_ATTACHED, function() {
        resolve();
      });
    }));

    const preEvents = new EventEmitter();
    const emitterRelay = new EmitterRelay([preEvents, this]);
    VideoUtils.addPassthroughEventListenersToVideo(/** @type {HTMLVideoElement} */ (this.video), emitterRelay);


    this.hls.on(Hls.Events.MANIFEST_PARSED, async (event, data) => {
      // What Firefox says about decoding each version, before the first pick; it never throws.
      await this.probeLevels().catch((e) => console.warn('[HLSPlayer] probing levels failed', e));
      if (!this.video) {
        // Destroyed while asking.
        return;
      }

      this.emit(DefaultPlayerEvents.MANIFEST_PARSED);

      const levels = this.getVideoLevels();
      const chosenLevel = this.client.getLevelManager().pickVideoLevel(Array.from(levels.values()));
      if (chosenLevel) {
        this.setCurrentVideoLevelID(chosenLevel.id);
      }

      const audioLevels = this.getAudioLevels();
      const chosenAudioLevel = this.client.getLevelManager().pickAudioLevel(Array.from(audioLevels.values()));
      if (chosenAudioLevel) {
        this.setCurrentAudioLevelID(chosenAudioLevel.id);
      }

      this.hls.subtitleDisplay = false;
      this.hls.subtitleTrack = -1;

      this.load();
    });

    this.hls.on(Hls.Events.LEVEL_UPDATED, (a, data) => {
      this.trackUpdated(data.details, 0);
    });


    this.hls.on(Hls.Events.AUDIO_TRACK_UPDATED, (a, data) => {
      this.trackUpdated(data.details, 1);
    });

    // A manifest or playlist that could not be loaded gives <video> no error of its own.
    this.hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) this.emit(DefaultPlayerEvents.ERROR, data);
    });
  }

  /**
   * @param {import('../../modules/hls.mjs').LevelDetails} levelDetails
   * @param {number} trackID - 0 for a level, 1 for an audio track.
   */
  trackUpdated(levelDetails, trackID) {
    levelDetails.trackID = trackID;
    // FastStream decrypts AES-128 segments itself (HLSFragmentRequester); other encryption it cannot play.
    if (!HLSFragmentRequester.takeOverDecryption(levelDetails.fragments)) {
      this.emit(DefaultPlayerEvents.NEED_KEY);
    }
    storeLevel(this.client, levelDetails, (level) => this.getIdentifier(trackID, level));
  }
  getVideo() {
    return this.video;
  }

  /**
   * The store's id of a level or an audio track ("track:index").
   * @param {number|undefined} trackID - 0 for a level, 1 for an audio track.
   * @param {number} levelID - Its index in hls.js's levels or audio tracks.
   * @return {string}
   */
  getIdentifier(trackID, levelID) {
    return `${trackID}:${levelID}`;
  }

  /**
   * @param {string} identifier
   * @return {{trackID: number, levelID: number}}
   */
  getIndexes(identifier) {
    const parts = identifier.split(':');
    return {
      trackID: parseInt(parts[0]),
      levelID: parseInt(parts[1]),
    };
  }

  /** @param {import('../../VideoSource.mjs').VideoSource} source */
  async setSource(source) {
    this.source = source;
    this.hls.loadSource(source.url);
  }

  getSource() {
    return this.source;
  }

  /**
   * @param {HLSFragment} fragment
   * @param {number} priority - Higher first (a save's -1).
   * @return {Promise<void>}
   */
  downloadFragment(fragment, priority) {
    return new Promise((resolve, reject) => {
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
    });
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
    this.fragmentRequester.destroy();
    this.hls.destroy();

    VideoUtils.destroyVideo(/** @type {HTMLVideoElement} */ (this.video));
    this.video = /** @type {any} */ (null);

    this.emit(DefaultPlayerEvents.DESTROYED);
  }

  set currentTime(value) {
    // The preview follows the pointer through hls.js: an abort behind its back stuck it on its first segment.
    if (this.isPreview && this.activeRequests.length > 0 && !VideoUtils.isBuffered(this.video.buffered, value)) {
      // Still on the segment that is loading: it goes on (each pointer move would start it over).
      const loading = /** @type {any} */ (this.hls).streamController?.fragCurrent;
      if (loading && value >= loading.start && value < loading.start + loading.duration) {
        this.video.currentTime = value;
        return;
      }
      this.hls.stopLoad();
      this.activeRequests.length = 0;
      this.video.currentTime = value;
      this.hls.startLoad(value);
      return;
    }

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

  /**
   * @param {import('../../modules/hls.mjs').Level} level
   * @return {?import('../DecodingCapabilities.mjs').VideoProbe} Null for a codec it does not know.
   */
  static videoProbeForLevel(level) {
    return videoProbeFor({
      codec: level.videoCodec,
      width: level.width,
      height: level.height,
      bitrate: level.bitrate,
      frameRate: level.frameRate,
      videoRange: level.videoRange,
    });
  }

  /**
   * @param {import('../../modules/hls.mjs').MediaPlaylist} track
   * @return {?import('../DecodingCapabilities.mjs').AudioProbe}
   */
  static audioProbeForTrack(track) {
    return audioProbeFor({codec: track.audioCodec, bitrate: track.bitrate});
  }

  async probeLevels() {
    const levels = this.hls?.levels || [];
    const tracks = this.hls?.audioTracks || [];
    await Promise.all([
      ...levels.map((level) => probeDecoding(HLSPlayer.videoProbeForLevel(level))),
      ...tracks.map((track) => probeDecoding(HLSPlayer.audioProbeForTrack(track))),
    ]);
  }

  getVideoLevels() {
    const result = new Map();
    this.hls.levels.forEach((level, index) => {
      const identifier = this.getIdentifier(0, index);
      result.set(identifier, new VideoLevel(/** @type {NonNullable<ConstructorParameters<typeof VideoLevel>[0]>} */ ({
        id: identifier,
        width: level.width,
        height: level.height,
        bitrate: level.bitrate,
        mimeType: null,
        language: null,
        videoCodec: level.videoCodec || null,
        audioCodec: level.audioCodec || null,
        frameRate: level.frameRate,
        videoRange: level.videoRange,
        decoding: cachedAnswer(HLSPlayer.videoProbeForLevel(level)),
      })));
    });
    return result;
  }

  getAudioLevels() {
    const result = new Map();
    this.hls.audioTracks.forEach((track, index) => {
      const identifier = this.getIdentifier(1, index);
      result.set(identifier, new AudioLevel(/** @type {NonNullable<ConstructorParameters<typeof AudioLevel>[0]>} */ ({
        id: identifier,
        bitrate: track.bitrate,
        mimeType: null,
        language: track.lang,
        label: track.name,
        audioCodec: track.audioCodec ? `audio/mp4; codecs="${track.audioCodec}"` : null,
        decoding: cachedAnswer(HLSPlayer.audioProbeForTrack(track)),
      })));
    });
    return result;
  }

  getCurrentVideoLevelID() {
    const level = this.hls.currentLevel === -1 ? this.hls.loadLevel : this.hls.currentLevel;
    // No level before the manifest is parsed.
    return level === -1 ? null : this.getIdentifier(0, level);
  }

  /** @param {string|number|null} value - A getCurrentVideoLevelID string; null for none. */
  setCurrentVideoLevelID(value) {
    if (value === null) return;
    const level = this.getIndexes(/** @type {string} */ (value)).levelID;
    // The level it loads already is only pinned: setting currentLevel switches at once even to the same level.
    if (level === this.hls.loadLevel || level === this.hls.currentLevel) {
      this.hls.loadLevel = level;
      return;
    }
    this.hls.currentLevel = level;
  }

  get duration() {
    return this.video.duration;
  }

  /**
   * Its duration does not say so: hls.js makes it the end of the live window.
   * @return {boolean}
   */
  get isLive() {
    const level = this.hls.levels[this.hls.currentLevel === -1 ? this.hls.loadLevel : this.hls.currentLevel];
    return !!level?.details?.live;
  }

  /**
   * The fragment at the playhead: hls.js's currentFrag stays the old one after a seek until the new one plays.
   * @return {HLSFragment|null|undefined} None when the store has no fragment there.
   */
  get currentFragment() {
    const frag = /** @type {any} */ (this.hls).streamController.currentFrag;
    if (!frag) return null;
    const identifier = this.getIdentifier(0, frag.level);
    const fragments = /** @type {import('./HLSFragmentStore.mjs').FragmentStore|undefined} */ (this.client.getFragments(identifier));
    const time = this.currentTime;
    // (A store has holes where segments were forgotten: HLSFragmentStore.)
    const atTime = fragments?.find((/** @type {HLSFragment|undefined} */ fragment) => fragment && time >= fragment.start && time < fragment.end);
    if (atTime) return atTime;
    // At the very end, or in a gap: the last one before the time, still not the old place.
    const before = fragments?.findLast((/** @type {HLSFragment|undefined} */ fragment) => fragment && fragment.start <= time);
    if (before) return before;
    const index = storeIndex(fragments, frag.sn);
    return index === null ? null : /** @type {HLSFragment|null|undefined} */ (this.client.getFragment(identifier, index));
  }

  getCurrentAudioLevelID() {
    return this.hls.audioTrack === -1 ? null : this.getIdentifier(1, this.hls.audioTrack);
  }

  /** @param {string|number|null} value - A getCurrentAudioLevelID string; null for none. */
  setCurrentAudioLevelID(value) {
    if (value === null) return;
    this.hls.audioTrack = this.getIndexes(/** @type {string} */ (value)).levelID;
  }

  /** @return {HLSFragment|null|undefined} Null without an audio store; none when it has no fragment there. */
  get currentAudioFragment() {
    const frags = /** @type {import('./HLSFragmentStore.mjs').FragmentStore|undefined} */ (this.client.getFragments(this.getCurrentAudioLevelID()));
    if (!frags) return null;

    const time = this.currentTime;
    return frags.find((/** @type {HLSFragment|undefined} */ frag) => {
      if (!frag) return false;
      return time >= frag.start && time < frag.end;
    });
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
}
