// @ts-check
import {InterfaceController} from './ui/InterfaceController.mjs';
import {KeybindManager} from './ui/KeybindManager.mjs';
import {FrameStepper} from './ui/FrameStepper.mjs';
import {DownloadManager} from './network/DownloadManager.mjs';
import {DefaultPlayerEvents} from './enums/DefaultPlayerEvents.mjs';
import {DownloadStatus} from './enums/DownloadStatus.mjs';
import {PlayerModes} from './enums/PlayerModes.mjs';
import {ReferenceTypes} from './enums/ReferenceTypes.mjs';
import {EventEmitter} from './modules/eventemitter.mjs';
import {SourcesBrowser} from './ui/SourcesBrowser.mjs';
import {PlayerLoader} from './players/PlayerLoader.mjs';
import {DOMElements} from './ui/DOMElements.mjs';
import {AudioOutput} from './ui/audio/AudioOutput.mjs';
import {AudioOutputDevice} from './ui/audio/AudioOutputDevice.mjs';
import {EnvUtils} from './utils/EnvUtils.mjs';
import {Localize} from './modules/Localize.mjs';
import {DroppedFrameWatch, lowerLevel, qualityLabel} from './players/DroppedFrameWatch.mjs';
import {ClickActions} from './options/defaults/ClickActions.mjs';
import {VisChangeActions} from './options/defaults/VisChangeActions.mjs';
import {MiniplayerPositions} from './options/defaults/MiniplayerPositions.mjs';
import {AspectRatios} from './options/defaults/AspectRatios.mjs';
import {SecureMemory} from './modules/SecureMemory.mjs';
import {Utils} from './utils/Utils.mjs';
import {DefaultToolSettings} from './options/defaults/ToolSettings.mjs';
import {AudioAnalyzer} from './modules/analyzer/AudioAnalyzer.mjs';
import {PreviewFrameExtractor} from './modules/analyzer/PreviewFrameExtractor.mjs';
import {URLUtils} from './utils/URLUtils.mjs';
import {StringUtils} from './utils/StringUtils.mjs';
import {StatusTypes} from './ui/StatusManager.mjs';
import {InterfaceUtils} from './utils/InterfaceUtils.mjs';
import {VirtualAudioNode} from './ui/audio/VirtualAudioNode.mjs';
import {SyncedAudioPlayer} from './players/SyncedAudioPlayer.mjs';
import {AlertPolyfill} from './utils/AlertPolyfill.mjs';
import {MessageTypes} from './enums/MessageTypes.mjs';
import {LevelManager} from './players/LevelManager.mjs';
import {VpnPrompt} from './ui/VpnPrompt.mjs';
import {describePlayerError, isNetworkFailure} from './utils/PlayerErrorUtils.mjs';
import {isDecodeError, isSamePlace, pastBrokenMedia} from './utils/BrokenMedia.mjs';
import {PlayerPeers} from './network/PlayerPeers.mjs';
import {PageFetch} from './network/PageFetch.mjs';
import {StreamQuery} from './network/StreamQuery.mjs';
import {aheadOfPlayhead} from './network/BufferAhead.mjs';
import {besidePlayhead, downloadingOutside, KEEP_AHEAD_S, KEEP_BEHIND_S, shouldConcentrate} from './network/PlayheadFirst.mjs';
import {isTimed, untimedSpans} from './network/UntimedSpans.mjs';
import {SILENT_MAX_PLAYBACK_RATE} from './options/KeybindUtils.mjs';
import {BufferKeepDefault, bufferKeepSeconds} from './options/BufferKeep.mjs';
import {resumedMessage} from './ui/PlaybackNotices.mjs';
import {chooseToRelease, DEFAULT_BUDGET_BYTES, DISK_ONLY_ROOM_BYTES, HIGH, isFull, KEEP_IN_RAM_ONLY_WINDOW, KEEP_ON_DISK_WINDOW, LOW, shareOf, weightOf} from './network/MemoryBudget.mjs';
import {VideoTransformUtils} from './utils/VideoTransformUtils.mjs';
import {VideoLevel} from './players/Levels.mjs';
import {WebStorage} from './utils/WebStorage.mjs';


const SET_VOLUME_USING_NODE = EnvUtils.isWebAudioSupported();

// The quality menu id prefix of a page quality, followed by its index in VideoSource.qualities.
const PAGE_QUALITY_LEVEL = 'page-quality:';

// recoverPlayer rebuilds the player at most RECOVERY_LIMIT times in RECOVERY_WINDOW_MS for one source.
const RECOVERY_LIMIT = 3;
const RECOVERY_WINDOW_MS = 120000;
// The preview player is rebuilt after errors at most PREVIEW_RELOAD_LIMIT times in RECOVERY_WINDOW_MS.
const PREVIEW_RELOAD_LIMIT = 3;
// renewSourceLink asks the page for a refused link at most LINK_RENEWAL_LIMIT times in LINK_RENEWAL_WINDOW_MS.
const LINK_RENEWAL_LIMIT = 2;
const LINK_RENEWAL_WINDOW_MS = 300000;
// How far into a video the overlay's picture is taken again (takeArtwork), past a black start.
const ARTWORK_AFTER_S = 5;
// Saved positions resume for a year; older ones are deleted at most once a day (scheduleProgressPrune).
const PROGRESS_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const PROGRESS_PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const PROGRESS_PRUNE_DELAY_MS = 30000;
const PROGRESS_PRUNED_KEY = 'faststream-progress-pruned';
const DROPPED_SAMPLE_MS = 1000;
// How long a stream may stay stuck in its last seconds before autoplay takes it as ended.
const EndStallMs = 3000;
// How long autoplay waits for the remembered time: a blocked IndexedDB open never answers.
const RememberedWaitMs = 3000;
/**
 * How a source set with setSource starts. keepStorage, keepChoice, relink: its reset keeps the download
 * and the hand-picked version under a new link; rebuild: the same video again; skipRemembered: not its remembered time.
 * @typedef {{play?: boolean, keepStorage?: boolean, keepChoice?: boolean, rebuild?: boolean,
 *   relink?: {from: string, to: string}, skipRemembered?: boolean}} SourceStart
 */

// Preview players that reported an error while their build still ran (buildPreviewPlayer).
const PreviewsFailedInBuild = new WeakSet();
// How long a request for the next video waits for the background's answer (nextVideo, autoplayNextVideo).
const NextAnswerMs = 5000;
const AutoNextRetryMs = 2000;
const AutoNextTries = 5;

/** @typedef {import('./options/defaults/ToolSettings.mjs').ToolSetting} ToolSetting */
/** @typedef {import('./VideoSource.mjs').VideoSource} VideoSource */
/** @typedef {import('./players/Fragment.mjs').Fragment} Fragment */

/**
 * A player PlayerLoader.createPlayer builds, one for each mode.
 * @typedef {import('./players/DirectVideoPlayer.mjs').default|import('./players/mp4/MP4Player.mjs').default|
 *     import('./players/hls/HLSPlayer.mjs').default|import('./players/dash/DashPlayer.mjs').default|
 *     import('./players/vm/VMPlayer.mjs').default} Player
 */

/** @typedef {ReturnType<Player['createContext']>} PlayerContext */

/**
 * The client's options: its defaults, most replaced by the stored ones (setOptions).
 * @typedef {Object} ClientOptions
 * @property {boolean} autoPlay
 * @property {number} maxSpeed - 0 downloads nothing ahead, below 0 is no limit.
 * @property {number} maxVideoSize - Bytes.
 * @property {number} ramBudget - Bytes, for all players together.
 * @property {boolean} bufferToDisk
 * @property {number} bufferKeep - Seconds a gone player's buffer is kept for its next player (BufferKeep.mjs); 0 none.
 * @property {number} bufferAhead - Seconds; Infinity for no limit.
 * @property {number} bufferBehind - Seconds; Infinity for no limit.
 * @property {boolean} freeFragments
 * @property {boolean} downloadAll
 * @property {boolean} freeUnusedChannels
 * @property {boolean} storeProgress
 * @property {boolean} disableLoadProgress
 * @property {boolean} previewEnabled
 * @property {boolean} decodingAwareQuality
 * @property {boolean} lowerOnDroppedFrames
 * @property {boolean} autoplayNext
 * @property {number} autoplayCountdown - Seconds.
 * @property {string} singleClickAction - A ClickActions value.
 * @property {string} doubleClickAction - A ClickActions value.
 * @property {string} tripleClickAction - A ClickActions value.
 * @property {string} visChangeAction - A VisChangeActions value.
 * @property {number} miniSize
 * @property {string} miniPos - A MiniplayerPositions value.
 * @property {number} videoZoom
 * @property {string} videoAspectRatio - An AspectRatios value.
 * @property {number} seekStepSize - Seconds.
 * @property {string} defaultQuality
 * @property {Object<string, ToolSetting>} toolSettings - By the tool's name.
 * @property {number} videoDelay - Milliseconds.
 * @property {number} videoFlip - 0 to 3 (VideoTransformUtils).
 * @property {number} videoRotate - Quarter turns, 0 to 3.
 * @property {number} maximumDownloaders
 * @property {number} maxPlaybackRate
 * @property {boolean} [autoEnableBestSubtitles]
 * @property {boolean} [cycleSubtitles]
 * @property {boolean} [mpvMode]
 * @property {boolean} [mpvPausePage]
 */

