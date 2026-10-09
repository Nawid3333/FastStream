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
import {SaveFragmentFetcher} from '../SaveFragmentFetcher.mjs';

// hls.js watches for a fragment loading too slowly and drops quality
// mid-fragment (AbrController._abandonRulesCheck). That heuristic fights
// FastStream's whole premise of pre-buffering far ahead at up to 6x, so it
// is disabled here. _abandonRulesCheck is assigned as an instance property
// in the base constructor (not a prototype method), so it has to be
// reassigned after `super()` runs rather than simply redeclared - a
// prototype method of the same name would be shadowed by that instance
// property and never called.
class FastStreamAbrController extends AbrController {
  constructor(hls) {
    super(hls);
    this._abandonRulesCheck = () => {};
  }
}

export default class HLSPlayer extends EventEmitter {
  constructor(client, config) {
    super();
    this.client = client;
    this.isPreview = config?.isPreview || false;
    this.isAudioOnly = config?.isAudioOnly || false;
    this.defaultQuality = client.options.defaultQuality || 'Auto';
    this.source = null;
    this.activeRequests = [];
    // Download-manager keys of the playlists this player has loaded; a second load of
    // one is a live refresh (HLSLoader).
    this.loadedManifests = new Set();
    this.fragmentRequester = new HLSFragmentRequester(this);
    this.video = document.createElement(this.isAudioOnly ? 'audio' : 'video');
    if (!Hls.isSupported()) {
      throw new Error('HLS Not supported');
    }

    const workerLocation = 'modules/hls.worker.js';
    const split = import.meta.url.split('/');
    const basePath = split.slice(0, split.length - 3).join('/');
    const workerPath = `${basePath}/${workerLocation}`;

    /**
     * @type {Hls}
     */
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
      enableDateRangeMetadataCues: true,
      enableEmsgMetadataCues: true,
      enableID3MetadataCues: true,
      enableWebVTT: true,
      enableIMSC1: true,
      enableCEA708Captions: true,
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
      abrController: FastStreamAbrController,
      // Without this, hls.js's error controller silently resets a manually
      // pinned level back to auto (getLevelSwitchAction -> hls.loadLevel =
      // -1) whenever a fragment/level load fails - exactly what a weak
      // connection triggers. Its bandwidth-based ABR then takes over and
      // settles on a lower quality that's never restored, even though
      // FastStream (via LevelManager.currentVideoLevelID) still believes the
      // user's chosen quality is in effect. FastStream always drives level
      // selection itself, including for "Auto" (see LevelManager.
      // getDesiredVideoHeight/matchQuality), so there's no legitimate ABR
      // mode here for hls.js to fall back to.
      preserveManualLevelOnError: true,
      maxStarvationDelay: 4,
      maxLoadingDelay: 4,
      minAutoBitrate: 0,
      emeEnabled: false,
      licenseXhrSetup: undefined,
      drmSystems: {},
      drmSystemOptions: {},
      // requestMediaKeySystemAccessFunc: requestMediaKeySystemAccess,
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
   * Reads an init segment, downloading it first if hls.js has not yet (a level just
   * switched to), as DashPlayer's save does.
   * @param {HLSFragment} init - The level's fragment -1.
   * @return {Promise<Uint8Array>}
   */
  async readInitSegment(init) {
    if (init.status !== DownloadStatus.DOWNLOAD_COMPLETE) {
      await this.downloadFragment(init, -1);
    }
    return new Uint8Array(await this.client.downloadManager.getEntry(init.getContext()).getDataFromBlob());
  }

  async saveVideo(options) {
    const fragments = this.client.getFragments(this.getCurrentVideoLevelID()) || [];
    const audioFragments = this.client.getFragments(this.getCurrentAudioLevelID()) || [];

    let zippedFragments = Utils.zipTimedFragments([fragments, audioFragments]);

    if (options.partialSave) {
      zippedFragments = zippedFragments.filter((data) => {
        return data.fragment.status === DownloadStatus.DOWNLOAD_COMPLETE;
      });
    }

    // Downloads the fragments a few ahead of the one being saved: see SaveFragmentFetcher.
    const fetcher = new SaveFragmentFetcher(this.fragmentRequester, zippedFragments.map((data) => data.fragment),
        this.client.downloadManager.downloaderLimit());
    if (options?.registerCancel) {
      options.registerCancel(() => {
        fetcher.cancel();
      });
    }

    const level = this.hls.levels[this.getIndexes(this.getCurrentVideoLevelID()).levelID];
    const audioLevel = this.hls.audioTracks[this.hls.audioTrack];

    // Read before the fragments are pinned below: a pinned fragment is unpinned only by
    // its getEntry or by the catch at the end, so nothing between the two may throw.
    let levelInitData = null;
    let audioLevelInitData = null;

    if (fragments[-1]) {
      levelInitData = await this.readInitSegment(fragments[-1]);
    }

    if (audioFragments[-1]) {
      audioLevelInitData = await this.readInitSegment(audioFragments[-1]);
    }

    zippedFragments.forEach((data, index) => {
      data.fragment.addReference(ReferenceTypes.SAVER);
      data.getEntry = async () => {
        await fetcher.get(index);
        data.fragment.removeReference(ReferenceTypes.SAVER);
        return this.client.downloadManager.getEntry(data.fragment.getContext());
      };
    });

    // A level is fMP4 exactly when its playlist named an initialization segment, and
    // those belong to the merger - HLS2MP4 below demuxes transport streams and cannot
    // read them. A level that carries its own audio rather than taking it from a
    // separate rendition belongs there too, so the audio side is handed over only when
    // it is a rendition of its own. Requiring both init segments sent fMP4-with-muxed-
    // audio to HLS2MP4, which then failed on data it was never meant to parse.
    const mergeable = levelInitData && (audioLevelInitData || audioFragments.length === 0);

    try {
      if (mergeable) {
        // Routed through the DASH2MP4 wrapper (not MP4Merger directly) so a
        // codec/packaging failure here gets the same remux
        // fallback DASH already has, instead of hard-failing the save.
        const {DASH2MP4} = await import('../../modules/dash2mp4/dash2mp4.mjs');

        const dash2mp4 = new DASH2MP4(options.registerCancel);

        dash2mp4.on('progress', (progress) => {
          if (options?.onProgress) {
            options.onProgress(progress);
          }
        });

        // audioLevel is only there when a separate audio rendition is selected, which
        // a muxed level does not have - hence the optional access and the zero/null
        // audio side, the same shape DASHPlayer already hands to a video-only save.
        const videoMimeType = level.videoCodec ? `video/mp4; codecs="${level.videoCodec}"` : null;
        const audioMimeType = audioLevel?.audioCodec ? `audio/mp4; codecs="${audioLevel.audioCodec}"` : null;

        const blob = await dash2mp4.convert(
            videoMimeType, level.details.totalduration, levelInitData.buffer,
            audioMimeType,
            audioLevelInitData ? audioLevel.details.totalduration : 0,
            audioLevelInitData ? audioLevelInitData.buffer : null,
            zippedFragments);

        return {
          extension: 'mp4',
          blob: blob,
          // The file reads from the converter's blob store: closed once nothing reads it.
          release: () => dash2mp4.release(),
        };
      } else {
        if (levelInitData || audioLevelInitData) {
          console.warn('Unexpected init data');
        }
        const {HLS2MP4} = await import('../../modules/hls2mp4/hls2mp4.mjs');
        const hls2mp4 = new HLS2MP4(options.registerCancel);

        hls2mp4.on('progress', (progress) => {
          if (options?.onProgress) {
            options.onProgress(progress);
          }
        });
        const blob = await hls2mp4.convert(level, levelInitData, audioLevel, audioLevelInitData, zippedFragments);

        return {
          extension: 'mp4',
          blob: blob,
          release: () => hls2mp4.release(),
        };
      }
    } catch (e) {
      fetcher.cancel();
      zippedFragments.forEach((data) => {
        data.fragment.removeReference(ReferenceTypes.SAVER);
      });
      throw e;
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

    await new Promise((resolve, reject) => {
      this.hls.on(Hls.Events.MEDIA_ATTACHED, function() {
        resolve();
      });
    });

    const preEvents = new EventEmitter();
    const emitterRelay = new EmitterRelay([preEvents, this]);
    VideoUtils.addPassthroughEventListenersToVideo(this.video, emitterRelay);


    this.hls.on(Hls.Events.MANIFEST_PARSED, async (event, data) => {
      // What Firefox says about decoding each version, before the first pick reads it.
      // Nothing loads until load() below (autoStartLoad is off), and a probe gives up
      // after DecodingCapabilities.PROBE_TIMEOUT_MS. It never throws (an error is no answer),
      // so the pick and load() below always run.
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

    // After a fatal error hls.js loads nothing more. A manifest or playlist that could not
    // be loaded gives <video> no error of its own, so without this the player would wait
    // forever instead of saying it failed.
    this.hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) this.emit(DefaultPlayerEvents.ERROR, data);
    });
  }

  trackUpdated(levelDetails, trackID) {
    levelDetails.trackID = trackID;
    // FastStream decrypts AES-128 segments itself (HLSFragmentRequester), its init segment
    // too; other encryption (SAMPLE-AES, DRM) it cannot play.
    if (!HLSFragmentRequester.takeOverDecryption(levelDetails.fragments)) {
      this.emit(DefaultPlayerEvents.NEED_KEY);
    }
    // Into the store, from the level's first segment (HLSFragmentStore).
    storeLevel(this.client, levelDetails, (level) => this.getIdentifier(trackID, level));
  }
  getVideo() {
    return this.video;
  }

  getIdentifier(trackID, levelID) {
    return `${trackID}:${levelID}`;
  }

  getIndexes(identifier) {
    const parts = identifier.split(':');
    return {
      trackID: parseInt(parts[0]),
      levelID: parseInt(parts[1]),
    };
  }

  async setSource(source) {
    this.source = source;
    this.hls.loadSource(source.url);
  }

  getSource() {
    return this.source;
  }

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

    VideoUtils.destroyVideo(this.video);
    this.video = null;

    this.emit(DefaultPlayerEvents.DESTROYED);
  }

  set currentTime(value) {
    // The seek preview follows the pointer: what it was loading for the old place is dropped,
    // through hls.js, which then loads from the new one. Its loaders were aborted behind its
    // back before, and hls.js resets after an abort only once its first segment has loaded
    // (handleFragLoadAborted needs its transmuxer): a hover before that left the preview
    // loading that first segment for good, and hovering loaded nothing for the rest of the
    // video.
    if (this.isPreview && this.activeRequests.length > 0 && !VideoUtils.isBuffered(this.video.buffered, value)) {
      // Still on the segment that is loading: it goes on. The pointer moves many times a
      // second, and on a slow line each move started that segment over.
      const loading = this.hls.streamController?.fragCurrent;
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
   * @param {Object} level - An hls.js Level.
   * @return {?Object} What DecodingCapabilities asks about it.
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
   * @param {Object} track - An hls.js audio track.
   * @return {?Object}
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
      result.set(identifier, new VideoLevel({
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
      }));
    });
    return result;
  }

  getAudioLevels() {
    const result = new Map();
    this.hls.audioTracks.forEach((track, index) => {
      const identifier = this.getIdentifier(1, index);
      result.set(identifier, new AudioLevel({
        id: identifier,
        bitrate: track.bitrate,
        mimeType: null,
        language: track.lang,
        audioCodec: track.audioCodec ? `audio/mp4; codecs="${track.audioCodec}"` : null,
        decoding: cachedAnswer(HLSPlayer.audioProbeForTrack(track)),
      }));
    });
    return result;
  }

  getCurrentVideoLevelID() {
    const level = this.hls.currentLevel === -1 ? this.hls.loadLevel : this.hls.currentLevel;
    // No level before the manifest is parsed. This was "0:null", which FastStreamClient took
    // for a level and wrote over the level an archive had asked for.
    return level === -1 ? null : this.getIdentifier(0, level);
  }

  setCurrentVideoLevelID(value) {
    if (value === null) return;
    const level = this.getIndexes(value).levelID;
    // The level it loads already: pinned for what it loads next. Setting currentLevel makes
    // hls.js switch at once even to the same level - it drops the segment loading and the
    // buffer: the client's level check (checkLevelChange) told the seek preview the level it
    // was on, and the segment under the pointer was dropped 0.4 s in and downloaded again.
    // In effect: the level it loads next (loadLevel, once set) or the one playing; a real
    // change still switches at once.
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
   * Whether the stream is live. Its duration does not say so: with liveDurationInfinity off,
   * hls.js makes it the end of the live window, not Infinity.
   * @return {boolean}
   */
  get isLive() {
    const level = this.hls.levels[this.hls.currentLevel === -1 ? this.hls.loadLevel : this.hls.currentLevel];
    return !!level?.details?.live;
  }

  /**
   * The fragment at the playhead, in the level that is playing. The client downloads ahead
   * from it (FastStreamClient.getNextToDownload). hls.js's currentFrag is the fragment that
   * plays, and after a seek it stays the old one until the first fragment at the new time
   * plays: the downloads went on from the old place meanwhile, three segments there before
   * the one the seek needed. So the level comes from hls.js, the fragment from the time, as
   * currentAudioFragment and DashPlayer's do.
   * @return {Object|null}
   */
  get currentFragment() {
    const frag = this.hls.streamController.currentFrag;
    if (!frag) return null;
    const identifier = this.getIdentifier(0, frag.level);
    const fragments = this.client.getFragments(identifier);
    const time = this.currentTime;
    const atTime = fragments?.find((fragment) => fragment && time >= fragment.start && time < fragment.end);
    if (atTime) return atTime;
    // At the very end, or in a gap: the last one before the time, still not the old place.
    const before = fragments?.findLast((fragment) => fragment && fragment.start <= time);
    if (before) return before;
    const index = storeIndex(fragments, frag.sn);
    return index === null ? null : this.client.getFragment(identifier, index);
  }

  getCurrentAudioLevelID() {
    return this.hls.audioTrack === -1 ? null : this.getIdentifier(1, this.hls.audioTrack);
  }

  setCurrentAudioLevelID(value) {
    if (value === null) return;
    this.hls.audioTrack = this.getIndexes(value).levelID;
  }

  get currentAudioFragment() {
    const frags = this.client.getFragments(this.getCurrentAudioLevelID());
    if (!frags) return null;

    const time = this.currentTime;
    return frags.find((frag) => {
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