/** @extends EventEmitter */
export class FastStreamClient extends EventEmitter {
  constructor() {
    super();
    this.version = EnvUtils.getVersion();
    /** @type {?{tabId: number, frameId: number}} */
    this.page = null;

    /** @type {ClientOptions} */
    this.options = {
      autoPlay: false,
      maxSpeed: -1,
      maxVideoSize: 5000000000,
      ramBudget: DEFAULT_BUDGET_BYTES,
      bufferToDisk: true,
      bufferKeep: BufferKeepDefault,
      bufferAhead: 300,
      bufferBehind: 20,
      freeFragments: true,
      downloadAll: false,
      freeUnusedChannels: true,
      storeProgress: false,
      disableLoadProgress: false,
      previewEnabled: true,
      decodingAwareQuality: true,
      lowerOnDroppedFrames: true,
      autoplayNext: false,
      autoplayCountdown: 5,
      singleClickAction: ClickActions.HIDE_CONTROLS,
      doubleClickAction: ClickActions.PLAY_PAUSE,
      tripleClickAction: ClickActions.FULLSCREEN,
      visChangeAction: VisChangeActions.NOTHING,
      miniSize: 0.25,
      miniPos: MiniplayerPositions.BOTTOM_RIGHT,
      videoZoom: 1,
      videoAspectRatio: AspectRatios.AUTO,
      seekStepSize: 0.2,
      defaultQuality: 'Auto',
      toolSettings: /** @type {Object<string, ToolSetting>} */ (Utils.mergeOptions(DefaultToolSettings, {})),
      videoDelay: 0,
      videoFlip: 0,
      videoRotate: 0,
      maximumDownloaders: 6,
      maxPlaybackRate: 8,
    };
    this.state = {
      playing: false,
      buffering: false,
      currentTime: 0,
      volume: 1,
      muted: false,
      playbackRate: 1,
      hasUserInteracted: false,
      bufferBehind: this.options.bufferBehind,
      bufferAhead: this.options.bufferAhead,
      hasNextVideo: false,
      hasPrevVideo: false,
      seriesEnd: false,
      fullscreen: false,
      miniplayer: false,
      windowedFullscreen: false,
      // The browser window made fullscreen for the next episode (carryFullscreen).
      carriedFullscreen: false,
      autoPlayTriggered: false,
    };

    this._needsUserInteraction = false;

    this.progressMemory = null;
    this.playerLoader = new PlayerLoader();
    this.levelManager = new LevelManager(this);
    this.interfaceController = new InterfaceController(this);
    this.keybindManager = new KeybindManager(this);
    this.frameStepper = new FrameStepper();
    this.downloadManager = new DownloadManager(this);
    // Other FastStream players: a watched one short of video gets the network; background tabs download in turns.
    this.peers = new PlayerPeers({
      state: () => this.peerState(),
      onChange: () => this.applyPeers(),
    });
    this.peers.start();
    this.onPeersVisibility = () => this.updatePeers();
    document.addEventListener('visibilitychange', this.onPeersVisibility);
    this.sourcesBrowser = new SourcesBrowser(this);
    this.vpnPrompt = new VpnPrompt(this);
    this.audioAnalyzer = new AudioAnalyzer(this);
    this.frameExtractor = new PreviewFrameExtractor(this);
    if (EnvUtils.isWebAudioSupported()) {
      /** @type {AudioOutput} */
      this.audioOutput = new AudioOutput();
      this.audioOutputDevice = new AudioOutputDevice({load: (key) => Utils.getConfig(key), save: (key, value) => Utils.setConfig(key, value)});
      this.audioOutput.onChannelCount = (count) => this.audioOutputDevice?.setChannelCount(count);
      this.audioOutputDevice.onGone = (choice) => this.audioOutputFailed(choice, 'player_audio_output_failed');
      this.audioOutputDevice.onChange = () => this.interfaceController.setStatusMessage(StatusTypes.AUDIO_OUTPUT, null);
      /** @type {AudioContext|null|undefined} */
      this.audioContext = new AudioContext();
      this.audioOutput.setupNodes(this.audioContext);
    }

    // On the document, as the keybinds are: Escape must work with the focus on <body>.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.escapeAll();
        e.preventDefault();
      }
    });

    this.player = null;
    this.syncedAudioPlayer = null;
    this.previewPlayer = null;
    this.artworkTaken = false;
    /** @type {?number} */
    this.artworkAt = null;
    this.droppedFrameWatch = new DroppedFrameWatch();
    this.droppedSampledAt = 0;
    /** @type {Promise<void>|null} */
    this.sourceChange = null;
    this.sourceRequests = 0;
    /** @type {{request: number, sources: VideoSource[], next?: VideoSource, skipRemembered?: boolean}} */
    this.fallbacks = {request: 0, sources: []};
    this.carriedDecodeFailures = null;
    this.playedSource = null;
    /** @type {{url: ?string, times: number[]}} */
    this.recoveries = {url: null, times: []};
    /** @type {{identifier: ?string, times: number[], asking: boolean, playing?: boolean}} */
    this.linkRenewals = {identifier: null, times: [], asking: false};
    /** @type {?{page: string, identifier: string}} */
    this.bufferPage = null;
    /** @type {?{taken: number, of: number}} */
    this.bufferTakenBack = null;
    this.lastDecodeFailure = null;
    this.previewPlayerSetup = null;
    this.playPauseTurn = 0;
    /** @type {AudioContext|null} */
    this.startingAudioContext = null;
    this.saveSeek = true;
    /** @type {number[]} */
    this.pastSeeks = [];
    /** @type {number[]} */
    this.pastUnseeks = [];
    // Each level's fragments by sn, by level ID; also read with a null level ID (see the casts).
    /** @type {Object<string, Array<Fragment> & {snBase?: number}>} */
    this.fragmentsStore = {};
    /** @type {string|null} */
    this.playedDirectly = null;
    // The source whose own start time is still to be applied: nothing plays before it is.
    this.startPending = null;
    this.mainloop();
  }

  /** @return {LevelManager} */
  getLevelManager() {
    return this.levelManager;
  }

  /** @return {Promise<void>} */
  async setup() {
    if (SecureMemory.isSupported()) {
      const progressMemory = new SecureMemory('faststream-progress', {maxAgeMs: PROGRESS_MAX_AGE_MS});
      try {
        await progressMemory.setup();
        this.progressMemory = progressMemory;
      } catch (e) {
        console.warn('Failed to setup secure progress memory', e);
      }
    }

    if (this.progressMemory) {
      this.scheduleProgressPrune();
    }

    try {
      Utils.loadAndParseOptions('toolSettings', DefaultToolSettings).then((settings) => {
        this.options.toolSettings = /** @type {Object<string, ToolSetting>} */ (settings);
        this.interfaceController.updateToolVisibility();
      }).catch((e) => console.error('Loading the tool settings failed', e));
    } catch (e) {
      console.error(e);
    }
  }

  /** @return {Promise<Object|null>} */
  pollPrevNext() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({type: MessageTypes.REQUEST_PLAYLIST_POLL}, (response) => {
        // 'error': the background knows no page for this player, which says nothing about the next video.
        if (!response || typeof response !== 'object') {
          resolve(null);
          return;
        }
        this.state.seriesEnd = !!response.seriesEnd;
        if (this.state.hasNextVideo !== response.next || this.state.hasPrevVideo !== response.previous) {
          this.state.hasPrevVideo = response.previous;
          this.state.hasNextVideo = response.next;
          this.interfaceController.updateToolVisibility();
        }
        resolve(response);
      });
    });
  }

  setupPoll() {
    const count = 10;
    const initialTimeout = 500;
    const pollDurationLengthen = 1.2;

    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        this.pollPrevNext();
      }, initialTimeout * Math.pow(pollDurationLengthen, i));
    }
  }

  /** @return {boolean|undefined} Falsy for no; undefined without a source. */
  shouldDownloadAll() {
    return (this.options.downloadAll && this.hasDownloadSpace) || this.source?.loadedFromArchive;
  }

  userInteracted() {
    if (!this.state.hasUserInteracted) {
      this.state.hasUserInteracted = true;
      this.interfaceController.setStatusMessage(StatusTypes.REQINTERACTION, null);
    }
  }

  /**
   * Whether FastStream must wait for an interaction to download ahead; direct playback downloads nothing itself.
   * @return {boolean}
   */
  needsUserInteraction() {
    if (this.source && this.source.mode === PlayerModes.DIRECT) {
      return false;
    }

    return this._needsUserInteraction && !this.state.hasUserInteracted && !this.state.playing;
  }

  /** @param {boolean} value */
  setNeedsUserInteraction(value) {
    this._needsUserInteraction = value;
  }

  /** @param {boolean} value */
  setSeekSave(value) {
    this.saveSeek = value;
  }

  resetFailed() {
    for (const levelID in this.fragmentsStore) {
      if (Object.hasOwn(this.fragmentsStore, levelID)) {
        this.fragmentsStore[levelID].forEach((/** @type {Fragment} */ fragment) => {
          if (fragment.status === DownloadStatus.DOWNLOAD_FAILED) {
            fragment.status = DownloadStatus.WAITING;
          }
        });
      }
    }
    this.interfaceController.updateFragmentsLoaded();
  }

  /**
   * Deletes saved positions past their year, at most once a day and a while after start; until then an old
   * position reads as none (SecureMemory's maxAgeMs).
   */
  scheduleProgressPrune() {
    const last = Number(WebStorage.get('local', PROGRESS_PRUNED_KEY)) || 0;
    if (Date.now() - last < PROGRESS_PRUNE_EVERY_MS) return;
    this.progressPruneTimer = setTimeout(() => {
      const memory = this.progressMemory;
      if (!memory || this.destroyed) return;
      WebStorage.set('local', PROGRESS_PRUNED_KEY, String(Date.now()));
      memory.pruneOld(Date.now() - PROGRESS_MAX_AGE_MS);
    }, PROGRESS_PRUNE_DELAY_MS);
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.progressPruneTimer);
    document.removeEventListener('visibilitychange', this.onPeersVisibility);
    this.peers.stop();
    // The download manager goes once the reset is over, its disk files deleted first unless handed over (handOffBuffer).
    const downloadManager = this.downloadManager;
    this.resetPlayer().catch((e) => console.error('Could not reset the player as it went', e))
        .finally(() => downloadManager.destroy());
    this.interfaceController.destroy();
    if (this.progressMemory) {
      this.progressMemory.destroy();
      this.progressMemory = null;
    }
  }

  /**
   * Sets the player options; tool settings are loaded on their own (loadToolSettings).
   * @param {typeof import('./options/defaults/DefaultOptions.mjs').DefaultOptions & {toolSettings?: Object<string, ToolSetting>}} options
   */
  setOptions(options) {
    this.options.storeProgress = options.storeProgress;
    this.options.downloadAll = options.downloadAll;
    this.options.autoEnableBestSubtitles = options.autoEnableBestSubtitles;
    this.options.cycleSubtitles = !!options.cycleSubtitles;
    this.options.mpvMode = !!options.mpvMode;
    this.options.mpvPausePage = !!options.mpvPausePage;
    this.options.maxSpeed = options.maxSpeed;
    this.options.maxVideoSize = options.maxVideoSize;
    this.options.ramBudget = options.ramBudget;
    // Only the buffer: watch progress and saving keep their own storage.
    this.options.bufferToDisk = options.bufferToDisk !== false;
    this.options.bufferKeep = bufferKeepSeconds(options.bufferKeep);
    this.downloadManager?.setBufferToDisk(this.options.bufferToDisk);
    // Seconds; an empty field (-1) is no limit: the whole video ahead, everything played kept.
    this.options.bufferAhead = FastStreamClient.bufferSeconds(options.bufferAhead);
    this.options.bufferBehind = FastStreamClient.bufferSeconds(options.bufferBehind);
    // At once, as "Buffer ahead" is (updateHasDownloadSpace).
    this.state.bufferBehind = this.options.bufferBehind;
    this.options.seekStepSize = options.seekStepSize;
    this.options.singleClickAction = options.singleClickAction;
    this.options.doubleClickAction = options.doubleClickAction;
    this.options.tripleClickAction = options.tripleClickAction;
    this.options.visChangeAction = options.visChangeAction;
    this.options.miniSize = options.miniSize;
    this.options.miniPos = options.miniPos;
    this.options.maximumDownloaders = options.maximumDownloaders;

    const autoplayNext = WebStorage.get('session', 'autoplayNext');
    this.options.autoplayNext = autoplayNext !== null ? autoplayNext === 'true' : options.autoplayNext;
    // The next-episode banner's countdown (ProgressBar); 0 turns the banner off.
    this.options.autoplayCountdown = /** @type {{autoplayCountdown: number}} */ (options).autoplayCountdown;

    this.options.videoZoom = options.videoZoom;
    this.options.videoAspectRatio = options.videoAspectRatio || AspectRatios.AUTO;
    this.options.previewEnabled = options.previewEnabled;
    this.options.videoDelay = options.videoDelay;
    document.body.dataset.theme = options.colorTheme;
    WebStorage.set('local', 'faststream-color-theme', options.colorTheme);

    this.loadProgressData();

    if (this.options.previewEnabled) {
      this.setupPreviewPlayer().catch((e) => {
        console.error(e);
      });
    } else {
      // Its context too, or the next preview's replaces it undestroyed.
      if (this.previewContext) {
        this.previewContext.destroy();
        this.previewContext = null;
      }
      if (this.previewPlayer) {
        this.previewPlayer.destroy();
        this.previewPlayer = null;
        this.interfaceController.resetPreviewVideo();
      }
    }

    this.options.defaultQuality = options.defaultQuality;
    // Read by LevelManager at the next pick; what is playing keeps its version.
    this.options.decodingAwareQuality = options.decodingAwareQuality !== false;
    this.options.lowerOnDroppedFrames = options.lowerOnDroppedFrames !== false;

    this.updateVideoTransform();

    if (options.keybinds) {
      this.keybindManager.setKeybinds(options.keybinds);
    }

    if (this.state.miniplayer) {
      this.interfaceController.requestMiniplayer(true);
    }

    if (options.toolSettings) {
      this.options.toolSettings = options.toolSettings;
    }

    // Always: MPV mode may have changed while a video is open, and it gates the mpv button.
    this.interfaceController.updateToolVisibility();

    this.updateHasDownloadSpace();
    this.interfaceController.updateAutoNextIndicator();

    this.syncedAudioPlayer?.setVideoDelay(this.options.videoDelay);
  }

  /** Applies the zoom, flip, rotation and aspect ratio to the video elements. */
  updateVideoTransform() {
    const transformStr = VideoTransformUtils.getTransformString(this.options);
    const aspect = VideoTransformUtils.getAspectRatioStyles(this.options);

    for (const player of [this.player, this.previewPlayer]) {
      if (!player) continue;
      const video = player.getVideo();
      video.style.transform = transformStr;
      video.style.objectFit = aspect.objectFit;
      video.style.aspectRatio = aspect.aspectRatio;
      // The box of that shape (fluidplayer.css .fixed-aspect-ratio).
      video.style.setProperty('--video-aspect-ratio', aspect.aspectRatio);
      video.classList.toggle('fixed-aspect-ratio', !!aspect.aspectRatio);
    }
  }

  clearSubtitles() {
    this.interfaceController.subtitlesManager.clearTracks();
  }

  /**
   * Changes with every clearSubtitles: subtitles fetched across one are the video before's.
   * @return {number}
   */
  get subtitlesGeneration() {
    return this.interfaceController.subtitlesManager.openSubtitlesSearch.downloadGeneration;
  }

  /**
   * @param {import('./SubtitleTrack.mjs').SubtitleTrack} subtitleTrack
   * @param {boolean} [autoset=false]
   * @return {import('./SubtitleTrack.mjs').SubtitleTrack} The track listed: the same one listed before, or this one.
   */
  loadSubtitleTrack(subtitleTrack, autoset = false) {
    return this.interfaceController.subtitlesManager.loadTrackAndActivateBest(subtitleTrack, autoset);
  }

  updateDuration() {
    this.interfaceController.durationChanged();
    this.updateHasDownloadSpace();
  }

  /** @param {number} time */
  updateTime(time) {
    this.state.currentTime = time;
    this.interfaceController.timeUpdated();

    // Not for a live stream: its times mean nothing the next time it is opened.
    if (this.options.storeProgress && this.progressData && time !== this.progressData.lastTime && !this.disableProgressSave &&
      !this.isLive()) {
      const now = Date.now();
      if (now - /** @type {number} */ (this.lastProgressSave) > 1000) {
        this.lastProgressSave = now;
        this.progressData.lastTime = time;
        this.saveProgressData();
      }
    }
  }

  /** @param {number} time */
  seekPreview(time) {
    if (this.previewPlayer) {
      this.previewPlayer.currentTime = time;
      this.updatePreview();
    }
  }

  hidePreview() {
    if (this.previewPlayer) {
      this.previewPlayer.getVideo().style.opacity = /** @type {any} */ (0);
      clearTimeout(this.previewPlayerLoadingTimeout);
      this.previewPlayerLoadingTimeout = setTimeout(() => {
        // previewPlayer can go null (resetPlayer, destroy) while this debounce is pending.
        if (this.previewPlayer && parseFloat(this.previewPlayer.getVideo().style.opacity) === 0) {
          DOMElements.seekPreviewVideo.classList.add('loading');
        }
      }, 200);
    }
  }

  showPreview() {
    if (this.previewPlayer) {
      this.previewPlayer.getVideo().style.opacity = /** @type {any} */ (1);
      DOMElements.seekPreviewVideo.classList.remove('loading');
      clearTimeout(this.previewPlayerLoadingTimeout);
    }
  }

  updatePreview() {
    if (!this.previewPlayer) return;

    // Shown at once only when the element is at the preview's time: an MP4 preview can hold a place it has not reached.
    const video = this.previewPlayer.getVideo();
    if (video.readyState > 1 && this.previewPlayer.currentTime === video.currentTime) {
      this.showPreview();
      return;
    }

    let shouldShowPreview = false;
    const time = this.previewPlayer.currentTime;
    const buffered = this.previewPlayer.buffered;
    for (let i = 0; i < buffered.length; i++) {
      if (time >= buffered.start(i) && time <= buffered.end(i)) {
        shouldShowPreview = true;
        break;
      }
    }

    if (shouldShowPreview) {
      this.showPreview();
    } else {
      this.hidePreview();
    }
  }

  updateQualityLevels() {
    this.interfaceController.updateQualityLevels();
    this.interfaceController.updateLanguageTracks();
    this.updateHasDownloadSpace();
  }

  /**
   * @param {string} type - 'video' or 'audio'.
   * @param {string} language
   */
  changeLanguage(type, language) {
    const levels = type === 'video' ? this.getVideoLevels() : this.getAudioLevels();
    if (!levels) return;
    const currentLevelID = type === 'video' ? this.getCurrentVideoLevelID() : this.getCurrentAudioLevelID();
    const currentLevel = levels.get(/** @type {string} */ (currentLevelID));
    const matchingLevels = Array.from(levels.values()).filter((level) => level.language === language);
    if (matchingLevels.length === 0) {
      console.warn('No matching levels for language', language, type, levels);
      return;
    }

    if (type === 'video') {
      this.levelManager.setCurrentVideoLanguage(language);
    } else {
      this.levelManager.setCurrentAudioLanguage(language);
    }

    const chosen = type === 'video' ?
      this.levelManager.pickVideoLevel(/** @type {import('./players/Levels.mjs').VideoLevel[]} */ (matchingLevels), /** @type {import('./players/Levels.mjs').VideoLevel|undefined} */ (currentLevel)?.height) :
      this.levelManager.pickAudioLevel(/** @type {import('./players/Levels.mjs').AudioLevel[]} */ (matchingLevels));

    console.log('changeLanguage chosen level', chosen, type, language);
    if (chosen) {
      if (type === 'video') {
        this.setCurrentVideoLevelID(chosen.id);
      } else {
        this.setCurrentAudioLevelID(chosen.id);
      }
    }
  }

  /**
   * The seconds ahead of the playhead that fit in RAM next to those kept behind it.
   * @param {number} room - Bits; Infinity for no limit.
   * @param {number} bitrate - Bits per second; unknown (0, NaN) fits anything.
   * @return {number}
   */
  ramAheadSeconds(room, bitrate) {
    if (room === 0) return 0;
    if (!Number.isFinite(room) || !(bitrate > 0)) return Infinity;
    // What is kept behind is let go of first (MemoryBudget.chooseToRelease): it takes nothing from the room ahead.
    return Math.floor(room / bitrate / 1.1);
  }

  /**
   * The RAM budget for all players, and this player's share of it (MemoryBudget.shareOf).
   * @return {{budget: number, share: number}} Bytes; Infinity for no limit.
   */
  memoryShare() {
    // -1 (an empty field) is no limit, and 0 none; anything else unreadable is the default.
    const setting = this.options.ramBudget;
    const budget = setting < 0 ? Infinity : Number.isFinite(setting) ? setting : DEFAULT_BUDGET_BYTES;
    if (!this.peers) return {budget, share: budget};
    const watched = this.peers.visible() && !!this.state.playing;
    const others = this.peers.livePeers().map((peer) => ({
      ramBytes: peer.ramBytes,
      weight: weightOf(peer.visible && peer.playing),
    }));
    return {budget, share: shareOf(budget, weightOf(watched), others)};
  }

  updateHasDownloadSpace() {
    const levels = this.getVideoLevels();
    if (!levels) return;

    const currentVideoLevelID = this.getCurrentVideoLevelID();
    const level = levels.get(/** @type {string} */ (currentVideoLevelID));
    if (!level) return;

    if (this.source?.loadedFromArchive) {
      return;
    }

    let bitrate = level.bitrate;
    const fragments = this.fragments;
    if (fragments) {
      bitrate = Utils.measuredBitrate(fragments) ?? bitrate;
    }
    // A separate audio track (DASH, HLS with its own audio) is held beside the video: fitted on the video alone, the
    // two outgrew the RAM budget, which let go of what predownload fetched again, round and round.
    const audioLevelID = this.getCurrentAudioLevelID();
    const audioFragments = this.audioFragments;
    if (bitrate && audioFragments && audioLevelID !== currentVideoLevelID) {
      const audioLevel = this.getAudioLevels().get(/** @type {string} */ (audioLevelID));
      bitrate += Utils.measuredBitrate(audioFragments) ?? audioLevel?.bitrate ?? 0;
    }
    // With nothing on disk (a private window, "Keep video on disk" off, or no disk backend: FSBlob.diskGone),
    // what is kept must fit in this player's RAM share below MemoryBudget.LOW, or it is fetched again and again.
    const diskGone = this.downloadManager?.blobStore?.diskGone === true;
    if (diskGone && !this.diskGoneSaid) {
      this.diskGoneSaid = true;
      this.interfaceController.setStatusMessage(StatusTypes.INFO, Localize.getMessage('player_outofstorage'), 'warning', 10000);
    }
    const incognito = EnvUtils.isIncognito();
    const ramOnly = incognito || this.options.bufferToDisk === false || diskGone;
    // Bits: RAM is filled first, and the disk takes only what goes beyond this player's share.
    const ramShare = this.memoryShare().share * 8 * LOW;
    const ramRoom = ramOnly ? ramShare : Infinity;

    // "Buffer ahead" decides on every tick where the room does not; the RAM fit only lowers it.
    if (this.isLive()) {
      // A live stream has no size to fit, and is freed behind playback.
      this.state.bufferAhead = this.options.bufferAhead;
      this.hasDownloadSpace = false;
    } else if (bitrate && this.duration) {
      // The RAM share, and with a disk 60 % of its free quota too: a small quota (Firefox's is a tenth of the
      // device's storage) left no room for a video the RAM budget holds.
      const room = ramOnly ? ramShare : ramShare + (/** @type {number} */ (this.storageAvailable) * 8) * 0.6;
      // 0 is a limit too: nothing predownloaded (an empty field, -1, is none).
      const capped = this.options.maxVideoSize >= 0 && this.options.maxVideoSize * 8 < room;
      const storageAvailable = capped ? this.options.maxVideoSize * 8 : room;

      const canBufferTime = storageAvailable / bitrate / 1.1;
      let bufferAhead = Math.max(Math.floor(canBufferTime - this.state.bufferBehind), 0);

      if (bufferAhead < this.options.bufferAhead || !this.options.downloadAll) {
        this.state.bufferAhead = this.options.bufferAhead;
        bufferAhead = 0;
      } else if (bufferAhead > 0 && Math.abs(this.state.bufferAhead - bufferAhead) > 30) {
        this.state.bufferAhead = Math.max(bufferAhead, this.options.bufferAhead);
      }

      const newHasDownloadSpace = (bitrate * this.duration) * (this.hasDownloadSpace ? 1 : 1.1) < storageAvailable;
      // Only with predownload on: without it the maximum size is not used.
      if (!newHasDownloadSpace && this.hasDownloadSpace && this.options.downloadAll) {
        // Storage ran out mid-session: what is downloaded is grandfathered, so the window only holds back new downloads.
        // With nothing on disk, nothing is pinned: the RAM budget could not let go of it.
        /** @param {Fragment} frag */
        const grandfather = (frag) => {
          if (frag && frag.status === DownloadStatus.DOWNLOAD_COMPLETE) {
            frag.addReference(ReferenceTypes.GRANDFATHERED);
          }
        };
        // The quality on now may have no fragments yet (just switched to)
        if (fragments && !ramOnly) fragments.forEach(grandfather);
        if (this.audioFragments && !ramOnly) this.audioFragments.forEach(grandfather);
        // Once per video: a bitrate that moves (measured, another quality) crosses the line again and again.
        const warning = this.roomWarnedFor === this.source ? null : this.roomWarning({
          capped, incognito, diskGone, ramShare, room,
          ahead: Math.min(this.state.bufferAhead, this.ramAheadSeconds(ramRoom, bitrate)),
          size: bitrate * this.duration / 8,
        });
        if (warning) {
          this.roomWarnedFor = this.source;
          this.interfaceController.setStatusMessage(StatusTypes.INFO, warning, 'info', 12000);
        }
      }
      this.hasDownloadSpace = newHasDownloadSpace || !this.options.downloadAll;
    } else {
      this.state.bufferAhead = this.options.bufferAhead;
      this.hasDownloadSpace = true;
    }

    // Ahead, too, only what fits in RAM.
    if (ramOnly && this.state.bufferAhead > this.ramAheadSeconds(ramRoom, bitrate)) {
      this.state.bufferAhead = this.ramAheadSeconds(ramRoom, bitrate);
    }
  }

  /**
   * Why a video is not predownloaded whole, and what would change it: a setting, a private window or the disk.
   * Each says the video plays as usual: read as an error, the old "does not fit in the limits" became an issue.
   * @param {{capped: boolean, incognito: boolean, diskGone: boolean, ramShare: number, room: number,
   *   ahead: number, size: number}} why - ramShare and room (what the video may fill) in bits, ahead in seconds,
   *   size in bytes.
   * @return {?string} Null for a maximum size of 0 (nothing predownloaded, as asked) and for no disk backend
   *   (player_outofstorage said it).
   */
  roomWarning({capped, incognito, diskGone, ramShare, room, ahead, size}) {
    // Nothing kept ahead (a RAM share or buffer setting of 0): "plays normally" would not hold, and the options page
    // already warns about that 0.
    if (!Number.isFinite(ahead) || ahead <= 0) return null;
    const video = StringUtils.formatSize(size);
    const kept = StringUtils.formatDuration(ahead);
    if (capped) {
      if (this.options.maxVideoSize === 0) return null;
      return Localize.getMessage('player_buffer_size_warning', [video, StringUtils.formatSize(this.options.maxVideoSize), kept]);
    }
    if (incognito) {
      return Localize.getMessage('player_buffer_private_warning', [video, StringUtils.formatSize(ramShare / 8), kept]);
    }
    if (diskGone) return null;
    if (this.options.bufferToDisk === false) {
      return Localize.getMessage('player_buffer_ram_warning', [video, StringUtils.formatSize(ramShare / 8), kept]);
    }
    // What the video may fill (the RAM share and 60 % of the quota), not the whole quota: a video between the two was
    // "larger" than a bigger number.
    return Localize.getMessage('player_buffer_disk_warning', [video, StringUtils.formatSize(room / 8), kept]);
  }

  /**
   * Adds a new source and optionally sets it as current.
   * @param {VideoSource} source
   * @param {boolean} [setSource=false]
   * @param {VideoSource[]} [fallbacks=[]] - When it is set: the streams to try should it fail before showing anything.
   * @return {Promise<VideoSource>} The added source.
   */
  async addSource(source, setSource = false, fallbacks = []) {
    source = source.copy();

    // Never the source itself: its headers hold the page's Cookie and Authorization.
    console.log('addSource', source.url, source.mode);
    source = this.sourcesBrowser.addSource(source);
    if (setSource) {
      await this.setSource(source, fallbacks);
    }
    this.sourcesBrowser.updateSources();
    return source;
  }

  /** @param {boolean} value */
  setAutoPlay(value) {
    console.log('setAutoPlay', value);
    this.options.autoPlay = value;
  }

  /** @return {Promise<void>} */
  async setupPreviewPlayer() {
    if (!this.player || this.previewPlayer || !this.options.previewEnabled) {
      return;
    }

    // Callers join a running build: a second one would leave a second video in the seek preview.
    if (!this.previewPlayerSetup) {
      const setup = this.buildPreviewPlayer();
      this.previewPlayerSetup = setup;
      setup.catch(() => {}).then(() => {
        // resetPlayer() may have handed the field to the next video's build already.
        if (this.previewPlayerSetup === setup) {
          this.previewPlayerSetup = null;
        }
      }).catch((e) => console.error(e));
    }

    return this.previewPlayerSetup;
  }

  /** @return {Promise<void>} */
  async buildPreviewPlayer() {
    const source = this.player.getSource();
    if (!source) {
      return;
    }

    const previewPlayer = (await this.playerLoader.createPlayer(source.mode, this, {
      isPreview: true,
    }));

    // Stored only once it is the preview shown.
    /** @type {?ReturnType<import('./modules/eventemitter.mjs').EventEmitter['createContext']>} */
    let context = null;
    try {
      await previewPlayer.setup();
      context = this.bindPreviewPlayer(previewPlayer);

      await previewPlayer.setSource(source);
      if (PreviewsFailedInBuild.has(previewPlayer)) throw new Error('The preview player failed while it was built');
    } catch (e) {
      // Nothing else holds it.
      context?.destroy();
      try {
        previewPlayer.destroy();
      } catch (destroyError) {
        console.warn('Could not destroy a preview player that failed to build', destroyError);
      }
      throw e;
    }

    // The source may be gone or replaced, or previews switched off, while the preview was built.
    if (this.previewPlayer || !this.options.previewEnabled || this.player?.getSource() !== source) {
      context.destroy();
      previewPlayer.destroy();
      return;
    }

    this.previewContext = context;
    this.previewPlayer = previewPlayer;
    this.interfaceController.addPreviewVideo(previewPlayer.getVideo());
    this.updateVideoTransform();
  }

  initiateWebAudio() {
    this.audioContext = new AudioContext();
    this.audioSource = this.audioContext.createMediaElementSource(this.player.getVideo());

    this.audioOutputNode = new VirtualAudioNode('mainSource');
    this.audioOutputNode.connectFrom(this.audioSource);

    this.audioAnalyzer.setupAnalyzerNodeForMainPlayer(this.player.getVideo(), this.audioOutputNode, this.audioContext, ()=>{
      return /** @type {HTMLVideoElement} */ (this.currentVideo).currentTime + this.options.videoDelay / 1000;
    });
    this.audioOutput.setupNodes(this.audioContext);
    /** @type {VirtualAudioNode} */ (this.audioOutput.getInputNode()).connectFrom(this.audioOutputNode);
    this.attachAudioOutputDevice();
  }

  /**
   * The video's sound to the output the user chose (AudioOutputDevice), or to the default one;
   * a device that is gone or not allowed leaves the default, and the status line says so.
   */
  attachAudioOutputDevice() {
    const output = /** @type {VirtualAudioNode} */ (this.audioOutput.getOutputNode());
    const device = this.audioOutputDevice;
    if (!device) {
      output.connect(/** @type {AudioContext} */ (this.audioContext).destination);
      return;
    }
    device.attach(/** @type {AudioContext} */ (this.audioContext), output).then(({failed}) => {
      // Firefox lets a page use a device only once chosen in that very page, and the chooser only from a click.
      if (failed) this.audioOutputFailed(failed, 'player_audio_output_again');
      this.interfaceController.updateAudioOutputs?.();
    }).catch((e) => console.warn('The audio output was not set', e));
  }

  /**
   * The chosen device does not play the sound: it plays on the default, the status line says so, and a click
   * on it opens Firefox's chooser.
   * @param {import('./ui/audio/AudioOutputDevice.mjs').OutputChoice} choice
   * @param {string} key - player_audio_output_again (a new video) or _failed (it went away).
   */
  audioOutputFailed(choice, key) {
    const device = this.audioOutputDevice;
    const name = choice.label || Localize.getMessage('player_audio_output_device');
    this.interfaceController.setStatusMessage(StatusTypes.AUDIO_OUTPUT, Localize.getMessage(key, [name]), 'warning', 15000, () => {
      // In the click itself: Firefox's chooser needs it.
      device?.choose().then(() => this.interfaceController.updateAudioOutputs?.(),
          (e) => this.interfaceController.audioOutputRefused(e));
    });
    this.interfaceController.updateAudioOutputs?.();
  }

  /**
   * Sets the current source and initializes the player. Sources are set one at a time: two setups at once
   * would each leave a video in the page and an audio context.
   * @param {Object} source - A VideoSource, typed Object for VpnPrompt; cast where used.
   * @param {VideoSource[]} [fallbacks=[]] - The streams to try should it fail before showing anything; none for a hand-picked source.
   * @param {SourceStart} [start={}] - How it starts, kept with this request.
   * @return {Promise<void>}
   */
  setSource(source, fallbacks = [], start = {}) {
    const request = ++this.sourceRequests;
    // A DIRECT source (a hand-over to Firefox's own player) keeps playedDirectly.
    if (/** @type {VideoSource} */ (source)?.mode !== PlayerModes.DIRECT) {
      this.playedDirectly = null;
    }
    // A request made while this one waited its turn replaces it before it builds anything.
    const run = () => request !== this.sourceRequests ? Promise.resolve() :
      this.setSourceInternal(/** @type {VideoSource} */ (source), {request, sources: fallbacks.slice()}, start);
    const change = this.sourceChange ? this.sourceChange.then(run, run) : run();

    this.sourceChange = change;
    change.catch(() => {}).then(() => {
      if (this.sourceChange === change) {
        this.sourceChange = null;
      }
    }).catch((e) => console.error(e));

    return change;
  }

  /**
   * Sets the current source and initializes the player, one at a time.
   * @param {VideoSource} source
   * @param {{request: number, sources: VideoSource[], skipRemembered?: boolean}} fallbacks - Which request this is, and the streams to try should it fail before showing anything.
   * @param {SourceStart} [start={}] - See setSource().
   * @return {Promise<void>}
   */
  async setSourceInternal(source, fallbacks, start = {}) {
    // Whether the player took the source: a throw before that is a stream that failed.
    let taken = false;
    /** @type {*} */
    let built = null;
    try {
      source = source.copy();

      /** @type {string|number|null} */
      let timeFromURL = URLUtils.get_param(source.url, 'faststream-timestamp');
      timeFromURL = parseInt(/** @type {string} */ (timeFromURL));

      if (isNaN(timeFromURL)) {
        timeFromURL = null;
      }

      // The timestamp comes off the URL, the rest untouched (URLUtils.withTimestamp).
      if (timeFromURL !== null) {
        source.url = URLUtils.withTimestamp(source.url, null);
      }

      // The page address's time is for the video it was opened for, used up once applied (a fallback still gets it).
      let timeFromPage = false;
      if (timeFromURL === null && !this.pageTimestampUsed) {
        timeFromURL = URLUtils.get_param(window.location.href, 'faststream-timestamp');
        timeFromURL = parseInt(/** @type {string} */ (timeFromURL));
        timeFromPage = true;
      }


      const autoPlay = this.options.autoPlay;
      // For this source only: one picked by hand later starts at its remembered time again.
      const skipRemembered = !!this.options.disableLoadProgress || !!start.skipRemembered;
      this.options.disableLoadProgress = false;
      fallbacks.skipRemembered = skipRemembered;
      if (start.keepStorage) this.downloadManager.keepStorageOnce();
      if (start.relink) this.downloadManager.relink(start.relink.from, start.relink.to);
      if (start.keepChoice) this.droppedFrameWatch.keepChoiceOnce();

      console.log('setSource', source.url, source.mode); // no headers: see addSource
      await this.resetPlayer();
      if (!start.rebuild) this.playedSource = null;
      this.restoreCarriedDecodeFailures(source);
      this.source = source;
      // Loaded through the asking frame (else the player's page) when FastStream itself is refused.
      PageFetch.configure(this.page && source.url.startsWith('http') ?
        {tabId: this.page.tabId, frameId: source.pageFrameId ?? this.page.frameId} : null);
      StreamQuery.configure(source.url.startsWith('http') ? source.url : null);
      // A start time the source came with is armed here, before the awaits: nothing plays before it is applied,
      // or a canplay meanwhile autoplays from 0 and the time jumps later.
      const startTime = timeFromURL || 0;
      // The same video built again (another quality, a recovery) after it had started, by autoplay or by the user:
      // paused since, it stays paused. One that never started (autoplay blocked, nobody pressed play) still autoplays.
      const keptPause = start.play === false && this.state.autoPlayTriggered;
      const playOnStart = (autoPlay && !keptPause) || !!start.play;
      // The remembered time is a start time too, once looked up.
      const remembered = !startTime && !skipRemembered && !!this.options.storeProgress && !!this.progressMemory;
      this.startPending = startTime || remembered ? source : null;
      // Kept: canplay's autoplay must not undo the pause either.
      this.state.autoPlayTriggered = keptPause;
      // Only once the last player is torn down: its failure is not this source's.
      this.fallbacks = fallbacks;
      // Through Firefox VPN, which leaves FastStream's requests out? (VpnPrompt.mjs)
      this.vpnPrompt?.check(source);

      if (source.defaultLevelInfo?.level !== undefined) {
        this.getLevelManager().setCurrentVideoLevelID(source.defaultLevelInfo.level);
      }

      // audioLevel, as an archive's source has it (SaveManager).
      if (source.defaultLevelInfo?.audioLevel !== undefined) {
        this.getLevelManager().setCurrentAudioLevelID(source.defaultLevelInfo.audioLevel);
      }

      this.storageAvailable = await EnvUtils.getAvailableStorage();
      // What an earlier player of this video on this page downloaded (handOffBuffer), before anything is asked for.
      await this.takeBackBuffer(source);

      const options = {};
      built = await this.playerLoader.createPlayer(source.mode, this, options);
      this.player = built;

      await this.player.setup();

      this.bindPlayer(this.player);

      if (!this.initPromise) {
        const hook = this.setupInitHook();
        this.initPromise = hook;
        hook.then(() => {
          // The next source's may be in the field by then.
          if (this.initPromise === hook) {
            this.initPromise = null;
          }
        }).catch((e) => console.error(e));
      }


      await this.player.setSource(source);
      taken = true;
      this.interfaceController.addVideo(this.player.getVideo());
      this.frameStepper.watch(this.player.getVideo());

      if (EnvUtils.isWebAudioSupported()) {
        this.initiateWebAudio();
      }

      this.syncedAudioPlayer = new SyncedAudioPlayer(this);
      this.syncedAudioPlayer.setPlaybackRate(this.state.playbackRate);
      await this.syncedAudioPlayer.setup(this.audioContext, this.audioSource, this.audioOutputNode);
      this.syncedAudioPlayer.setVideoDelay(this.options.videoDelay);

      this.setVolume(this.state.volume);

      this.player.playbackRate = this.state.playbackRate;

      this.setSeekSave(false);
      this.currentTime = 0;
      this.setSeekSave(true);

      if (this.player.getSource()) {
        // The seek preview is an extra: its failure must not cost the video its setup.
        await this.setupPreviewPlayer().catch((e) => {
          console.warn('The preview player failed to build', e);
        });

        this.frameExtractor.updateBackground();
      }

      this.updateVideoTransform();

      this.interfaceController.updateToolVisibility();

      if (playOnStart && !this.startPending && !this.state.autoPlayTriggered) {
        this.play().then(() => {
          if (this.source === source) this.state.autoPlayTriggered = true;
        }).catch((e) => console.warn('Autoplay failed', e));
      }

      // A time of its own does not wait for the remembered one (two PBKDF2 hashes) it overrides.
      const lookup = startTime ? Promise.resolve() : this.loadProgressData();
      (remembered ? Promise.race([lookup, new Promise((resolve) => setTimeout(resolve, RememberedWaitMs))]) : lookup).then(async () => {
        // Another source came in meanwhile: its saving must not be switched off here.
        if (this.source !== source) return;
        this.disableProgressSave = true;

        if (this.initPromise) {
          await this.initPromise;
        }
        // The wait ends when whichever player is current is ready: maybe the next source's.
        if (this.source !== source) return;

        if (startTime) {
          if (timeFromPage) this.pageTimestampUsed = true;
          this.setSeekSave(false);
          this.currentTime = startTime;
          this.setSeekSave(true);
        } else if (this.options.storeProgress && !skipRemembered) {
          const applyRemembered = () => {
            const lastTime = this.progressData?.lastTime;
            // Not a live stream: a DASH live duration is Infinity. Not over a seek of the user's: an MP4's duration,
            // and with it the seek bar, comes before the player is ready.
            if (lastTime && !this.isLive() && lastTime < this.duration - 5 && this.pastSeeks.length === 0) {
              this.setSeekSave(false);
              this.currentTime = lastTime;
              this.setSeekSave(true);
              this.interfaceController.setStatusMessage(StatusTypes.RESUMED, resumedMessage(lastTime,
                  this.keybindManager?.keybindMap), 'info', 5000);
            }
          };
          if (this.progressData) {
            applyRemembered();
          } else if (remembered) {
            // Past the wait: applied when it comes, unless the user has sought meanwhile.
            lookup.then(() => {
              if (this.source === source) applyRemembered();
            }).catch(() => {});
          }
        }
        this.startPending = null;

        this.disableProgressSave = false;
        if (startTime) {
          this.loadProgressData();
        }

        if (playOnStart && !this.state.autoPlayTriggered) {
          this.play().then(() => {
            if (this.source === source) this.state.autoPlayTriggered = true;
          }).catch((e) => console.warn('Autoplay failed', e));
        }
      }).catch((e) => {
        console.error('Applying the remembered time failed', e);
        // Saving was switched off while the time was applied.
        if (this.source === source) {
          this.disableProgressSave = false;
          this.startPending = null;
        }
      });
    } catch (e) {
      AlertPolyfill.errorSendToDeveloper(/** @type {Error} */ (e));
      console.error(e);
      // The player built here was never handed the source: destroyed, unless a newer source replaced it.
      if (!taken && built) {
        try {
          built.destroy();
        } catch (destroyError) {
          console.warn('Could not destroy a player that failed to set up', destroyError);
        }
        if (this.player === built) {
          this.player = null;
          // Its listeners and its wait for a picture: no reset follows the load error.
          this.context?.destroy();
          this.context = null;
          this.initPromise = null;
          clearInterval(this.initHookInterval);
        }
      }
      // Its player could not be built or take the source: the next fallback plays (tryNextSource), else the load error.
      if (!taken && this.fallbacks === fallbacks && fallbacks.request === this.sourceRequests && !this.tryNextSource()) {
        this.failedToLoad(this.loadErrorMessage());
      }
    }

    DOMElements.playerContainer.style.backgroundColor = 'black';

    this.emit('setsource', this);
  }


  /** @return {Promise<void>} */
  setupInitHook() {
    return new Promise((resolve) => {
      /** @type {ReturnType<typeof setInterval>|number} */
      let interval = 0;

      const hook = () => {
        if (!this.duration || !this.currentVideo || this.currentVideo.readyState === 0) return;
        clearInterval(interval);
        // A video plays: its player was bound (bindPlayer), and the context with it.
        /** @type {PlayerContext} */ (this.context).off(DefaultPlayerEvents.DURATIONCHANGE, hook);
        /** @type {PlayerContext} */ (this.context).off(DefaultPlayerEvents.LOADEDMETADATA, hook);
        resolve();
      };

      interval = setInterval(hook, 1000);
      // resetPlayer() stops it.
      this.initHookInterval = interval;

      // Set: setSourceInternal binds the player just before.
      /** @type {PlayerContext} */ (this.context).on(DefaultPlayerEvents.DURATIONCHANGE, hook);
      // On metadata too: MP4Player's duration comes before the first frame.
      /** @type {PlayerContext} */ (this.context).on(DefaultPlayerEvents.LOADEDMETADATA, hook);
      hook();
    });
  }

  /**
   * Loads progress data from secure memory; a caller while a lookup runs gets that lookup.
   * @return {Promise<void>}
   */
  loadProgressData() {
    if (this.progressLoad) {
      return this.progressLoad;
    }
    if (!this.options.storeProgress || !this.player || this.disableProgressSave || this.progressData || !this.progressMemory) {
      return Promise.resolve();
    }

    const load = this.progressLoad = this.readProgressData(this.player);
    const done = () => {
      if (this.progressLoad === load) {
        this.progressLoad = null;
      }
    };
    load.then(done, done);
    return load;
  }

  /**
   * Reads the remembered time of a player's source.
   * @param {Player} player
   * @return {Promise<void>}
   */
  async readProgressData(player) {
    // The lookup takes a while (two PBKDF2 hashes): no saving meanwhile, or another video's time lands in this record.
    this.disableProgressSave = true;
    /** @type {{identifierHash: ArrayBuffer, keyHash: ArrayBuffer}|null} */
    let hashes = null;
    /** @type {{lastTime: number}|null} */
    let progressData = null;
    try {
      hashes = await /** @type {SecureMemory} */ (this.progressMemory).getHashes(/** @type {VideoSource} */ (player.getSource()).identifier);
      if (this.player !== player) return;
      progressData = (await /** @type {SecureMemory} */ (this.progressMemory).getFile(hashes)) || {
        lastTime: 0,
      };
    } catch (e) {
      // An unreadable record is no remembered time; thrown on, it would stop the rest of the setup.
      console.warn('Could not read the remembered time', e);
      // A record that does not decrypt is lost: start at 0 and save over it. A failed read keeps no progress instead.
      progressData = hashes && /** @type {(Error & {unusableRecord?: boolean})|undefined} */ (e)?.unusableRecord ? {lastTime: 0} : null;
    }
    if (this.player !== player) return;
    this.progressHashesCache = hashes;
    this.progressData = progressData;
    this.disableProgressSave = false;
  }

  /** @return {Promise<void>} */
  async saveProgressData() {
    if (this.disableProgressSave || !this.progressData) {
      return;
    }

    // Called every second and never awaited: a failing write must not reject unhandled.
    try {
      await /** @type {SecureMemory} */ (this.progressMemory).setFile(this.progressHashesCache, this.progressData);
    } catch (e) {
      console.warn('Could not save the remembered time', e);
    }
  }

  /** @return {Fragment|null|undefined} None when nothing waits. */
  getNextToDownload() {
    const currentFragment = this.currentFragment;
    const audioFragment = this.currentAudioFragment;

    const nextVideo = this.getNextToDownloadTrack(currentFragment);
    const nextAudio = this.getNextToDownloadTrack(audioFragment);

    if (!nextVideo) {
      return nextAudio;
    }

    if (!nextAudio) {
      return nextVideo;
    }
    const diffV = Math.abs(nextVideo.start - this.state.currentTime);
    const diffA = Math.abs(nextAudio.start - this.state.currentTime);

    if (diffV < diffA) {
      return nextVideo;
    } else {
      return nextAudio;
    }
  }

  /**
   * @param {Fragment|null} currentFragment - The track's fragment playing, if any.
   * @return {Fragment|null|undefined} None when nothing of the track waits.
   */
  getNextToDownloadTrack(currentFragment) {
    if (!currentFragment) {
      return null;
    }

    const fragments = this.getFragments(currentFragment.level);
    if (!fragments) {
      return null;
    }

    const index = currentFragment.sn;

    const nextItem = this.getNextForward(fragments, index) || this.getNextBackward(fragments, index);

    return nextItem;
  }

  /**
   * @param {Array<Fragment>} fragments - A level's, by sn.
   * @param {number} index
   * @return {Fragment|undefined}
   */
  getNextForward(fragments, index) {
    for (let i = index; i < fragments.length; i++) {
      const fragment = fragments[i];
      if (fragment && fragment.status === DownloadStatus.WAITING) {
        return fragment;
      }
    }
    return undefined;
  }

  /**
   * @param {Array<Fragment>} fragments - A level's, by sn.
   * @param {number} index
   * @return {Fragment|undefined}
   */
  getNextBackward(fragments, index) {
    for (let i = index - 1; i >= 0; i--) {
      const fragment = fragments[i];
      if (fragment && fragment.status === DownloadStatus.WAITING) {
        return fragment;
      }
    }
    return undefined;
  }

  mainloop() {
    if (this.destroyed) return;
    setTimeout(this.mainloop.bind(this), 1000);

    if (this.needsUserInteraction()) {
      this.interfaceController.setStatusMessage(StatusTypes.REQINTERACTION, Localize.getMessage('player_needs_interaction'), 'warning clickable');
    } else {
      this.interfaceController.setStatusMessage(StatusTypes.REQINTERACTION, null);
    }

    this.updatePeers();
    this.enforceMemoryBudget();

    if (this.player) {
      this.updatePreview();
      this.predownloadFragments();

      if (!this.shouldDownloadAll()) {
        if (this.fragments) this.freeFragments(this.fragments);
        if (this.audioFragments) this.freeFragments(this.audioFragments);
      }
    }

    this.interfaceController.tick();
    this.checkLevelChange();
    this.updateHasDownloadSpace();
    if (this.syncedAudioPlayer) this.syncedAudioPlayer.watcherLoop();
    this.emit('tick', this);
  }

  /**
   * Seconds of video this player has ahead of the playhead, without a hole.
   * @return {number}
   */
  getVideoAhead() {
    return aheadOfPlayhead({
      video: this.fragments,
      audio: this.audioFragments,
      buffered: this.player?.buffered,
      time: this.state.currentTime,
    });
  }

  /**
   * Keeps this player's RAM-held video within its share of the RAM budget (MemoryBudget): over HIGH it lets go
   * down to LOW, furthest behind first, then furthest ahead, never the next seconds; to disk where it can.
   * Until then no downloads ahead start (DownloadManager.memoryFull).
   */
  enforceMemoryBudget() {
    // On the client's tick: a throw here skipped the rest of it, the downloads ahead with it.
    try {
      this.keepWithinMemoryBudget();
    } catch (e) {
      console.warn('Could not keep within the RAM budget', e);
    }
  }

  keepWithinMemoryBudget() {
    const manager = this.downloadManager;
    if (!manager?.blobStore || !this.peers) return;
    // A budget of 0 keeps nothing in RAM: all of it on disk (DISK_ONLY_ROOM_BYTES), or, with
    // nothing on disk, nothing ahead.
    const {budget, share} = this.memoryShare();
    const held = manager.ramBytes();
    const leaving = manager.spillingBytes();
    const toDisk = manager.canSpill();
    const room = budget === 0 && toDisk ? DISK_ONLY_ROOM_BYTES : share;
    manager.memoryFull = isFull(held, leaving, room, manager.memoryFull);
    // Let go down to LOW, not just under HIGH: downloads in flight land a little over LOW, and "full" must end.
    if (held - leaving <= share * (manager.memoryFull ? LOW : HIGH)) return;

    const time = this.state.currentTime;
    const current = this.currentFragment;
    const candidates = [];
    for (const fragments of Object.values(this.fragmentsStore || {})) {
      for (const fragment of fragments || []) {
        // Init segments (sn -1) every fragment of their level needs.
        if (!fragment || fragment.sn < 0 || fragment.status !== DownloadStatus.DOWNLOAD_COMPLETE) continue;
        // A grandfathered one may still go to disk, or RAM stays "full" for the rest of the video.
        if (!fragment.canFree() && !(toDisk && fragment.references.every((type) => type === ReferenceTypes.GRANDFATHERED))) continue;
        const bytes = manager.ramBytesOf(fragment.getContext());
        if (!(bytes > 0)) continue;
        // On its way to disk already, counted as leaving; chosen again, its spill would answer false and drop it.
        if (manager.isSpilling(fragment.getContext())) continue;
        let start = fragment.start;
        let end = fragment.end;
        if (!isTimed(fragment)) {
          // No times yet (a fragmented MP4 before parsing): placed by sn distance from the one playing; next to it, kept.
          // Never released, they would let a private window's RAM grow without bound.
          if (!current || current.level !== fragment.level || Math.abs(fragment.sn - current.sn) <= 2) continue;
          const distance = fragment.sn - current.sn;
          start = distance > 0 ? time + 1e7 + distance : time - 1e7 + distance;
          end = start;
        }
        candidates.push({fragment, start, end, bytes});
      }
    }
    const keep = toDisk ? KEEP_ON_DISK_WINDOW : KEEP_IN_RAM_ONLY_WINDOW;
    for (const {fragment} of chooseToRelease(candidates, time, keep, held - leaving - share * LOW)) {
      if (toDisk) {
        // One that cannot go to disk (the disk full) is let go of instead of staying in RAM; kept for good is kept on
        // disk, so with the disk full that goes too, or RAM stays full for the rest of the video.
        manager.spill(fragment.getContext()).then((stored) => {
          if (stored || fragment.status !== DownloadStatus.DOWNLOAD_COMPLETE || !(manager.ramBytesOf(fragment.getContext()) > 0)) {
            return;
          }
          if (fragment.references.length && fragment.references.every((type) => type === ReferenceTypes.GRANDFATHERED)) {
            fragment.removeReference(ReferenceTypes.GRANDFATHERED);
          }
          if (fragment.canFree()) this.freeFragment(fragment);
        }).catch((e) => console.warn('Could not write a fragment to disk', e));
      } else {
        this.freeFragment(fragment);
      }
    }
  }

  /** Tells the other players how this one is doing, and steps aside for them or not. */
  updatePeers() {
    if (this.destroyed || !this.peers) return;
    this.peers.announce();
    this.applyPeers();
  }

  /**
   * Steps aside for a watched player short of video (setYield), waits for its turn among background tabs
   * (setWaiting), or downloads.
   */
  applyPeers() {
    if (this.destroyed || !this.peers || !this.downloadManager) return;
    this.downloadManager.setYield?.(this.peers.shouldYield(), !this.state.playing);
    this.downloadManager.setWaiting?.(this.peers.shouldWait(), this.peers.waitHoldsPlayback());
  }

  /**
   * How this player is doing, for the other players (PlayerPeers).
   * @return {import('./network/PlayerPeers.mjs').OwnState}
   */
  peerState() {
    const manager = this.downloadManager;
    const ahead = this.getVideoAhead();
    const live = this.isLive();
    const duration = this.duration;
    return {
      playing: !!this.state.playing,
      ahead,
      ramBytes: manager?.ramBytes?.() || 0,
      live,
      buffering: !!this.state.buffering,
      // What there is beyond what it has; none for a live stream or a video without a length.
      room: !live && Number.isFinite(duration) && duration > 0 ? duration - this.state.currentTime - ahead : undefined,
      wants: this.wantsNetwork(),
      received: manager?.received?.() || 0,
      rate: this.videoRate(),
      shared: !manager?.limitedPerConnection?.(),
      host: manager?.lastHost || '',
      saving: !!this.interfaceController?.saveManager?.makingDownload,
    };
  }

  /**
   * Whether this player has video to download ahead that it would start now with the network to itself
   * (PlayerTurns); not a live stream, paused or limited downloads, or a used-up RAM share.
   * @return {boolean}
   */
  wantsNetwork() {
    const manager = this.downloadManager;
    if (this.destroyed || !this.player || !manager?.downloaders || manager.paused || manager.memoryFull) return false;
    if (!navigator.onLine || this.needsUserInteraction() || this.options.maxSpeed === 0 || this.isLive()) return false;
    if (manager.activeCount() > 0) return true;
    const next = this.getNextToDownload();
    if (!next) return false;
    // Placed as predownloadFragments places them, or a background player wants nothing it would download.
    if (next.canFree() && !this.shouldDownloadAll()) {
      const span = this.windowSpan(next, new Map());
      if (span && (span.start > this.state.currentTime + this.state.bufferAhead ||
          span.end < this.state.currentTime - this.state.bufferBehind)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Bytes a second this video plays at: measured, else its quality level's; 0 when neither is known.
   * @return {number}
   */
  videoRate() {
    let bitrate = this.fragments ? Utils.measuredBitrate(this.fragments) : null;
    if (!(Number(bitrate) > 0)) {
      const levels = this.getVideoLevels();
      const id = this.getCurrentVideoLevelID();
      bitrate = levels && id !== null && id !== undefined ? levels.get(/** @type {string} */ (id))?.bitrate ?? null : null;
    }
    return Number(bitrate) > 0 ? Number(bitrate) / 8 : 0;
  }

  /** Cancels the downloads ahead outside the next seconds around the playhead (PlayheadFirst). */
  cancelFarDownloads() {
    if (this.isLive() || !this.downloadManager) return;
    const time = this.state.currentTime;
    for (const fragments of [this.fragments, this.audioFragments]) {
      for (const fragment of downloadingOutside(fragments, time, KEEP_BEHIND_S, KEEP_AHEAD_S)) {
        // A fragment a save or the analyzer holds is theirs to finish.
        if (fragment.canFree()) this.downloadManager.cancelIfCheap(fragment.getContext());
      }
    }
  }

  /** @return {boolean} */
  predownloadFragments() {
    // The video waits: a seek, or playing without data ahead (LoopPace). During the speed test only a seek holds it.
    const video = this.currentVideo;
    const hasPlayed = !!video && video.played?.length > 0 && !this.isLive();
    const videoWaits = hasPlayed && (video.seeking || (!video.paused && video.readyState < 3));
    const seeks = hasPlayed && video.seeking;
    this.downloadManager.holdTest(seeks);

    // Another watched player needs the network (setYield), or it is another player's turn (setWaiting).
    if (this.downloadManager.yielding || this.downloadManager.waiting) {
      return false;
    }

    // Its share of the RAM budget is used up (enforceMemoryBudget).
    if (this.downloadManager.memoryFull) {
      return false;
    }

    // Short of video: the next seconds first, on few connections (PlayheadFirst).
    const wasConcentrating = this.concentrating;
    this.concentrating = shouldConcentrate(this.getVideoAhead(), !!this.concentrating);
    if (this.concentrating && !wasConcentrating) {
      this.cancelFarDownloads();
    }
    // While the video waits on a shared line, only playback's requests and the playhead's fragments download:
    // a download beside them halves their line. Only once it has played, and not where each connection has its own speed.
    const playheadOnly = videoWaits &&
      (this.downloadManager.sharesLine() || (seeks && this.downloadManager.testing));
    // A seek: the downloads ahead already running beside the playhead's fragment go as well.
    if (playheadOnly && seeks) {
      for (const fragment of besidePlayhead([this.fragments, this.audioFragments], this.state.currentTime)) {
        this.downloadManager.cancelIfCheap(fragment.getContext());
      }
    }

    if (!navigator.onLine) {
      return false;
    }

    if (this.needsUserInteraction()) {
      return false;
    }

    // A limit of 0 downloads nothing ahead; saves fetch their own and playback's requests still go.
    if (this.options.maxSpeed === 0) {
      return false;
    }
    const speed = this.downloadManager.getSpeed();
    if (this.options.maxSpeed > 0 && speed > this.options.maxSpeed) {
      return false;
    }

    let nextDownload = this.getNextToDownload();
    let hasDownloaded = false;
    let index = 0;
    /** @type {Map<string|number, Map<number, import('./network/UntimedSpans.mjs').Span>>} */
    const untimed = new Map();

    while (nextDownload) {
      if (nextDownload.canFree() && !this.shouldDownloadAll()) {
        // One without times and nothing to place it by is downloaded; the RAM budget lets go of it by distance.
        const span = this.windowSpan(nextDownload, untimed);
        if (span && span.start > this.state.currentTime + this.state.bufferAhead) {
          break;
        }

        if (span && span.end < this.state.currentTime - this.state.bufferBehind) {
          break;
        }
      }

      // (A live stream's fragments are placed on its own clock: no window there.)
      if (this.concentrating && (this.downloadManager.activeCount() >= this.downloadManager.urgentParallel() ||
          (!this.isLive() && nextDownload.start > this.state.currentTime + KEEP_AHEAD_S))) {
        break;
      }
      // Only the fragment the playhead is in; checked before each, as playback's request joins it once it asks.
      if (playheadOnly && (this.downloadManager.playbackAsked() || (isTimed(nextDownload) &&
          (nextDownload.start > this.state.currentTime + 0.1 || nextDownload.end <= this.state.currentTime)))) {
        break;
      }

      if (!this.downloadManager.canGetFile(nextDownload.getContext())) {
        break;
      }

      hasDownloaded = true;
      this.player.downloadFragment(nextDownload).catch((/** @type {unknown} */ e) => {

      });
      nextDownload = this.getNextToDownload();
      if (index++ > 10000) {
        throw new Error('Infinite loop detected');
      }
    }

    if (!hasDownloaded && this.interfaceController.saveManager.makingDownload) {
      hasDownloaded = this.predownloadReservedFragments();
    }
    return hasDownloaded;
  }

  /**
   * Where a fragment lies in the video for the download window: its times, or, for one without times yet,
   * about where (UntimedSpans).
   * @param {Fragment} fragment
   * @param {Map<string|number, Map<number, import('./network/UntimedSpans.mjs').Span>>} placed - The levels placed in this pass.
   * @return {import('./network/UntimedSpans.mjs').Span|null} None when nothing tells.
   */
  windowSpan(fragment, placed) {
    if (isTimed(fragment)) return fragment;
    let spans = placed.get(fragment.level);
    if (!spans) {
      spans = untimedSpans(this.getFragments(fragment.level) || []);
      placed.set(fragment.level, spans);
    }
    return spans.get(fragment.sn) || null;
  }

  /** @return {boolean} */
  predownloadReservedFragments() {
    const fragments = this.getWaitingReservedFragments(this.fragments);
    const audioFragments = this.getWaitingReservedFragments(this.audioFragments);

    let hasDownloaded = false;

    if (audioFragments.length > 0 && (
      fragments.length === 0 || fragments[0].start > audioFragments[0].start
    )) {
      audioFragments.every((fragment) => {
        if (!this.downloadManager.canGetFile(fragment.getContext())) {
          return false;
        }
        this.player.downloadFragment(fragment).catch((/** @type {unknown} */ e) => {

        });
        hasDownloaded = true;
        return true;
      });
    }

    if (hasDownloaded) {
      return true;
    }

    fragments.every((fragment) => {
      if (!this.downloadManager.canGetFile(fragment.getContext())) {
        return false;
      }
      this.player.downloadFragment(fragment).catch((/** @type {unknown} */ e) => {

      });
      hasDownloaded = true;
      return true;
    });

    return hasDownloaded;
  }

  /**
   * @param {Array<Fragment>|undefined} fragments - None for a level with no fragments yet.
   * @return {Array<Fragment>}
   */
  getWaitingReservedFragments(fragments) {
    if (!fragments) return [];
    return fragments.filter((fragment) => {
      return fragment && fragment.status === DownloadStatus.WAITING && !fragment.canFree();
    });
  }

  /** @param {Array<Fragment>} fragments - A level's, by sn. */
  freeFragments(fragments) {
    /** @type {Map<number, import('./network/UntimedSpans.mjs').Span>|null} */
    let untimed = null;
    for (let i = 0; i < fragments.length; i++) {
      const fragment = fragments[i];
      if (fragment && fragment.status === DownloadStatus.DOWNLOAD_COMPLETE && fragment.canFree()) {
        /** @type {import('./network/UntimedSpans.mjs').Span|undefined} */
        let span = fragment;
        if (!isTimed(fragment)) {
          // Downloaded ahead of the parser (windowSpan): placed by UntimedSpans; one nothing places stays.
          untimed ??= untimedSpans(fragments);
          span = untimed.get(i);
        }
        if (span && (span.end < this.state.currentTime - this.state.bufferBehind ||
            span.start > this.state.currentTime + this.state.bufferAhead)) {
          this.freeFragment(fragment);
        }
      }
    }
  }

  /** @param {Fragment} fragment */
  freeFragment(fragment) {
    this.downloadManager.removeFile(fragment.getContext());
    fragment.status = DownloadStatus.WAITING;
  }

  /**
   * @param {string|number} level
   * @param {number} sn - Sequence number.
   * @return {Fragment|null|undefined} null for a level with none yet; none for an sn not made.
   */
  getFragment(level, sn) {
    if (!this.fragmentsStore[level]) {
      return null;
    }
    return this.fragmentsStore[level][sn];
  }

  /**
   * @param {string|number} level
   * @param {number} sn
   * @param {Fragment} frag - The player's own kind (HLSFragment, DashFragment, MP4Fragment).
   */
  makeFragment(level, sn, frag) {
    if (!this.fragmentsStore[level]) {
      this.fragmentsStore[level] = [];
    }

    this.fragmentsStore[level][sn] = frag;
  }

  /**
   * Plays the next of the streams the current one was picked from, when it failed before showing anything;
   * not after a newer request, nor for a hand-picked source.
   * @return {boolean} Whether one is being tried.
   */
  tryNextSource() {
    const fallbacks = this.fallbacks;
    // It failed once more on its way out: the next one is already on its way in.
    if (fallbacks.next) {
      return true;
    }

    if (fallbacks.request !== this.sourceRequests) {
      return false;
    }

    const next = fallbacks.sources.shift();
    if (!next) {
      return false;
    }

    // URL and mode only: its headers hold the page's Cookie and Authorization.
    console.warn('The stream failed to load, trying the next one', next.url, next.mode);
    fallbacks.next = next;
    this.setSource(next, fallbacks.sources, {skipRemembered: fallbacks.skipRemembered}).then(() => {
      this.sourcesBrowser.updateSources();
    }).catch((e) => console.error('Switching to the next stream failed', e));
    return true;
  }

  /**
   * Loads the source again once a video codec failed for good (DashPlayer.takeCodecReload), its failures carried
   * over the reset; at most once per codec family (LevelManager.noteVideoDecodeFailure).
   * @param {Player} player - No reload for one already replaced.
   * @return {boolean} Whether it loads the source again.
   */
  reloadWithoutFailedCodec(player) {
    const source = this.source;
    if (!source || player !== this.player) {
      return false;
    }
    console.warn('Loading the source again without the video codec that failed to decode');
    this.carriedDecodeFailures = {url: source.url, failures: this.getLevelManager().getVideoDecodeFailures()};
    // Where it was, with what it downloaded, playing if it played, as recoverPlayer builds it.
    const again = source.copy();
    const time = Math.floor(this.currentTime);
    if (time >= 1 && !this.isLive() && /^https?:/i.test(again.url)) {
      again.url = URLUtils.withTimestamp(again.url, time);
    }
    again.defaultLevelInfo = {audioLevel: this.getCurrentAudioLevelID() ?? undefined};
    const wasPlaying = !!this.state.playing || !this.paused;
    this.setSource(again, this.fallbacks.sources, {play: wasPlaying, keepStorage: true, rebuild: true,
      skipRemembered: this.fallbacks.skipRemembered}).catch((e) => console.error(e));
    return true;
  }

  /**
   * After a source change's reset: the same source after a codec failure keeps that failure; any other starts clean.
   * @param {VideoSource} source
   */
  restoreCarriedDecodeFailures(source) {
    const carried = this.carriedDecodeFailures;
    this.carriedDecodeFailures = null;
    if (carried && carried.url === source.url) {
      this.getLevelManager().restoreVideoDecodeFailures(carried.failures);
    }
  }

  /**
   * Builds the player again at the time it was at, keeping what was downloaded, for an error after the source
   * has shown something: Firefox can fail to decode what a seek appends late, and only a new MediaSource
   * plays again. At most RECOVERY_LIMIT times in RECOVERY_WINDOW_MS.
   * @param {Player} player
   * @param {*} reason
   * @return {boolean} Whether it builds the player again.
   */
  recoverPlayer(player, reason) {
    const source = this.source;
    // A fragment the server keeps refusing: a new player would ask for it again.
    if (isNetworkFailure(reason)) {
      return false;
    }
    if (!source || player !== this.player || !this.hasPlayed(source) ||
        this.fallbacks.request !== this.sourceRequests) {
      return false;
    }
    const url = this.recoverySourceURL(source.url);
    const now = Date.now();
    if (this.recoveries.url !== url) {
      this.recoveries = {url, times: []};
      this.lastDecodeFailure = null;
    }
    this.recoveries.times = this.recoveries.times.filter((time) => now - time < RECOVERY_WINDOW_MS);
    if (this.recoveries.times.length >= RECOVERY_LIMIT) {
      return false;
    }
    this.recoveries.times.push(now);

    let time = this.currentTime;
    // The same place failing to decode again right after a rebuild: broken media, skipped (BrokenMedia.mjs).
    let skip = false;
    // Only where the new player takes a time (not live, an http(s) source).
    if (isDecodeError(reason) && !this.isLive() && /^https?:/i.test(source.url)) {
      if (isSamePlace(this.lastDecodeFailure, url, time, now)) {
        skip = true;
        time = pastBrokenMedia(/** @type {Array<?{start: number, end: number}>} */ (this.fragments), time);
        this.lastDecodeFailure = null;
      } else {
        this.lastDecodeFailure = {url, time, at: now};
      }
    }
    // What the user wants, not what the element says: an error can leave it paused.
    const wasPlaying = !!this.state.playing || !this.paused;
    console.warn((skip ? 'Skipping a segment that does not decode, on to ' : 'Building the player again at ') + time +
      ' after an error:', reason);

    const again = source.copy();
    // The time goes as faststream-timestamp (whole seconds); not for a live stream or a blob:/data: URL.
    if (!this.isLive() && /^https?:/i.test(again.url)) {
      // Whole seconds: past a broken segment, the second after it ends.
      again.url = URLUtils.withTimestamp(again.url, skip ? Math.ceil(time) : Math.floor(time));
    }
    again.defaultLevelInfo = {
      level: this.getCurrentVideoLevelID() ?? undefined,
      audioLevel: this.getCurrentAudioLevelID() ?? undefined,
    };

    // Its reset keeps what was downloaded: the stored fragments answer the new player at once.
    this.setSource(again, this.fallbacks.sources, {play: wasPlaying, keepStorage: true, keepChoice: true, rebuild: true,
      skipRemembered: this.fallbacks.skipRemembered})
        .catch((e) => console.warn('Could not resume after building the player again', e));
    return true;
  }

  /**
   * Whether a source, or the one it was rebuilt from (recoverPlayer, playDirectly), has shown a picture.
   * @param {VideoSource} source
   * @return {boolean}
   */
  hasPlayed(source) {
    const played = this.playedSource;
    return !!played && (played === source ||
      (!!played.url && this.recoverySourceURL(played.url) === this.recoverySourceURL(source.url)));
  }

  /**
   * Plays the source in Firefox's own player (DirectVideoPlayer) when the MP4 player cannot load it in ranges
   * (a server that ignores Range: RangeAnswers.mjs), at the time it was at; once per source.
   * @param {Player} player
   * @param {string} reason
   * @return {boolean} Whether it plays it directly.
   */
  playDirectly(player, reason) {
    const source = this.source;
    if (!source || player !== this.player || source.mode !== PlayerModes.ACCELERATED_MP4) {
      return false;
    }
    const url = this.recoverySourceURL(source.url);
    if (this.playedDirectly === url) {
      return false;
    }
    this.playedDirectly = url;
    const time = this.currentTime;
    const wasPlaying = !!this.state.playing || !this.paused;
    console.warn('Playing the source in Firefox\'s own player: ' + reason);

    const direct = source.copy();
    direct.mode = PlayerModes.DIRECT;
    if (time >= 1 && /^https?:/i.test(direct.url)) {
      direct.url = URLUtils.withTimestamp(direct.url, Math.floor(time));
    }
    this.setSource(direct, this.fallbacks.sources, {play: wasPlaying, rebuild: true, skipRemembered: this.fallbacks.skipRemembered})
        .catch((e) => console.warn('Could not play the source directly', e));
    return true;
  }

  /**
   * Whether a player's failure is about the source being set now: the last source's player stays
   * this.player until resetPlayer.
   * @param {Player} player - The player whose event it is.
   * @return {boolean}
   */
  isCurrentAttempt(player) {
    return player === this.player && this.fallbacks.request === this.sourceRequests;
  }

  /**
   * A source's URL without the time recoverPlayer gives it, so its recoveries count as one source's.
   * @param {string} url
   * @return {string}
   */
  recoverySourceURL(url) {
    return URLUtils.withTimestamp(url, null);
  }

  /**
   * A server refused one of the source's requests (401, 403, 410; DownloadManager.linkRefused).
   * @param {number} status
   * @param {string} url - The request's.
   */
  linkRefused(status, url) {
    this.renewSourceLink(status).catch((e) => console.warn('Could not get the link anew', e));
  }

  /**
   * Asks the page for the source's link anew (FreshLink.mjs) and plays on with a new one at the same time,
   * quality and audio track: hosters sign links for hours. At most LINK_RENEWAL_LIMIT times in LINK_RENEWAL_WINDOW_MS.
   * @param {number} status - The refusal's.
   * @return {Promise<boolean>} Whether the player plays on with a new link.
   */
  async renewSourceLink(status) {
    const source = this.source;
    // A refusal of the last source's request, with the next one on its way in, is none of it.
    const request = this.sourceRequests;
    if (!source || this.fallbacks.request !== request || !EnvUtils.isExtension() || source.loadedFromArchive ||
        !/^https?:/i.test(source.url)) {
      return false;
    }
    const now = Date.now();
    let renewals = this.linkRenewals;
    if (renewals.identifier !== source.identifier) {
      renewals = this.linkRenewals = {identifier: source.identifier, times: [], asking: false};
    }
    renewals.times = renewals.times.filter((time) => now - time < LINK_RENEWAL_WINDOW_MS);
    if (renewals.asking || renewals.times.length >= LINK_RENEWAL_LIMIT) {
      return false;
    }
    renewals.asking = true;
    renewals.times.push(now);
    console.warn(`The server refused the link (${status}): asking the page for it anew`);
    /** @type {unknown} */
    let fresh = null;
    try {
      fresh = await chrome.runtime.sendMessage({type: MessageTypes.REQUEST_FRESH_LINK, url: this.recoverySourceURL(source.url)});
    } catch (e) {
      console.warn('The background gave no new link', e);
    } finally {
      renewals.asking = false;
    }
    // Another video meanwhile (asked for, or already set), or the page has no other link.
    if (this.source !== source || this.sourceRequests !== request || typeof fresh !== 'string') {
      return false;
    }
    const time = this.currentTime;
    // What the user wants, not what the element says; a relink refused before showing anything keeps the earlier wish.
    const wasPlaying = !!this.state.playing || !this.paused || (this.playedSource !== source && !!renewals.playing);
    renewals.playing = wasPlaying;
    console.warn('Playing on with the page\'s new link at ' + time);
    const again = source.copy();
    again.url = fresh;
    // The time as recoverPlayer gives it; not for a live stream, which joins at its edge.
    if (!this.isLive() && time >= 1) {
      again.url = URLUtils.withTimestamp(fresh, Math.floor(time));
    }
    again.defaultLevelInfo = {
      level: this.getCurrentVideoLevelID() ?? undefined,
      audioLevel: this.getCurrentAudioLevelID() ?? undefined,
    };
    // What the old link downloaded is found under the new one (DownloadManager.relink).
    await this.setSource(again, this.fallbacks.sources, {play: wasPlaying, keepStorage: true, keepChoice: true,
      relink: {from: source.url, to: fresh}, rebuild: true, skipRemembered: this.fallbacks.skipRemembered});
    return true;
  }

  /**
   * The load error's text: what went wrong and, in a page, how to watch in the site's own player.
   * FastStream never steps aside by itself.
   * @param {string} [detail] - What went wrong, when known.
   * @return {string}
   */
  loadErrorMessage(detail) {
    const message = Localize.getMessage('player_error_load') + (detail ? ' (' + detail + ')' : '');
    const inPage = typeof window !== 'undefined' && window.top !== window;
    // Android has no toolbar: FastStream's button is in Firefox's menu, under Extensions.
    return inPage ? message + ' ' + Localize.getMessage(EnvUtils.isAndroid() ? 'player_error_turn_off_android' : 'player_error_turn_off') : message;
  }

  /**
   * The load error: the message, the downloads stopped.
   * @param {string} reason - The message shown.
   */
  failedToLoad(reason) {
    this.downloadManager.removeAllDownloaders();
    this.interfaceController.failedToLoad(reason);
    // The page may play its own media again.
    this.reportPlaying(false);
  }

  /**
   * Hands the buffer over as the player goes (beforeunload), for the next player of this video on this page
   * (BufferStash): a reload keeps what was downloaded.
   */
  handOffBuffer() {
    const source = this.source;
    // For the page takeBackBuffer was told (bufferPage): no page, no hand-off. Kept for no time ("Off"): none
    // either, and the reset deletes the files at once.
    if (!source || !this.bufferPage || source.identifier !== this.bufferPage.identifier || !this.downloadManager ||
        this.options.bufferKeep === 0) {
      return;
    }
    const {session, entries} = this.downloadManager.handOff();
    if (entries.length === 0) {
      return;
    }
    // At once: the page is going. The Blobs go along as they are, not copied (256 MB in 1 ms).
    chrome.runtime.sendMessage({type: MessageTypes.BUFFER_STASH, page: this.bufferPage.page,
      identifier: source.identifier, url: source.url, session, entries})
        .catch((e) => console.warn('Could not hand the buffer over', e));
    // Its disk files are the stash's now: this player's reset must not delete them.
    this.downloadManager.keepStorageOnce();
  }

  /**
   * Takes back the buffer an earlier player of this video on this page handed over (handOffBuffer).
   * @param {VideoSource} source
   * @return {Promise<void>}
   */
  async takeBackBuffer(source) {
    this.bufferPage = null;
    if (!EnvUtils.isExtension() || source.loadedFromArchive || !/^https?:/i.test(source.url)) {
      return;
    }
    /** @type {*} */
    let answer = null;
    try {
      answer = await chrome.runtime.sendMessage({type: MessageTypes.BUFFER_TAKE, identifier: source.identifier});
    } catch (e) {
      console.warn('Could not ask for a handed-over buffer', e);
      return;
    }
    if (this.source !== source) {
      return;
    }
    // The page this player is on, which its own hand-off names (handOffBuffer).
    this.bufferPage = typeof answer?.page === 'string' ? {page: answer.page, identifier: source.identifier} : null;
    if (!Array.isArray(answer?.handOff?.entries) || answer.handOff.entries.length === 0) {
      return;
    }
    // Into this realm: Blobs from another realm are not `instanceof Blob` here; their data is shared, not copied.
    const handOff = structuredClone(answer.handOff);
    // The RAM's at once; the disk's while the player starts.
    const {taken, onDisk} = this.downloadManager.adopt(handOff, source.url);
    const record = this.bufferTakenBack = {taken, of: handOff.entries.length};
    onDisk.then((fromDisk) => {
      record.taken += fromDisk;
      console.log(`Took back ${record.taken} of the ${record.of} downloads a player of this video had`);
    }).catch((e) => console.warn('Could not take back the handed-over files on the disk', e));
  }

  /** @return {Promise<void>} */
  async resetPlayer() {
    const saveManager = this.interfaceController?.saveManager;
    if (saveManager?.makingDownload) {
      // A save left running against the destroyed player would never end: cancel it and let it settle first.
      if (saveManager.downloadCancel) {
        saveManager.downloadCancel();
      }
      if (saveManager.pendingSave) {
        await saveManager.pendingSave.catch(() => {});
      }
    }
    // A new video takes the MPV Allowlist's per-site default again.
    saveManager?.resetMpvContentType();

    const promises = [];
    // The next video starts at 0.
    this.state.currentTime = 0;

    this.fragmentsStore = {};
    this.pastSeeks.length = 0;
    this.pastUnseeks.length = 0;
    this.progressHashesCache = null;
    this.progressData = null;
    this.disableProgressSave = false;
    this.lastProgressSave = 0;
    // The next source makes its own wait for a picture.
    this.initPromise = null;
    clearInterval(this.initHookInterval);
    this.startPending = null;
    // A lookup for the last video is not this one's (loadProgressData).
    this.progressLoad = null;
    this.autoNextRequested = false;
    this.resetAutoNext();
    // A play() or pause() still waiting on the old player is not the new one's.
    this.playPauseTurn++;
    // A stall watched at the old video's end is none of the new one's.
    this.cancelEndStall();
    this.state.bufferBehind = this.options.bufferBehind;
    this.state.bufferAhead = this.options.bufferAhead;
    if (this.context) {
      this.context.destroy();
      this.context = null;
      // Its pause, if it played, comes to no one now; the next source says when it plays.
      this.reportPlaying(false);
    }

    if (this.previewContext) {
      this.previewContext.destroy();
      this.previewContext = null;
    }

    if (this.player) {
      try {
        this.player.destroy();
      } catch (e) {
        console.error(e);
      }
      this.player = null;
    }

    if (this.source) {
      this.source.destroy();
      this.source = null;
    }


    if (this.previewPlayer) {
      try {
        this.previewPlayer.destroy();
      } catch (e) {
        console.error(e);
      }
      this.previewPlayer = null;
    }
    // A preview build still running is the old video's.
    this.previewPlayerSetup = null;
    /** @type {number[]} */
    this.previewReloads = [];

    if (this.syncedAudioPlayer) {
      try {
        this.syncedAudioPlayer.destroy();
      } catch (e) {
        console.error(e);
      }
      this.syncedAudioPlayer = null;
    }

    if (this.audioContext) {
      this.audioOutputDevice?.release();
      this.audioContext.close().catch(()=>{});
      this.audioContext = null;
    }

    if (this.audioSource) {
      this.audioSource.disconnect();
      this.audioSource = null;
    }

    this.audioAnalyzer.reset();
    this.frameExtractor.reset();
    // The overlay's picture and time line are the video's; the next one takes its own.
    this.mediaKeys()?.reset();
    this.artworkTaken = false;
    this.artworkAt = null;
    this.droppedFrameWatch.reset();

    promises.push(this.downloadManager.reset());
    this.interfaceController.reset();

    this.state.buffering = false;

    this.storageAvailable = 0;
    /** @type {boolean|undefined} */
    this.hasDownloadSpace = true;
    this.getLevelManager().reset();

    await Promise.all(promises);
  }

  /**
   * Steps the video down a quality when this computer drops too many frames (DroppedFrameWatch), and says so
   * in the status line, naming the version to pick again.
   */
  watchDroppedFrames() {
    if (!this.options.lowerOnDroppedFrames) return;
    const video = this.player?.getVideo();
    if (!video || typeof video.getVideoPlaybackQuality !== 'function') return;
    const now = Date.now();
    if (now - this.droppedSampledAt < DROPPED_SAMPLE_MS) return;
    this.droppedSampledAt = now;
    const quality = video.getVideoPlaybackQuality();
    const rate = this.playbackRate;
    const levelId = this.getMenuVideoLevelID();
    const due = this.droppedFrameWatch.sample({
      now,
      total: quality.totalVideoFrames,
      dropped: quality.droppedVideoFrames,
      levelId,
      // A hidden tab shows no frames, but one in picture-in-picture does.
      steady: !video.paused && !video.seeking && video.readyState >= 3 && rate >= 0.5 && rate <= 1.25 &&
        (globalThis.document?.visibilityState !== 'hidden' || this.interfaceController.isInPip()),
    });
    if (!due) return;
    const levels = [...this.getMenuVideoLevels().values()];
    const current = levels.find((level) => level.id === levelId);
    const lower = current ? lowerLevel(levels, current) : null;
    if (!current || !lower) return;
    const percent = String(Math.round(due.ratio * 100));
    console.warn(`[DroppedFrames] ${percent}% of ${due.frames} frames dropped at ${current.height}p: stepping down to ${lower.height}p`);
    this.setCurrentVideoLevelID(lower.id);
    this.interfaceController.setStatusMessage(StatusTypes.QUALITY, Localize.getMessage('player_quality_lowered',
        [qualityLabel(levels, lower), percent, qualityLabel(levels, current)]), 'warning', 15000);
  }

  /**
   * The tab and frame of the page this player is on, for loading through it (PageFetch.mjs).
   * @param {*} tabId
   * @param {*} frameId
   */
  setPage(tabId, frameId) {
    this.page = Number.isInteger(tabId) && tabId >= 0 && Number.isInteger(frameId) ? {tabId, frameId} : null;
  }

  /**
   * @param {?{name?: string, year?: ?number, season?: ?number, episode?: ?number}} info - What the page's title tells (guessMediaInfo).
   */
  setMediaInfo(info) {
    this.mediaInfo = info;
    this.interfaceController.subtitlesManager.mediaInfoSet();
    this.mediaKeys()?.setInfo(info);
  }

  /**
   * The overlay's picture of the video (MediaKeys.setArtwork): the first frame, then one ARTWORK_AFTER_S in
   * (halfway into a shorter video), as first frames are often black.
   */
  takeArtwork() {
    const video = this.player?.getVideo();
    if (this.artworkTaken || !video || video.readyState < 2 || !video.videoWidth) return;
    const duration = this.duration;
    const after = Number.isFinite(duration) && duration > 0 ? Math.min(ARTWORK_AFTER_S, duration / 2) : ARTWORK_AFTER_S;
    if (this.artworkAt === null) {
      this.artworkAt = video.currentTime;
    } else if (video.currentTime < this.artworkAt) {
      // Back before the first (a loop, a seek back): from there again.
      this.artworkAt = video.currentTime;
      return;
    } else if (video.currentTime - this.artworkAt < after) {
      return;
    } else {
      this.artworkTaken = true;
    }
    this.mediaKeys()?.setArtwork(video);
  }

  /**
   * The media keys and the system's media overlay, once the interface is up.
   * @return {?import('./ui/MediaKeys.mjs').MediaKeys}
   */
  mediaKeys() {
    return this.interfaceController?.toolManager?.mediaKeys || null;
  }

  /**
   * Binds event listeners to the main player. ERROR comes with what the player had: a message, the video's
   * error event, hls.js's or dash.js's error.
   * @param {Player} player
   */
  bindPlayer(player) {
    this.context = player.createContext();
    this.context.on(DefaultPlayerEvents.MANIFEST_PARSED, () => {
      console.log('MANIFEST_PARSED');
      this.updateQualityLevels();
    });

    this.context.on(DefaultPlayerEvents.CANPLAY, (/** @type {undefined} */ event) => {
      this.player.playbackRate = this.state.playbackRate;

      // Marked only once started: a blocked play() must not stop the later attempts. Not before startPending is applied.
      if (!this.state.autoPlayTriggered && this.options.autoPlay && this.state.playing === false &&
          !this.startPending) {
        const own = this.source;
        this.play().then(() => {
          if (this.source === own) this.state.autoPlayTriggered = true;
        }).catch((e) => console.warn('Autoplay failed', e));
      }
    });

    this.context.on(DefaultPlayerEvents.DURATIONCHANGE, (/** @type {undefined} */ event) => {
      this.updateDuration();
      this.interfaceController.updateFragmentsLoaded();
      this.mediaKeys()?.updatePosition();
    });

    this.context.on(DefaultPlayerEvents.ENDED, (/** @type {undefined} */ event) => {
      this.pause();
      // The end with autoplay on and no next episode: autoplay stops and says why (series end, or an unread page).
      if (this.options.autoplayNext && this.player && window.top !== window.self && !this.hasNextVideo() &&
          EnvUtils.isExtension()) {
        if (this.state.seriesEnd) {
          this.interfaceController.setStatusMessage('info', Localize.getMessage('player_autoplay_series_end'), 'info', 15000);
        } else {
          this.interfaceController.setStatusMessage('info', Localize.getMessage('player_autoplay_no_next'), 'warning', 15000);
          chrome.runtime.sendMessage({type: MessageTypes.REPORT_AUTOPLAY_PROBLEM, kind: 'no_next'}, () => {
            void chrome.runtime.lastError;
          });
        }
      }
      this.autoplayNextVideo();
    });

    // A source this player cannot load: Firefox's own player plays it, once per source.
    this.context.on(DefaultPlayerEvents.PLAY_DIRECTLY, (/** @type {string} */ reason) => {
      if (!this.isCurrentAttempt(player)) return;
      if (!this.playDirectly(player, reason)) {
        this.failedToLoad(this.loadErrorMessage(reason));
      }
    });

    this.context.on(DefaultPlayerEvents.ERROR, (/** @type {unknown} */ reason) => {
      console.error('ERROR', reason);
      if (!this.isCurrentAttempt(player)) return;
      // A codec that failed for good: the same source again without it (only DashPlayer has takeCodecReload).
      if (/** @type {Player & {takeCodecReload?: () => boolean}} */ (player).takeCodecReload?.() && this.reloadWithoutFailedCodec(player)) {
        return;
      }
      if (this.tryNextSource()) {
        return;
      }
      // After it has shown something: rebuilt at the same time with what it downloaded (recoverPlayer).
      if (this.recoverPlayer(player, reason)) {
        return;
      }
      // The reason is the event's only argument.
      const detail = describePlayerError(reason);
      // An MP4 the MP4 player could not read: Firefox's own player reads more than mp4box and MSE (playDirectly).
      // Not for a refused request, which it would send the same while a new link may be coming.
      if (!isNetworkFailure(reason) && this.playDirectly(player, detail || 'player error')) {
        return;
      }
      this.failedToLoad(this.loadErrorMessage(detail));
    });

    this.context.on(DefaultPlayerEvents.NEED_KEY, (/** @type {undefined} */ event) => {
      if (!this.isCurrentAttempt(player)) return;
      this.failedToLoad(Localize.getMessage(EnvUtils.isAndroid() ? 'player_error_drm_android' : 'player_error_drm'));
    });

    this.context.on(DefaultPlayerEvents.LOADEDDATA, (/** @type {undefined} */ event) => {
      // It shows something: a failure from now on is the stream's, not a wrong pick.
      this.fallbacks.sources = [];
      // This player's: an old one's late event is not the new source's.
      if (player === this.player) {
        this.playedSource = this.source;
      }
      // Made only where Web Audio is (constructor), as every other use checks
      this.audioOutput?.updateChannelCount();
      // A frame is decoded: the overlay's first picture.
      this.takeArtwork();
      // And the settings page may load now, out of the start's way (OptionsWindow).
      this.interfaceController?.optionsWindow?.loadFrameWhenIdle();
    });


    this.context.on(DefaultPlayerEvents.LOADEDMETADATA, (/** @type {undefined} */ event) => {
      this.interfaceController.updateQualityLevels();
    });


    this.context.on(DefaultPlayerEvents.PAUSE, (/** @type {undefined} */ event) => {
      this.cancelEndStall();
      this.interfaceController.pause();
      this.reportPlaying(false);
      this.updatePeers();
      this.mediaKeys()?.updatePosition();
    });


    this.context.on(DefaultPlayerEvents.PLAY, (/** @type {undefined} */ event) => {
      // Started, by autoplay or by the user after a blocked autoplay: a rebuild that was paused stays paused.
      this.state.autoPlayTriggered = true;
      this.interfaceController.play();
      this.reportPlaying(true);
      this.updatePeers();
      this.mediaKeys()?.updatePosition();
    });


    this.context.on(DefaultPlayerEvents.PLAYING, (/** @type {undefined} */ event) => {
      this.cancelEndStall();
      this.interfaceController.setBuffering(false);
      this.mediaKeys()?.offerSeeking();
      this.mediaKeys()?.updatePosition();
      this.takeArtwork();
      this.droppedFrameWatch.interrupt();
    });


    this.context.on(DefaultPlayerEvents.RATECHANGE, (/** @type {undefined} */ event) => {
      this.mediaKeys()?.updatePosition();
      this.droppedFrameWatch.interrupt();
    });


    this.context.on(DefaultPlayerEvents.SEEKED, (/** @type {undefined} */ event) => {
      this.interfaceController.updateFragmentsLoaded();
      this.mediaKeys()?.updatePosition();
      this.droppedFrameWatch.interrupt();
    });


    this.context.on(DefaultPlayerEvents.SEEKING, (/** @type {undefined} */ event) => {
      this.cancelEndStall();
      this.droppedFrameWatch.interrupt();
    });


    this.context.on(DefaultPlayerEvents.TIMEUPDATE, (/** @type {undefined} */ event) => {
      if (this.interfaceController.isUserSeeking()) return;

      this.updateTime(this.currentTime);
      // Firefox runs the overlay's time line on by itself; set now and then, it follows a stall or drift.
      this.mediaKeys()?.updatePosition(false);
      this.takeArtwork();
      this.watchDroppedFrames();
      // Near the end every time update watches for a stop: a video can stand still in its last second without `waiting`.
      this.watchEndStall();
    });


    this.context.on(DefaultPlayerEvents.WAITING, (/** @type {undefined} */ event) => {
      // In the last second, the next video instead of a wait, when there is one.
      if (this.duration > 5 && this.duration - this.currentTime < 1 && this.autoplayNextVideo()) {
        return;
      }
      this.watchEndStall();
      this.interfaceController.setBuffering(true);
      this.droppedFrameWatch.interrupt();
    });

    this.context.on(DefaultPlayerEvents.FRAGMENT_UPDATE, () => {
      this.interfaceController.updateFragmentsLoaded();
    });
  }

  /**
   * @param {Player} player
   * @return {ReturnType<import('./modules/eventemitter.mjs').EventEmitter['createContext']>}
   */
  bindPreviewPlayer(player) {
    const context = player.createContext();

    context.on(DefaultPlayerEvents.MANIFEST_PARSED, () => {
      player.setCurrentVideoLevelID(this.getCurrentVideoLevelID());
      player.setCurrentAudioLevelID(this.getCurrentAudioLevelID());
    });

    context.on(DefaultPlayerEvents.FRAGMENT_UPDATE, (/** @type {Fragment} */ fragment) => {
      this.interfaceController.updateFragmentsLoaded();
    });

    context.on(DefaultPlayerEvents.SEEKED, (/** @type {undefined} */ event) => {
      this.updatePreview();
    });


    context.on(DefaultPlayerEvents.SEEKING, (/** @type {undefined} */ event) => {
      this.updatePreview();
    });


    context.on(DefaultPlayerEvents.ERROR, (/** @type {unknown} */ e) => {
      console.log('Preview player error', e);
      // Another preview's, built for a replaced video: its own build lets go of it.
      if (this.previewPlayer && this.previewPlayer !== player) return;
      // Still being built (stored only once its source has loaded): its build lets go of it.
      if (!this.previewPlayer) {
        PreviewsFailedInBuild.add(player);
        return;
      }
      this.previewPlayer.destroy();
      this.previewPlayer = null;
      if (this.previewContext === context) {
        context.destroy();
        this.previewContext = null;
      }
      this.interfaceController.resetPreviewVideo();

      if (!this.interfaceController.failed) {
        const now = Date.now();
        if (this.lastPreviewReload && now - this.lastPreviewReload < 1000) {
          return;
        }
        // PREVIEW_RELOAD_LIMIT times in RECOVERY_WINDOW_MS; resetPlayer starts the count again.
        this.previewReloads = (this.previewReloads || []).filter((time) => now - time < RECOVERY_WINDOW_MS);
        if (this.previewReloads.length >= PREVIEW_RELOAD_LIMIT) {
          return;
        }
        this.previewReloads.push(now);
        this.lastPreviewReload = now;
        console.error('Reloading preview player');
        this.setupPreviewPlayer().catch((error) => console.warn('The preview player could not be built again', error));
      }
    });
    return context;
  }

  /** @return {Promise<void>} */
  async play() {
    if (!this.player) {
      throw new Error('No source is loaded!');
    }

    // Played again: its end may go on to the next video again (autoplayNextVideo).
    this.autoNextRequested = false;
    this.resetAutoNext();

    // A pause() or play() made while this waits wins.
    const turn = ++this.playPauseTurn;

    await this.player.play();

    if (this.syncedAudioPlayer && turn === this.playPauseTurn) {
      await this.syncedAudioPlayer.play();
    }
    if (turn !== this.playPauseTurn) {
      return;
    }

    this.interfaceController.play();
    this.startAudio();
  }

  /** Starts a suspended audio context without waiting: with no sound device resume() never settles. */
  startAudio() {
    const context = this.audioContext;
    if (!context || context.state !== 'suspended') {
      this.audioAnalyzer.updateBackgroundAnalyzer();
      return;
    }
    // A play while the context is still starting has nothing to add.
    if (this.startingAudioContext === context) {
      return;
    }
    this.startingAudioContext = context;
    const started = () => {
      if (this.startingAudioContext === context) {
        this.startingAudioContext = null;
      }
    };
    context.resume().then(() => {
      started();
      if (context === this.audioContext) {
        this.audioAnalyzer.updateBackgroundAnalyzer();
      }
    }).catch((e) => {
      started();
      console.warn('The audio did not start', e);
    });
  }

  /** @return {Promise<void>} */
  async pause() {
    // No player while a source is being swapped: a key pressed then threw.
    if (!this.player) {
      return;
    }
    const turn = ++this.playPauseTurn;
    await this.player.pause();

    if (this.syncedAudioPlayer && turn === this.playPauseTurn) {
      await this.syncedAudioPlayer.pause();
    }

    if (turn === this.playPauseTurn) {
      this.interfaceController.pause();
    }
  }

  undoSeek() {
    if (this.player && this.pastSeeks.length) {
      this.pastUnseeks.push(this.player.currentTime);
      // Through the setter, so a separate audio track follows; not saved, or the undo is a seek to undo.
      this.setSeekSave(false);
      this.currentTime = /** @type {number} */ (this.pastSeeks.pop());
      this.setSeekSave(true);
      this.interfaceController.updateMarkers();
    }
  }

  redoSeek() {
    if (this.player && this.pastUnseeks.length) {
      this.pastSeeks.push(this.player.currentTime);
      this.setSeekSave(false);
      this.currentTime = /** @type {number} */ (this.pastUnseeks.pop());
      this.setSeekSave(true);
      this.interfaceController.updateMarkers();
    }
  }

  savePosition() {
    if (!this.pastSeeks.length || this.pastSeeks[this.pastSeeks.length - 1] !== this.state.currentTime) {
      this.pastSeeks.push(this.state.currentTime);
    }
    if (this.pastSeeks.length > 50) {
      this.pastSeeks.shift();
    }
    this.pastUnseeks.length = 0;
    this.interfaceController.updateMarkers();
  }

  /**
   * @param {number} start
   * @param {number} end
   * @return {boolean}
   */
  isRegionBuffered(start, end) {
    const fragments = this.getFragments(/** @type {string|number} */ (this.getCurrentVideoLevelID()));
    if (!fragments) {
      return true;
    }

    for (let i = 0; i < fragments.length; i++) {
      const fragment = fragments[i];
      if (fragment && fragment.end >= start && fragment.start <= end) {
        if (fragment.status !== DownloadStatus.DOWNLOAD_COMPLETE) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Sets the current playback time, clamped to [0, duration]: relative seeks ask outside it, and only the media
   * element clamps by itself. A live stream's duration is Infinity.
   * @param {number} value
   */
  set currentTime(value) {
    if (Number.isNaN(value)) {
      return;
    }
    value = Math.max(0, value);
    const duration = this.duration;
    if (duration > 0 && Number.isFinite(duration)) {
      value = Math.min(value, duration);
    }
    // The end of a live stream (Infinity): a media element throws on it.
    if (!Number.isFinite(value)) return;

    if (this.saveSeek) {
      this.savePosition();
    }
    this.state.currentTime = value;
    if (this.player) {
      this.player.currentTime = value;
    }
    this.peers?.noteSeek();
    this.updatePeers();
    // What was downloading for the old place gives way to the new one at once.
    this.concentrating = true;
    this.cancelFarDownloads();
    if (this.syncedAudioPlayer) this.syncedAudioPlayer.setCurrentTime(value);
  }

  /** @return {number} */
  get duration() {
    return this.player?.duration || 0;
  }

  /**
   * The seconds a Buffer ahead or Buffer behind setting keeps: Infinity for no limit (saved as -1), 0 for none.
   * @param {number} value - The setting as saved.
   * @return {number}
   */
  static bufferSeconds(value) {
    return typeof value === 'number' && value < 0 ? Infinity : value;
  }

  /**
   * Whether the video is a live stream: dash.js gives one an infinite duration; HLSPlayer says it itself.
   * @return {boolean}
   */
  isLive() {
    return !Number.isFinite(this.duration) || !!this.player?.isLive;
  }

  /** @return {number} */
  get currentTime() {
    return this.player?.currentTime || 0;
  }

  /** @return {boolean} */
  get paused() {
    return this.player?.paused ?? true;
  }

  /** @return {Map<string, import('./players/Levels.mjs').VideoLevel>} By level id. */
  getVideoLevels() {
    return this.player?.getVideoLevels() || new Map();
  }

  /** @return {Map<string, import('./players/Levels.mjs').AudioLevel>} By level id. */
  getAudioLevels() {
    return this.player?.getAudioLevels() || new Map();
  }

  /** @return {string|number|null} */
  getCurrentVideoLevelID() {
    return this.player?.getCurrentVideoLevelID() ?? null;
  }

  /** @return {string|number|null} */
  getCurrentAudioLevelID() {
    return this.player?.getCurrentAudioLevelID() ?? null;
  }

  /**
   * Sets the current video level ID; one of the page's qualities (getMenuVideoLevels) plays that file instead.
   * @param {string|number} levelID
   */
  setCurrentVideoLevelID(levelID) {
    if (!this.player) return;
    if (typeof levelID === 'string' && levelID.startsWith(PAGE_QUALITY_LEVEL)) {
      this.playPageQuality(parseInt(levelID.slice(PAGE_QUALITY_LEVEL.length), 10));
      return;
    }
    this.player.setCurrentVideoLevelID(levelID);
    this.checkLevelChange();
  }

  /**
   * The page's qualities (VideoSource.qualities) as quality menu levels, when the player has no choice of its own.
   * The player's own levels stay: analyzers, downloads and the embed API go by them.
   * @return {?Map<string, VideoLevel>}
   */
  getPageQualityLevels() {
    const qualities = this.source?.qualities;
    if (!qualities || qualities.length < 2 || this.getVideoLevels().size > 1) return null;
    const index = this.playingPageQuality();
    if (index < 0) return null;
    // A label names a size class, not the height (a film's "1080p" is 1920x816): only the file playing shows its size.
    const levels = new Map();
    qualities.forEach((entry, i) => {
      const id = PAGE_QUALITY_LEVEL + i;
      const playing = i === index && this.videoWidth > 0 && this.videoHeight > 0;
      levels.set(id, new VideoLevel(/** @type {NonNullable<ConstructorParameters<typeof VideoLevel>[0]>} */ ({
        id,
        height: playing ? this.videoHeight : entry.height,
        width: playing ? this.videoWidth : 0,
        label: entry.label || (entry.height ? entry.height + 'p' : ''),
      })));
    });
    return levels;
  }

  /**
   * The video levels the quality menu offers: the page's qualities, else the player's own.
   * @return {Map<string, import('./players/Levels.mjs').VideoLevel>}
   */
  getMenuVideoLevels() {
    return this.getPageQualityLevels() || this.getVideoLevels();
  }

  /**
   * The quality menu's current level: the page's quality playing, else the player's own.
   * @return {string|number|null}
   */
  getMenuVideoLevelID() {
    if (this.getPageQualityLevels()) {
      return PAGE_QUALITY_LEVEL + this.playingPageQuality();
    }
    return this.getCurrentVideoLevelID();
  }

  /**
   * Which of the page's qualities plays: the entry with the source's URL, both read by recoverySourceURL.
   * @return {number} Its index in VideoSource.qualities, -1 when none.
   */
  playingPageQuality() {
    const qualities = this.source?.qualities || [];
    const playing = this.recoverySourceURL(this.source?.url || '');
    return qualities.findIndex((entry) => this.recoverySourceURL(entry.url) === playing);
  }

  /**
   * Plays another of the page's qualities from where this one is, as recoverPlayer does.
   * @param {number} index - In VideoSource.qualities.
   */
  playPageQuality(index) {
    const source = this.source;
    const entry = source?.qualities?.[index];
    if (!entry || index === this.playingPageQuality()) return;
    const wasPlaying = !!this.state.playing || !this.paused;
    const next = source.copy();
    next.url = entry.url;
    const time = Math.floor(this.currentTime);
    if (time >= 1 && !this.isLive()) {
      next.url = URLUtils.withTimestamp(next.url, time);
    }
    console.log('Playing the page\'s ' + (entry.label || entry.height + 'p') + ' instead');
    // The same video in another file: a version picked by hand stays picked.
    this.setSource(next, [], {play: wasPlaying, keepChoice: true}).catch((e) => console.warn('Could not switch the quality', e));
  }

  /** @param {string|number} levelID */
  setCurrentAudioLevelID(levelID) {
    if (!this.player) return;
    this.player.setCurrentAudioLevelID(levelID);
    this.checkLevelChange();
  }

  checkLevelChange() {
    const videoLevelID = this.getCurrentVideoLevelID();
    const audioLevelID = this.getCurrentAudioLevelID();

    const previousVideoLevelID = this.levelManager.getCurrentVideoLevelID();
    const previousAudioLevelID = this.levelManager.getCurrentAudioLevelID();

    const videoChanged = videoLevelID !== null && (videoLevelID !== previousVideoLevelID);
    const audioChanged = audioLevelID !== null && (audioLevelID !== previousAudioLevelID);

    if (videoChanged) {
      if (this.options.freeUnusedChannels && this.fragmentsStore[/** @type {string} */ (previousVideoLevelID)]) {
        this.freeLevel(this.fragmentsStore[/** @type {string} */ (previousVideoLevelID)]);
      }
      this.levelManager.setCurrentVideoLevelID(videoLevelID);
    }

    if (audioChanged) {
      if (this.options.freeUnusedChannels && this.fragmentsStore[/** @type {string} */ (previousAudioLevelID)]) {
        this.freeLevel(this.fragmentsStore[/** @type {string} */ (previousAudioLevelID)]);
      }
      this.levelManager.setCurrentAudioLevelID(audioLevelID);
    }

    if (videoChanged || audioChanged) {
      this.audioAnalyzer.setLevel(videoLevelID, audioLevelID);
      this.frameExtractor.setLevel(videoLevelID, audioLevelID);
      if (this.syncedAudioPlayer) {
        this.syncedAudioPlayer.setLevel(videoLevelID, audioLevelID);
      }
      if (this.previewPlayer) {
        this.previewPlayer.setCurrentVideoLevelID(videoLevelID);
        this.previewPlayer.setCurrentAudioLevelID(audioLevelID);
      }
      this.resetFailed();
      this.updateQualityLevels();
      // None without Web Audio (the constructor makes it only then), as at the other call.
      this.audioOutput?.updateChannelCount();
    }
  }

  /**
   * Frees a level no longer played, but not fragments a save still writes (SAVER); its other pins go with it,
   * as nothing else would free them.
   * @param {Array<Fragment>} fragments
   */
  freeLevel(fragments) {
    fragments.forEach((fragment) => {
      if (!fragment.references.includes(ReferenceTypes.SAVER)) {
        this.freeFragment(fragment);
      }
    });
  }

  /** @return {string} 'fullscreen', 'pip', 'windowed', or 'normal'. */
  getFullscreenState() {
    if (this.state.fullscreen || this.state.carriedFullscreen) {
      return 'fullscreen';
    }

    if (this.interfaceController.isInPip()) {
      return 'pip';
    }

    if (this.state.windowedFullscreen) {
      return 'windowed';
    }

    return 'normal';
  }

  escapeAll() {
    if (this.interfaceController.closeAllMenus(false)) {
      return;
    }

    if (InterfaceUtils.closeWindows()) {
      return;
    }

    if (this.state.fullscreen) {
      this.interfaceController.fullscreenToggle(false);
      return;
    }

    if (this.interfaceController.isInPip()) {
      this.interfaceController.pipToggle(false);
      return;
    }

    if (this.state.windowedFullscreen) {
      this.interfaceController.toggleWindowedFullscreen(false);
      return;
    }

    this.interfaceController.hideControlBar();
  }

  /**
   * A stream stuck in its last seconds for EndStallMs, not paused and not seeking, goes on to the next video:
   * a last fragment that never comes leaves it short of its end.
   */
  watchEndStall() {
    this.cancelEndStall();
    if (!this.options.autoplayNext || this.autoNextRequested || !this.hasNextVideo() || !(this.duration > 5) || this.isLive()) return;
    const left = this.duration - this.currentTime;
    // The last 5 %, at least 3 s and at most 10 s: about one fragment of a real stream.
    if (left > Math.min(10, Math.max(3, this.duration * 0.05))) return;
    const at = this.currentTime;
    this.endStallTimer = setTimeout(() => {
      this.endStallTimer = null;
      const video = this.player?.getVideo?.();
      if (!video || video.paused || video.seeking || Math.abs(this.currentTime - at) > 0.25) return;
      this.autoplayNextVideo();
    }, EndStallMs);
  }

  cancelEndStall() {
    if (this.endStallTimer) {
      clearTimeout(this.endStallTimer);
      this.endStallTimer = null;
    }
  }

  /**
   * Goes on to the next video when this one ends, once: `waiting` and `ended` both ask, and some next buttons
   * count clicks. Playing again lets the end ask again.
   * @return {boolean} Whether the next video is on its way.
   */
  autoplayNextVideo() {
    // A live stream's end is its live edge, where it waits for the next segment.
    if (!this.options.autoplayNext || !this.hasNextVideo() || this.isLive()) return false;
    if (this.autoNextRequested) return true;
    this.autoNextRequested = true;
    this.autoNextTries = (this.autoNextTries || 0) + 1;
    this.nextVideo();
    return true;
  }

  /**
   * The background did not go on for the end's request (nextVideo): while the video stays at its end, the end
   * asks again, AutoNextTries times in all.
   */
  retryAutoNext() {
    if (!this.autoNextRequested) return; // a request by hand: the user's to make again
    this.autoNextRequested = false;
    clearTimeout(this.autoNextRetryTimer);
    if ((this.autoNextTries || 0) >= AutoNextTries) return;
    this.autoNextRetryTimer = setTimeout(() => {
      this.autoNextRetryTimer = undefined;
      if (this.isAtTheEnd()) this.autoplayNextVideo();
    }, AutoNextRetryMs);
  }

  /**
   * Whether the video is at its end: ended, or in its last second, and not being sought.
   * @return {boolean}
   */
  isAtTheEnd() {
    const video = this.player?.getVideo?.();
    if (!video || video.seeking) return false;
    return video.ended === true || (this.duration > 5 && this.duration - this.currentTime < 1);
  }

  resetAutoNext() {
    clearTimeout(this.autoNextRetryTimer);
    this.autoNextRetryTimer = undefined;
    this.autoNextTries = 0;
    if (this.nextRequest) clearTimeout(this.nextRequest.timer);
    this.nextRequest = null;
  }

  /**
   * Tells the background whether this player plays: meanwhile the page keeps its own media paused
   * (content.js holdPageMedia).
   * @param {boolean} playing
   */
  reportPlaying(playing) {
    if (!EnvUtils.isExtension()) return;
    try {
      chrome.runtime.sendMessage({type: MessageTypes.PLAYER_PLAYING, playing}, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // The extension was reloaded under this player: nothing to tell.
    }
  }

  nextVideo() {
    if (!this.hasNextVideo() || !EnvUtils.isExtension()) return;
    // One request at a time: some next buttons count clicks.
    if (this.nextRequest) return;
    /** @type {{timer?: ReturnType<typeof setTimeout>}} */
    const request = {};
    this.nextRequest = request;
    /** @param {*} answer - The background's: 'clicked', 'series_end', 'no_button', 'error', or none. */
    const answered = (answer) => {
      if (this.nextRequest !== request) return;
      clearTimeout(request.timer);
      this.nextRequest = null;
      if (answer === 'clicked') return;
      if (answer === 'series_end') {
        // The page says the series ends here: autoplay stops, as at an end without a next one.
        this.state.hasNextVideo = false;
        this.state.seriesEnd = true;
        this.autoNextRequested = false;
        return;
      }
      this.retryAutoNext();
    };
    request.timer = setTimeout(() => answered(undefined), NextAnswerMs);
    try {
      chrome.runtime.sendMessage({
        type: MessageTypes.REQUEST_PLAYLIST_NAVIGATION,
        direction: 'next',
        continuationOptions: {
          fullscreenState: this.getFullscreenState(),
          autoPlay: true,
          disableLoadProgress: true,
        },
      }, (answer) => {
        // No background to answer (the message's port closed): an answer of nothing.
        void chrome.runtime.lastError;
        answered(answer);
      });
    } catch (e) {
      // The extension was reloaded under this player: no request went.
      answered(undefined);
    }
  }

  previousVideo() {
    if (!this.hasPreviousVideo()) return;
    if (EnvUtils.isExtension()) {
      chrome.runtime.sendMessage({
        type: MessageTypes.REQUEST_PLAYLIST_NAVIGATION,
        direction: 'previous',
        continuationOptions: {
          fullscreenState: this.getFullscreenState(),
          autoPlay: true,
        },
      }, ()=>{

      });
    }
  }


  /** @return {boolean} */
  hasPreviousVideo() {
    if (!this.player) return false;
    if (window.top === window.self) return false;
    if (!this.state.hasPrevVideo) return false;
    return true;
  }

  /** @return {boolean} */
  hasNextVideo() {
    if (!this.player) return false;
    if (window.top === window.self) return false;
    if (!this.state.hasNextVideo) return false;
    return true;
  }

  /** @return {Array<Fragment>|undefined} By sn; none when no level plays or it has none yet. */
  get fragments() {
    return this.fragmentsStore[/** @type {string} */ (this.getCurrentVideoLevelID())];
  }

  /** @return {Array<Fragment>|undefined} By sn; none when no level plays or it has none yet. */
  get audioFragments() {
    return this.fragmentsStore[/** @type {string} */ (this.getCurrentAudioLevelID())];
  }

  /** @return {Fragment|null} */
  get currentFragment() {
    return this.player?.currentFragment || null;
  }

  /** @return {Fragment|null} */
  get currentAudioFragment() {
    return this.player?.currentAudioFragment || null;
  }

  /**
   * @param {string|number|null} level - null finds none.
   * @return {Array<Fragment>|undefined} The level's Fragments by sn; none for a level with none yet.
   */
  getFragments(level) {
    return this.fragmentsStore[/** @type {string} */ (level)];
  }

  /** @param {number} volume */
  setVolume(volume) {
    this.state.volume = volume;
    // Through the audio graph wherever there is one (it goes above 100 %); else the element's volume.
    if (SET_VOLUME_USING_NODE) {
      if (this.player && (!this.syncedAudioPlayer || !this.syncedAudioPlayer.setVolume(1))) {
        this.player.volume = 1;
      }
      this.audioOutput?.updateVolume(volume);
    } else if (this.player && (!this.syncedAudioPlayer || !this.syncedAudioPlayer.setVolume(volume))) {
      this.player.volume = volume;
    }
  }

  /** @return {number} */
  get volume() {
    return this.state.volume;
  }

  /** @param {number} value */
  set volume(value) {
    this.interfaceController.setVolume(value);
  }

  /** @return {number} */
  get playbackRate() {
    return this.player?.playbackRate || this.state.playbackRate;
  }

  /**
   * Sets the playback rate within [0.1, options.maxPlaybackRate], whoever asks.
   * @param {number} value
   */
  set playbackRate(value) {
    this.setPlaybackRate(value);
  }

  /**
   * Sets the playback rate as the setter does; a speed preset may go past the cap, silent, up to Firefox's limit.
   * @param {number} value
   * @param {boolean} [silentAllowed] - Whether a rate beyond the sound (up to SILENT_MAX_PLAYBACK_RATE) is wanted.
   */
  setPlaybackRate(value, silentAllowed = false) {
    // Firefox refuses a media element anything past 16.
    const max = silentAllowed ? SILENT_MAX_PLAYBACK_RATE : this.options.maxPlaybackRate;
    value = Utils.clamp(value, 0.1, max);
    this.state.playbackRate = value;
    if (this.player) {
      this.player.playbackRate = value;
    }
    if (this.syncedAudioPlayer) {
      this.syncedAudioPlayer.setPlaybackRate(value);
    }
    this.interfaceController.updatePlaybackRate();
  }

  /** @return {HTMLVideoElement|null} */
  get currentVideo() {
    return this.player?.getVideo() || null;
  }

  /** @return {number} */
  get videoWidth() {
    return this.player?.getVideo().videoWidth || 0;
  }

  /** @return {number} */
  get videoHeight() {
    return this.player?.getVideo().videoHeight || 0;
  }
}

