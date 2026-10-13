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
import {EnvUtils} from './utils/EnvUtils.mjs';
import {Localize} from './modules/Localize.mjs';
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
import {aheadOfPlayhead} from './network/BufferAhead.mjs';
import {downloadingOutside, KEEP_AHEAD_S, KEEP_BEHIND_S, shouldConcentrate, URGENT_PARALLEL} from './network/PlayheadFirst.mjs';
import {SILENT_MAX_PLAYBACK_RATE} from './options/KeybindUtils.mjs';
import {chooseToRelease, DEFAULT_BUDGET_BYTES, DISK_ONLY_ROOM_BYTES, HIGH, isFull, KEEP_IN_RAM_ONLY_WINDOW, KEEP_ON_DISK_WINDOW, LOW, shareOf, weightOf} from './network/MemoryBudget.mjs';
import {VideoTransformUtils} from './utils/VideoTransformUtils.mjs';
import {VideoLevel} from './players/Levels.mjs';


/**
 * Main FastStream video player client. Handles playback, UI, options, and state management.
 * @extends EventEmitter
 */
const SET_VOLUME_USING_NODE = EnvUtils.isWebAudioSupported();

// The quality menu's id of one of the page's qualities, followed by its index in
// VideoSource.qualities (getPageQualityLevels). No player's own level id starts so.
const PAGE_QUALITY_LEVEL = 'page-quality:';

// How often recoverPlayer builds the player again for one source: at most RECOVERY_LIMIT
// times in RECOVERY_WINDOW_MS. A stream that fails again at once after each rebuild ends in
// the load error within seconds; one that plays on between rare errors keeps recovering.
const RECOVERY_LIMIT = 3;
const RECOVERY_WINDOW_MS = 120000;
// How often the seek preview's player is built again after an error: at most
// PREVIEW_RELOAD_LIMIT times in RECOVERY_WINDOW_MS, as recoverPlayer. One that failed each
// time was built anew every second for as long as the video was open; one that plays on
// between rare errors is built again after each.
const PREVIEW_RELOAD_LIMIT = 3;
// How long a stream may stay stuck in its last seconds before autoplay takes it as ended
// (watchEndStall).
const EndStallMs = 3000;

export class FastStreamClient extends EventEmitter {
  /**
   * Constructs a FastStreamClient instance.
   */
  constructor() {
    super();
    this.version = EnvUtils.getVersion();

    this.options = {
      autoPlay: false,
      maxSpeed: -1,
      maxVideoSize: 5000000000, // 5GB max size
      ramBudget: DEFAULT_BUDGET_BYTES, // downloaded video kept in RAM, all players together
      bufferToDisk: true, // beyond the RAM budget: on disk, or (false) let go
      bufferAhead: 300,
      bufferBehind: 20,
      freeFragments: true,
      downloadAll: false,
      freeUnusedChannels: true,
      storeProgress: false,
      disableLoadProgress: false,
      previewEnabled: true,
      decodingAwareQuality: true,
      autoplayNext: false,
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
      toolSettings: Utils.mergeOptions(DefaultToolSettings, {}),
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
      // No next video because the page is its series' last episode (pollPrevNext).
      seriesEnd: false,
      fullscreen: false,
      miniplayer: false,
      windowedFullscreen: false,
      // The browser window made fullscreen for the next episode (InterfaceController
      // carryFullscreen): a fullscreen to the user, and to the next one again.
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
    // The other FastStream players: one the user watches and that is short of video gets
    // the network (PlayerPeers.shouldYield, DownloadManager.setYield).
    this.peers = new PlayerPeers({
      state: () => ({playing: !!this.state.playing, ahead: this.getVideoAhead(),
        ramBytes: this.downloadManager?.ramBytes?.() || 0}),
      onChange: () => {
        if (!this.destroyed) this.downloadManager.setYield(this.peers.shouldYield(), !this.state.playing);
      },
    });
    this.peers.start();
    this.onPeersVisibility = () => this.updatePeers();
    document.addEventListener('visibilitychange', this.onPeersVisibility);
    this.sourcesBrowser = new SourcesBrowser(this);
    this.vpnPrompt = new VpnPrompt(this);
    this.audioAnalyzer = new AudioAnalyzer(this);
    this.frameExtractor = new PreviewFrameExtractor(this);
    if (EnvUtils.isWebAudioSupported()) {
      this.audioOutput = new AudioOutput();
      this.audioContext = new AudioContext();
      this.audioOutput.setupNodes(this.audioContext);
    }

    DOMElements.playerContainer.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.escapeAll();
        e.preventDefault();
        e.stopPropagation();
      }
    });

    this.player = null;
    this.syncedAudioPlayer = null;
    this.previewPlayer = null;
    this.sourceChange = null;
    // Counts the sources asked for, and holds the streams to try should the latest one
    // fail before it shows anything (setSource()).
    this.sourceRequests = 0;
    this.fallbacks = {request: 0, sources: []};
    // A source's decode failures, kept over its own reload (reloadWithoutFailedCodec).
    this.carriedDecodeFailures = null;
    // The source that has shown something (LOADEDDATA), and when the player was built again
    // for it after an error (recoverPlayer).
    this.playedSource = null;
    this.recoveries = {url: null, times: []};
    // The last decode error recoverPlayer built the player again for (BrokenMedia.mjs).
    this.lastDecodeFailure = null;
    this.previewPlayerSetup = null;
    // Counts play() and pause() calls: the later one wins (play()).
    this.playPauseTurn = 0;
    // The audio context startAudio() is waiting on, if any.
    this.startingAudioContext = null;
    this.saveSeek = true;
    this.pastSeeks = [];
    this.pastUnseeks = [];
    this.fragmentsStore = {};
    // The source (recoverySourceURL) playDirectly handed to Firefox's own player.
    this.playedDirectly = null;
    // The source whose own time is still to be applied: nothing plays before it is
    // (setSourceInternal).
    this.startPending = null;
    this.mainloop();
  }

  /**
   * Gets the LevelManager instance.
   * @return {LevelManager}
   */
  getLevelManager() {
    return this.levelManager;
  }

  /**
   * Sets up the client, loading options and progress memory.
   * @return {Promise<void>}
   */
  async setup() {
    await this.downloadManager.setup();
    if (SecureMemory.isSupported()) {
      const progressMemory = new SecureMemory('faststream-progress');
      try {
        await progressMemory.setup();
        this.progressMemory = progressMemory;
      } catch (e) {
        console.warn('Failed to setup secure progress memory', e);
      }
    }

    if (this.progressMemory) {
      await this.progressMemory.pruneOld(Date.now() - 1000 * 60 * 60 * 24 * 365); // 1 year
    }

    try {
      Utils.loadAndParseOptions('toolSettings', DefaultToolSettings).then((settings) => {
        this.options.toolSettings = settings;
        this.interfaceController.updateToolVisibility();
      }).catch((e) => console.error('Loading the tool settings failed', e));
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * Polls for previous/next video availability.
   * @return {Promise<Object|null>} Playlist poll response.
   */
  pollPrevNext() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({type: MessageTypes.REQUEST_PLAYLIST_POLL}, (response) => {
        if (!response) {
          resolve(null);
          return;
        }
        // No next because the series ended there (content.js isSeriesEnd).
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

  /**
   * Sets up polling for previous/next video state.
   */
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

  /**
   * Determines if all fragments should be downloaded.
   * @return {boolean}
   */
  shouldDownloadAll() {
    return (this.options.downloadAll && this.hasDownloadSpace) || this.source?.loadedFromArchive;
  }

  /**
   * Marks that the user has interacted with the player.
   */
  userInteracted() {
    if (!this.state.hasUserInteracted) {
      this.state.hasUserInteracted = true;
      this.interfaceController.setStatusMessage(StatusTypes.REQINTERACTION, null);
    }
  }

  /**
   * Checks if user interaction is needed to start playback.
   *
   * What the interaction unlocks is FastStream downloading the video itself, ahead of
   * where it is playing. Direct playback hands the url to the browser and downloads
   * nothing of its own, so there is nothing for an interaction to unlock and nothing to
   * ask the user for.
   *
   * @return {boolean}
   */
  needsUserInteraction() {
    if (this.source && this.source.mode === PlayerModes.DIRECT) {
      return false;
    }

    return this._needsUserInteraction && !this.state.hasUserInteracted && !this.state.playing;
  }

  /**
   * Sets whether user interaction is needed.
   * @param {boolean} value
   */
  setNeedsUserInteraction(value) {
    this._needsUserInteraction = value;
  }

  /**
   * Enables or disables seek saving.
   * @param {boolean} value
   */
  setSeekSave(value) {
    this.saveSeek = value;
  }

  /**
   * Resets failed fragments to waiting status.
   */
  resetFailed() {
    for (const levelID in this.fragmentsStore) {
      if (Object.hasOwn(this.fragmentsStore, levelID)) {
        this.fragmentsStore[levelID].forEach((fragment) => {
          if (fragment.status === DownloadStatus.DOWNLOAD_FAILED) {
            fragment.status = DownloadStatus.WAITING;
          }
        });
      }
    }
    this.interfaceController.updateFragmentsLoaded();
  }

  /**
   * Destroys the client and cleans up resources.
   */
  destroy() {
    this.destroyed = true;
    document.removeEventListener('visibilitychange', this.onPeersVisibility);
    this.peers.stop();
    this.resetPlayer();
    this.downloadManager.destroy();
    this.interfaceController.destroy();
    if (this.progressMemory) {
      this.progressMemory.destroy();
      this.progressMemory = null;
    }
  }

  /**
   * Sets player options and updates UI and filters.
   * @param {Object} options - Player options.
   */
  setOptions(options) {
    this.options.storeProgress = options.storeProgress;
    this.options.downloadAll = options.downloadAll;
    this.options.autoEnableBestSubtitles = options.autoEnableBestSubtitles;
    this.options.mpvMode = !!options.mpvMode;
    this.options.mpvPausePage = !!options.mpvPausePage;
    this.options.maxSpeed = options.maxSpeed;
    this.options.maxVideoSize = options.maxVideoSize;
    this.options.ramBudget = options.ramBudget;
    // Only the buffer: watch progress and saving keep their own storage.
    this.options.bufferToDisk = options.bufferToDisk !== false;
    this.downloadManager?.setBufferToDisk(this.options.bufferToDisk);
    // Seconds; an empty field (-1) is no limit: the whole video ahead, everything played kept.
    this.options.bufferAhead = FastStreamClient.bufferSeconds(options.bufferAhead);
    this.options.bufferBehind = FastStreamClient.bufferSeconds(options.bufferBehind);
    // At once, as "Buffer ahead" is (updateHasDownloadSpace): a change waited for the next
    // video. A private window's warning sets both from the options the same way.
    this.state.bufferBehind = this.options.bufferBehind;
    this.options.seekStepSize = options.seekStepSize;
    this.options.singleClickAction = options.singleClickAction;
    this.options.doubleClickAction = options.doubleClickAction;
    this.options.tripleClickAction = options.tripleClickAction;
    this.options.visChangeAction = options.visChangeAction;
    this.options.miniSize = options.miniSize;
    this.options.miniPos = options.miniPos;
    this.options.maximumDownloaders = options.maximumDownloaders;

    if (sessionStorage && sessionStorage.getItem('autoplayNext') !== null) {
      this.options.autoplayNext = sessionStorage.getItem('autoplayNext') == 'true';
    } else {
      this.options.autoplayNext = options.autoplayNext;
    }

    this.options.videoZoom = options.videoZoom;
    this.options.videoAspectRatio = options.videoAspectRatio || AspectRatios.AUTO;
    this.options.previewEnabled = options.previewEnabled;
    this.options.videoDelay = options.videoDelay;
    document.body.dataset.theme = options.colorTheme;
    // save color theme to local storage
    localStorage.setItem('faststream-color-theme', options.colorTheme);

    this.loadProgressData();

    if (this.options.previewEnabled) {
      this.setupPreviewPlayer().catch((e) => {
        console.error(e);
      });
    } else {
      if (this.previewPlayer) {
        this.previewPlayer.destroy();
        this.previewPlayer = null;
        this.interfaceController.resetPreviewVideo();
      }
    }

    this.options.defaultQuality = options.defaultQuality;
    // Read by LevelManager at the next pick; what is playing keeps its version.
    this.options.decodingAwareQuality = options.decodingAwareQuality !== false;

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

    // Unconditional: MPV mode gates the mpv button and may have been toggled
    // while a video is open, so tool visibility has to be recomputed even
    // when toolSettings itself did not change.
    this.interfaceController.updateToolVisibility();

    this.updateHasDownloadSpace();
    this.interfaceController.updateAutoNextIndicator();

    this.syncedAudioPlayer?.setVideoDelay(this.options.videoDelay);
  }

  /**
   * Applies the zoom, flip, rotation and aspect ratio to the video elements.
   */
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

  /**
   * Clears all subtitle tracks.
   */
  clearSubtitles() {
    this.interfaceController.subtitlesManager.clearTracks();
  }

  /**
   * Loads and activates a subtitle track.
   * @param {Object} subtitleTrack
   * @param {boolean} [autoset=false]
   * @return {Promise<void>}
   */
  loadSubtitleTrack(subtitleTrack, autoset = false) {
    return this.interfaceController.subtitlesManager.loadTrackAndActivateBest(subtitleTrack, autoset);
  }

  /**
   * Updates the duration and download space indicators.
   */
  updateDuration() {
    this.interfaceController.durationChanged();
    this.updateHasDownloadSpace();
  }

  /**
   * Updates the current playback time and saves progress.
   * @param {number} time
   */
  updateTime(time) {
    this.state.currentTime = time;
    this.interfaceController.timeUpdated();

    // Not for a live stream: its times mean nothing the next time it is opened.
    if (this.options.storeProgress && this.progressData && time !== this.progressData.lastTime && !this.disableProgressSave &&
      !this.isLive()) {
      const now = Date.now();
      if (now - this.lastProgressSave > 1000) {
        this.lastProgressSave = now;
        this.progressData.lastTime = time;
        this.saveProgressData();
      }
    }
  }

  /**
   * Seeks the preview player to a given time.
   * @param {number} time
   */
  seekPreview(time) {
    if (this.previewPlayer) {
      this.previewPlayer.currentTime = time;
      this.updatePreview();
    }
  }

  /**
   * Hides the preview video.
   */
  hidePreview() {
    if (this.previewPlayer) {
      this.previewPlayer.getVideo().style.opacity = 0;
      clearTimeout(this.previewPlayerLoadingTimeout);
      this.previewPlayerLoadingTimeout = setTimeout(() => {
        // previewPlayer can go null (resetPlayer/destroy) while this timeout
        // is still pending - none of those paths clear it, since it's a
        // plain UI debounce rather than something tied to the player's
        // lifecycle.
        if (this.previewPlayer && parseFloat(this.previewPlayer.getVideo().style.opacity) === 0) {
          DOMElements.seekPreviewVideo.classList.add('loading');
        }
      }, 200);
    }
  }

  /**
   * Shows the preview video.
   */
  showPreview() {
    if (this.previewPlayer) {
      this.previewPlayer.getVideo().style.opacity = 1;
      DOMElements.seekPreviewVideo.classList.remove('loading');
      clearTimeout(this.previewPlayerLoadingTimeout);
    }
  }

  /**
   * Updates the preview video visibility based on buffer state.
   */
  updatePreview() {
    if (!this.previewPlayer) return;

    if (this.previewPlayer.getVideo().readyState > 1) {
      this.showPreview();
      return;
    }

    let shouldShowPreview = false;
    // check if time is buffered
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

  /**
   * Updates available quality levels and language tracks.
   */
  updateQualityLevels() {
    this.interfaceController.updateQualityLevels();
    this.interfaceController.updateLanguageTracks();
    this.updateHasDownloadSpace();
  }

  /**
   * Changes the language for video or audio tracks.
   * @param {string} type - 'video' or 'audio'.
   * @param {string} language - Language code.
   */
  changeLanguage(type, language) {
    const levels = type === 'video' ? this.getVideoLevels() : this.getAudioLevels();
    if (!levels) return;
    const currentLevelID = type === 'video' ? this.getCurrentVideoLevelID() : this.getCurrentAudioLevelID();
    const currentLevel = levels.get(currentLevelID);
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
      this.levelManager.pickVideoLevel(matchingLevels, currentLevel?.height) :
      this.levelManager.pickAudioLevel(matchingLevels);

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
    // All of it: what is kept behind is what the budget lets go of first
    // (MemoryBudget.chooseToRelease), so it takes nothing from the room ahead.
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

  /**
   * Updates the available download space and buffer indicators.
   */
  updateHasDownloadSpace() {
    const levels = this.getVideoLevels();
    if (!levels) return;

    const currentVideoLevelID = this.getCurrentVideoLevelID();
    const level = levels.get(currentVideoLevelID);
    if (!level) return;

    if (this.source?.loadedFromArchive) {
      return;
    }

    let bitrate = level.bitrate;
    const fragments = this.fragments;
    if (fragments) {
      bitrate = Utils.measuredBitrate(fragments) ?? bitrate;
    }
    // Nothing of the buffer goes to disk - a private window, or "Keep video on disk" off
    // (2026-10-10): what is kept has to fit in this player's share of the RAM budget, below
    // where it lets go (MemoryBudget.LOW), in bits. Kept beyond it, the budget let go of the
    // far end and the downloads ahead fetched it again, round and round. No limit: Infinity.
    const ramOnly = EnvUtils.isIncognito() || this.options.bufferToDisk === false;
    const ramRoom = ramOnly ? this.memoryShare().share * 8 * LOW : Infinity;

    if (EnvUtils.isIncognito()) {
      // Only for a predownload asked for: without it there is nothing to fit, and turned on
      // later, it warns then.
      if (this.hasDownloadSpace && this.options.downloadAll) {
        this.state.bufferBehind = this.options.bufferBehind;
        this.state.bufferAhead = this.options.bufferAhead;
        // Without a limit on either, the whole video is buffered all the same: nothing to say.
        const windowSeconds = this.state.bufferBehind + this.state.bufferAhead;
        if (Number.isFinite(windowSeconds)) {
          this.interfaceController.setStatusMessage('info', Localize.getMessage('player_buffer_incognito_warning', [StringUtils.formatDuration(windowSeconds)]), 'warning', 5000);
        }
        this.hasDownloadSpace = false;
      }
    } else {
      if (!Number.isFinite(this.duration)) {
        // A live stream has no size to fit, and is freed behind playback as it plays. Its
        // infinite duration made it "too big" on its first tick: a storage warning on every
        // live stream, and everything downloaded so far pinned for the session.
        this.hasDownloadSpace = false;
      } else if (bitrate && this.duration) {
        // With nothing on disk, the room is RAM: the disk's free space does not count.
        let storageAvailable = ramOnly ? ramRoom : (this.storageAvailable * 8) * 0.6;
        // 0 is a limit too: nothing predownloaded (an empty field, -1, is none).
        if (this.options.maxVideoSize >= 0 && this.options.maxVideoSize * 8 < storageAvailable) {
          storageAvailable = this.options.maxVideoSize * 8;
        }

        const canBufferTime = storageAvailable / bitrate / 1.1;
        let bufferAhead = Math.max(Math.floor(canBufferTime - this.state.bufferBehind), 0);

        if (bufferAhead < this.options.bufferAhead || !this.options.downloadAll) {
          this.state.bufferAhead = this.options.bufferAhead;
          bufferAhead = 0;
        } else if (bufferAhead > 0 && Math.abs(this.state.bufferAhead - bufferAhead) > 30) {
          this.state.bufferAhead = Math.max(bufferAhead, this.options.bufferAhead);
        }

        const newHasDownloadSpace = (bitrate * this.duration) * (this.hasDownloadSpace ? 1 : 1.1) < storageAvailable;
        // Only with predownload on: without it the maximum size is not used (Buffer ahead
        // decides), yet a size below the video's said "Video size exceeds limits" on every
        // video and pinned what had been downloaded (#378, a size of 10 MB). Without it there
        // is no room to keep track of either, so predownload turned on later finds the video
        // too big the way a predownload running out of room does: warned, what it has kept.
        if (!newHasDownloadSpace && this.hasDownloadSpace && this.options.downloadAll) {
          // Storage just ran out mid-session. Grandfather in everything
          // already downloaded so the windowed bufferAhead/bufferBehind
          // fallback below only holds back *future* downloads - it must
          // never be allowed to delete a fragment that's already fully
          // buffered, or a video that looked completely buffered a moment
          // ago would suddenly lose most of its buffer the next time
          // freeFragments() runs (see FastStreamClient.freeFragments).
          // With nothing on disk, nothing is pinned: the RAM budget could not let go of it.
          const grandfather = (frag) => {
            if (frag && frag.status === DownloadStatus.DOWNLOAD_COMPLETE) {
              frag.addReference(ReferenceTypes.GRANDFATHERED);
            }
          };
          // The quality on now may have no fragments yet (just switched to)
          if (fragments && !ramOnly) fragments.forEach(grandfather);
          if (this.audioFragments && !ramOnly) this.audioFragments.forEach(grandfather);
          const windowSeconds = this.state.bufferBehind + Math.min(this.state.bufferAhead, this.ramAheadSeconds(ramRoom, bitrate));
          if (Number.isFinite(windowSeconds)) {
            this.interfaceController.setStatusMessage(StatusTypes.INFO, Localize.getMessage('player_buffer_storage_warning', [StringUtils.formatDuration(windowSeconds)]), 'warning', 5000);
          }
        }
        this.hasDownloadSpace = newHasDownloadSpace || !this.options.downloadAll;
      } else {
        this.hasDownloadSpace = true;
      }
    }

    // Ahead, too, only what fits (a private window kept "Buffer ahead", 300 s, whatever the
    // budget: a small one let go of it and fetched it again, round and round).
    if (ramOnly && this.state.bufferAhead > this.ramAheadSeconds(ramRoom, bitrate)) {
      this.state.bufferAhead = this.ramAheadSeconds(ramRoom, bitrate);
    }

    // if (!this.hasDownloadSpace) {
    //   this.audioAnalyzer.disableBackground();
    //   this.frameExtractor.disableBackground();
    // } else {
    //   this.audioAnalyzer.enableBackground();
    //   this.frameExtractor.enableBackground();
    // }
  }

  /**
   * Adds a new source and optionally sets it as current.
   * @param {Object} source - Source object.
   * @param {boolean} [setSource=false]
   * @param {Object[]} [fallbacks=[]] - When it is set: the streams to try in turn should it
   *   fail before it shows anything.
   * @return {Promise<Object>} The added source.
   */
  async addSource(source, setSource = false, fallbacks = []) {
    source = source.copy();

    console.log('addSource', source);
    source = this.sourcesBrowser.addSource(source);
    if (setSource) {
      await this.setSource(source, fallbacks);
    }
    this.sourcesBrowser.updateSources();
    return source;
  }

  /**
   * Sets the autoPlay option.
   * @param {boolean} value
   */
  setAutoPlay(value) {
    console.log('setAutoPlay', value);
    this.options.autoPlay = value;
  }

  /**
   * Sets up the preview player for seek preview.
   * @return {Promise<void>}
   */
  async setupPreviewPlayer() {
    if (!this.player || this.previewPlayer || !this.options.previewEnabled) {
      return;
    }

    // Building one takes several turns, and the field that says one exists is only filled
    // in at the end of them. A second caller arriving in between — an options update while
    // a source is being set, say — would build another and leave its video in the seek
    // preview alongside the first, so callers join the build that is already running.
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

  /**
   * Builds the preview player for the source that is playing.
   * @return {Promise<void>}
   */
  async buildPreviewPlayer() {
    const source = this.player.getSource();
    if (!source) {
      return;
    }

    const previewPlayer = await this.playerLoader.createPlayer(source.mode, this, {
      isPreview: true,
    });

    try {
      await previewPlayer.setup();
      this.bindPreviewPlayer(previewPlayer);

      await previewPlayer.setSource(source);
    } catch (e) {
      // Nothing else holds it: its video and its loader, which may go on fetching, lived on
      // for the page's life, one for each failed build (glm's review, 2026-10-13).
      try {
        previewPlayer.destroy();
      } catch (destroyError) {
        console.warn('Could not destroy a preview player that failed to build', destroyError);
      }
      throw e;
    }

    // The video being previewed can be torn down or replaced while its preview is still
    // being built, and a preview of something that is no longer playing does not belong
    // in the page. Nor does one that was switched off while it was being built, which
    // setOptions() could not destroy because it was not stored yet.
    if (this.previewPlayer || !this.options.previewEnabled || this.player?.getSource() !== source) {
      previewPlayer.destroy();
      return;
    }

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
      return this.currentVideo.currentTime + this.options.videoDelay / 1000;
    });
    this.audioOutput.setupNodes(this.audioContext);
    this.audioOutput.getInputNode().connectFrom(this.audioOutputNode);
    this.audioOutput.getOutputNode().connect(this.audioContext.destination);
  }

  /**
   * Sets the current source and initializes the player.
   *
   * Setting a source takes many turns: a player is built, handed the source, given a
   * video element in the page and an audio context of its own. Two of these running at
   * once would each do all of that, each leaving its video in the page and its audio
   * context over the other's, so a source that is asked for while one is being set waits
   * its turn.
   *
   * @param {Object} source - Source object.
   * @param {Object[]} [fallbacks=[]] - The streams to try in turn should it fail before it
   *   shows anything: the others the player picked it from. None for a source chosen by
   *   hand, and a later request drops those of every earlier one.
   * @param {{play?: boolean}} [start={}] - play: it plays once it has started, autoplay or
   *   not (the same video built again, which the user was watching).
   * @return {Promise<void>}
   */
  setSource(source, fallbacks = [], start = {}) {
    const request = ++this.sourceRequests;
    // A source loaded anew in its own player may be handed over again (a later reload of the
    // same URL); the hand-over's source is DIRECT and keeps the guard.
    if (source?.mode !== PlayerModes.DIRECT) {
      this.playedDirectly = null;
    }
    const run = () => this.setSourceInternal(source, {request, sources: fallbacks.slice()}, start);
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
   * @param {Object} source - Source object.
   * @param {{request: number, sources: Object[]}} fallbacks - Which request this is, and the
   *   streams to try should it fail before it shows anything.
   * @param {{play?: boolean}} [start={}] - See setSource().
   * @return {Promise<void>}
   */
  async setSourceInternal(source, fallbacks, start = {}) {
    // Whether the player took the source: a throw before that is a stream that failed.
    let taken = false;
    try {
      source = source.copy();

      let timeFromURL = URLUtils.get_param(source.url, 'faststream-timestamp');
      timeFromURL = parseInt(timeFromURL);

      if (isNaN(timeFromURL)) {
        timeFromURL = null;
      }

      // Strip out the timestamp from the URL
      if (timeFromURL !== null) {
        try {
          const url = new URL(source.url);
          url.searchParams.delete('faststream-timestamp');
          source.url = url.toString();
        } catch (e) {
          console.error(e);
        }
      }

      // The time in the player page's own address is for the video the page was opened
      // for: it was applied to every source set in the player afterwards (a pick from the
      // sources browser), which also skipped that source's remembered time. It is used up
      // once applied, so a fallback stream that replaces one that failed still gets it.
      let timeFromPage = false;
      if (timeFromURL === null && !this.pageTimestampUsed) {
        timeFromURL = URLUtils.get_param(window.location.href, 'faststream-timestamp');
        timeFromURL = parseInt(timeFromURL);
        timeFromPage = true;
      }


      const autoPlay = this.options.autoPlay;

      console.log('setSource', source);
      await this.resetPlayer();
      this.restoreCarriedDecodeFailures(source);
      this.source = source;
      // Only once the last player is torn down: its failure is not this source's.
      this.fallbacks = fallbacks;
      // Came it through Firefox VPN, which leaves FastStream's requests out? (VpnPrompt.mjs)
      this.vpnPrompt?.check(source);

      if (source.defaultLevelInfo?.level !== undefined) {
        this.getLevelManager().setCurrentVideoLevelID(source.defaultLevelInfo.level);
      }

      // audioLevel, as an archive's source has it (SaveManager): this read `audio`, and an
      // archive's audio track was never restored.
      if (source.defaultLevelInfo?.audioLevel !== undefined) {
        this.getLevelManager().setCurrentAudioLevelID(source.defaultLevelInfo.audioLevel);
      }

      this.storageAvailable = await EnvUtils.getAvailableStorage();

      const options = {};
      this.player = await this.playerLoader.createPlayer(source.mode, this, options);

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
        // The seek preview is an extra: one that fails to build must not cost the video
        // the rest of this setup.
        await this.setupPreviewPlayer().catch((e) => {
          console.warn('The preview player failed to build', e);
        });

        this.frameExtractor.updateBackground();
      }

      this.updateVideoTransform();

      this.interfaceController.updateToolVisibility();

      // A time the source came with is where it starts, and nothing plays before it is
      // applied: the place a player built again after an error was at (recoverPlayer), where
      // Firefox's own player takes over (playDirectly), a page's timestamp. Autoplay, and the
      // rebuild's resume, started the new player from 0 at once, and the time came a second
      // or more later, after the remembered-time lookup and the init hook's next poll: a film
      // built again an hour in played its opening, then jumped back (kinoger, 2026-10-12).
      const startTime = timeFromURL || 0;
      const playOnStart = autoPlay || !!start.play;
      this.startPending = startTime ? source : null;

      this.state.autoPlayTriggered = false;
      if (playOnStart && !startTime) {
        this.play().then(() => {
          this.state.autoPlayTriggered = true;
        }).catch((e) => console.warn('Autoplay failed', e));
      }

      // A time of its own does not wait for the remembered one it overrides: that lookup
      // (two PBKDF2 hashes) is made once the time is applied.
      (startTime ? Promise.resolve() : this.loadProgressData()).then(async () => {
        // Another source came in meanwhile: this one's time and progress are not for it,
        // and switching progress saving off here would switch it off for that one.
        if (this.source !== source) return;
        this.disableProgressSave = true;

        // Wait for the player to be ready
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
          this.startPending = null;
        } else if (this.options.storeProgress && this.progressData && !this.options.disableLoadProgress) {
          const lastTime = this.progressData.lastTime;
          // Not a live stream: a DASH one's duration is Infinity, before which every time is,
          // and it was sought to where it was left, far outside its live window by the next day.
          if (lastTime && !this.isLive() && lastTime < this.duration - 5) {
            this.setSeekSave(false);
            this.currentTime = lastTime;
            this.setSeekSave(true);
          }
        }

        this.disableProgressSave = false;
        if (startTime) {
          this.loadProgressData();
        }

        if (playOnStart && !this.state.autoPlayTriggered) {
          this.play().then(() => {
            this.state.autoPlayTriggered = true;
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
      AlertPolyfill.errorSendToDeveloper(e);
      console.error(e);
      // Its player could not be built or given the source: that stream failed as surely
      // as one whose player reports an error, and the next of those picked from plays
      // (tryNextSource), else the load error shows. Not for a later source's failure, nor
      // one that came after the source was taken (the audio tools, say): the video may
      // well play.
      if (!taken && this.fallbacks === fallbacks && fallbacks.request === this.sourceRequests && !this.tryNextSource()) {
        this.failedToLoad(Localize.getMessage('player_error_load'));
      }
    }

    DOMElements.playerContainer.style.backgroundColor = 'black';

    this.emit('setsource', this);
  }


  /**
   * Sets up a hook to wait for player initialization.
   * @return {Promise<void>}
   */
  setupInitHook() {
    return new Promise((resolve) => {
      let interval = 0;

      const hook = () => {
        if (!this.duration || !this.currentVideo || this.currentVideo.readyState === 0) return;
        clearInterval(interval);
        this.context.off(DefaultPlayerEvents.DURATIONCHANGE, hook);
        this.context.off(DefaultPlayerEvents.LOADEDMETADATA, hook);
        resolve();
      };

      interval = setInterval(hook, 1000);
      // resetPlayer() stops it: a source that never got a picture left it running until some
      // later source got one.
      this.initHookInterval = interval;

      this.context.on(DefaultPlayerEvents.DURATIONCHANGE, hook);
      // The moment the element has its metadata, before its first frame: MP4Player's duration
      // comes before that (readyState still 0), and the hook then waited for its next poll.
      this.context.on(DefaultPlayerEvents.LOADEDMETADATA, hook);
      hook();
    });
  }

  /**
   * Loads progress data from secure memory. A caller while a lookup runs gets that lookup:
   * setOptions() starts one too, and the source's own, made meanwhile, returned at once with
   * nothing. The remembered time was then never applied, and the next save wrote over it.
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
   * @param {Object} player
   * @return {Promise<void>}
   */
  async readProgressData(player) {
    // The lookup takes a while (two PBKDF2 hashes). If another video is set meanwhile,
    // resetPlayer() has cleared this state for it, and writing this video's record now would
    // make the next video start at this one's time and save its progress into this record.
    this.disableProgressSave = true;
    let hashes = null;
    let progressData = null;
    try {
      hashes = await this.progressMemory.getHashes(player.getSource().identifier);
      if (this.player !== player) return;
      progressData = (await this.progressMemory.getFile(hashes)) || {
        lastTime: 0,
      };
    } catch (e) {
      // A record that cannot be read (IndexedDB failing, or data that does not decrypt) is
      // no remembered time. Thrown on, it stopped the rest of the video's setup, which
      // waits on this: the seek to the time in its URL, and autoplay. Without hashes there
      // is no record to save to.
      console.warn('Could not read the remembered time', e);
      // A record that does not decrypt is lost anyway: start at 0 and save over it. A read
      // that failed (IndexedDB having a moment) says nothing about the record, and saving
      // this video's time from 0 about a second later overwrote an intact one: keep no
      // progress for this video instead.
      progressData = hashes && e?.unusableRecord ? {lastTime: 0} : null;
    }
    if (this.player !== player) return;
    this.progressHashesCache = hashes;
    this.progressData = progressData;
    this.disableProgressSave = false;
  }

  /**
   * Saves progress data to secure memory.
   * @return {Promise<void>}
   */
  async saveProgressData() {
    if (this.disableProgressSave || !this.progressData) {
      return;
    }

    // Called every second from updateTime, which nothing awaits: a failing write was an
    // unhandled rejection each time.
    try {
      await this.progressMemory.setFile(this.progressHashesCache, this.progressData);
    } catch (e) {
      console.warn('Could not save the remembered time', e);
    }
  }

  /**
   * Gets the next fragment to download (video or audio).
   * @return {Object|null} Next fragment.
   */
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
   * Gets the next fragment to download for a track.
   * @param {Object} currentFragment
   * @return {Object|null}
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
   * Gets the next waiting fragment forward from index.
   * @param {Array} fragments
   * @param {number} index
   * @return {Object|null}
   */
  getNextForward(fragments, index) {
    for (let i = index; i < fragments.length; i++) {
      const fragment = fragments[i];
      if (fragment && fragment.status === DownloadStatus.WAITING) {
        return fragment;
      }
    }
  }

  /**
   * Gets the next waiting fragment backward from index.
   * @param {Array} fragments
   * @param {number} index
   * @return {Object|null}
   */
  getNextBackward(fragments, index) {
    for (let i = index - 1; i >= 0; i--) {
      const fragment = fragments[i];
      if (fragment && fragment.status === DownloadStatus.WAITING) {
        return fragment;
      }
    }
  }

  /**
   * Main update loop for the player client.
   */
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
   * Keeps the downloaded video this player holds in RAM within its share of the RAM budget
   * (MemoryBudget: the user's setting, 2 GB by default, for all FastStream players; the one
   * the user watches gets more). Over HIGH of its share it lets go of fragments until it is
   * down to LOW, those furthest behind the playhead first, then the furthest ahead, never the
   * next seconds: a normal window writes them to disk, a private window - which keeps
   * nothing on disk - lets them go, to be downloaded again when needed. Until it is back
   * down, it starts no downloads ahead (DownloadManager.memoryFull); playback's own requests
   * still go. Fragments of every quality level count, not only the current one's.
   */
  enforceMemoryBudget() {
    // On the client's tick: a throw here skipped the rest of it, the downloads ahead with it.
    try {
      this.keepWithinMemoryBudget();
    } catch (e) {
      console.warn('Could not keep within the RAM budget', e);
    }
  }

  /** enforceMemoryBudget's work. */
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
    if (held - leaving <= share * HIGH) return;

    const time = this.state.currentTime;
    const current = this.currentFragment;
    const candidates = [];
    for (const fragments of Object.values(this.fragmentsStore || {})) {
      for (const fragment of fragments || []) {
        // Init segments (sn -1) every fragment of their level needs.
        if (!fragment || fragment.sn < 0 || fragment.status !== DownloadStatus.DOWNLOAD_COMPLETE || !fragment.canFree()) continue;
        const bytes = manager.ramBytesOf(fragment.getContext());
        if (!(bytes > 0)) continue;
        let start = fragment.start;
        let end = fragment.end;
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          // No times yet (a fragmented MP4's ranges before they are parsed): placed by their
          // distance from the fragment playing, far behind or far ahead; next to it, kept.
          // Never released, they let a private window's RAM grow without a bound.
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
        // One that cannot go to disk (the disk full) is let go of instead of staying in RAM.
        manager.spill(fragment.getContext()).then((stored) => {
          if (!stored && fragment.status === DownloadStatus.DOWNLOAD_COMPLETE && fragment.canFree() &&
              manager.ramBytesOf(fragment.getContext()) > 0) {
            this.freeFragment(fragment);
          }
        }).catch((e) => console.warn('Could not write a fragment to disk', e));
      } else {
        this.freeFragment(fragment);
      }
    }
  }

  /**
   * Tells the other players how this one is doing, and steps aside for them or not.
   */
  updatePeers() {
    if (this.destroyed || !this.peers) return;
    this.peers.announce();
    this.downloadManager?.setYield?.(this.peers.shouldYield(), !this.state.playing);
  }

  /**
   * Cancels the downloads ahead that run outside the next seconds around the playhead
   * (PlayheadFirst): their connections serve the fragment playback needs.
   */
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

  /**
   * Pre-downloads fragments for smooth playback.
   * @return {boolean} True if any fragments were downloaded.
   */
  predownloadFragments() {
    // Another player that the user watches needs the network (DownloadManager.setYield).
    if (this.downloadManager.yielding) {
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

    // Don't pre-download if user is offline
    if (!navigator.onLine) {
      return false;
    }

    // Don't pre-download if user needs to interact
    if (this.needsUserInteraction()) {
      return false;
    }

    // throttle download speed if needed. A limit of 0 downloads nothing ahead: it held
    // downloads back only while something downloaded, so videos still read ahead in bursts.
    // A save fetches its own (SaveFragmentFetcher), and playback's own requests still go.
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

    while (nextDownload) {
      if (nextDownload.canFree() && !this.shouldDownloadAll()) {
        if (nextDownload.start > this.state.currentTime + this.state.bufferAhead) {
          break;
        }

        if (nextDownload.end < this.state.currentTime - this.state.bufferBehind) {
          break;
        }
      }

      // (A live stream's fragments are placed on its own clock: no window there.)
      if (this.concentrating && (this.downloadManager.activeCount() >= URGENT_PARALLEL ||
          (!this.isLive() && nextDownload.start > this.state.currentTime + KEEP_AHEAD_S))) {
        break;
      }

      if (!this.downloadManager.canGetFile(nextDownload.getContext())) {
        break;
      }

      hasDownloaded = true;
      this.player.downloadFragment(nextDownload).catch((e) => {

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
   * Pre-downloads reserved fragments (not freeable).
   * @return {boolean} True if any fragments were downloaded.
   */
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
        this.player.downloadFragment(fragment).catch((e) => {

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
      this.player.downloadFragment(fragment).catch((e) => {

      });
      hasDownloaded = true;
      return true;
    });

    return hasDownloaded;
  }

  /**
   * Gets reserved fragments that are waiting to be downloaded.
   * @param {Array} fragments
   * @return {Array} Reserved fragments.
   */
  getWaitingReservedFragments(fragments) {
    if (!fragments) return [];
    return fragments.filter((fragment) => {
      return fragment && fragment.status === DownloadStatus.WAITING && !fragment.canFree();
    });
  }

  /**
   * Frees fragments that are complete and can be released.
   * @param {Array} fragments
   */
  freeFragments(fragments) {
    for (let i = 0; i < fragments.length; i++) {
      const fragment = fragments[i];
      if (fragment && fragment.status === DownloadStatus.DOWNLOAD_COMPLETE && fragment.canFree()) {
        if (fragment.end < this.state.currentTime - this.state.bufferBehind || fragment.start > this.state.currentTime + this.state.bufferAhead) {
          this.freeFragment(fragment);
        }
      }
    }
  }

  /**
   * Frees a single fragment.
   * @param {Object} fragment
   */
  freeFragment(fragment) {
    this.downloadManager.removeFile(fragment.getContext());
    fragment.status = DownloadStatus.WAITING;
  }

  /**
   * Gets a fragment by level and sequence number.
   * @param {string|number} level
   * @param {number} sn - Sequence number.
   * @return {Object|null}
   */
  getFragment(level, sn) {
    if (!this.fragmentsStore[level]) {
      return null;
    }
    return this.fragmentsStore[level][sn];
  }

  /**
   * Stores a fragment in the fragments store.
   * @param {string|number} level
   * @param {number} sn
   * @param {Object} frag
   */
  makeFragment(level, sn, frag) {
    if (!this.fragmentsStore[level]) {
      this.fragmentsStore[level] = [];
    }

    this.fragmentsStore[level][sn] = frag;
  }

  /**
   * Plays the next of the streams the player picked the current one from, when it failed
   * before it showed anything: the page's thumbnails, an expired or a blocked link. Not
   * after a source was asked for since, nor for one chosen by hand (no streams to try).
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

    console.warn('The stream failed to load, trying the next one', next);
    fallbacks.next = next;
    this.setSource(next, fallbacks.sources).then(() => {
      this.sourcesBrowser.updateSources();
    }).catch((e) => console.error('Switching to the next stream failed', e));
    return true;
  }

  /**
   * Handles failure to load the player or fragments.
   * @param {string} reason
   */
  /**
   * Loads the source playing again, from scratch, once a video codec failed to decode for
   * good (DashPlayer.takeCodecReload): the new player picks without it, as its failures are
   * carried over the reset that would forget them (setSourceInternal). At most once per
   * codec family (LevelManager.noteVideoDecodeFailure), so it cannot loop.
   * @param {Object} player - The player whose error it is: no reload for one already replaced.
   * @return {boolean} Whether it loads the source again.
   */
  reloadWithoutFailedCodec(player) {
    const source = this.source;
    if (!source || player !== this.player) {
      return false;
    }
    console.warn('Loading the source again without the video codec that failed to decode');
    this.carriedDecodeFailures = {url: source.url, failures: this.getLevelManager().getVideoDecodeFailures()};
    this.setSource(source, this.fallbacks.sources).catch((e) => console.error(e));
    return true;
  }

  /**
   * After the reset of a source change: the same source again after a codec failed to
   * decode keeps that failure (reloadWithoutFailedCodec); any other source starts with none.
   * @param {Object} source - The source being set.
   */
  restoreCarriedDecodeFailures(source) {
    const carried = this.carriedDecodeFailures;
    this.carriedDecodeFailures = null;
    if (carried && carried.url === source.url) {
      this.getLevelManager().restoreVideoDecodeFailures(carried.failures);
    }
  }

  /**
   * Builds the player again for the source it plays, at the time it was at, keeping every
   * fragment already downloaded: for an error after the source has shown something. Each
   * such error ended the video for good ("Failed to load video!"), and only reloading the
   * tab - which threw away everything downloaded - played it again. A seek is the usual
   * trigger: Firefox can fail to decode what a seek appends late (bug 2069633), and only a
   * new MediaSource plays again (hls.js's recoverMediaError, Shaka's resetMediaSource do the
   * same). At most RECOVERY_LIMIT times in RECOVERY_WINDOW_MS, so a stream that is really
   * broken still ends in the error, with its reason.
   * @param {Object} player - The player whose error it is.
   * @param {*} reason - The error.
   * @return {boolean} Whether it builds the player again.
   */
  recoverPlayer(player, reason) {
    const source = this.source;
    // A fragment the server keeps refusing: a new player would ask for it again.
    if (isNetworkFailure(reason)) {
      return false;
    }
    if (!source || player !== this.player || this.playedSource !== source ||
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
    // The same place failing to decode again, right after the player was built again for it:
    // the media there is broken. Built once more, it starts past that segment (BrokenMedia.mjs).
    let skip = false;
    // Only where the new player takes a time (not live, an http(s) source).
    if (isDecodeError(reason) && !this.isLive() && /^https?:/i.test(source.url)) {
      if (isSamePlace(this.lastDecodeFailure, url, time, now)) {
        skip = true;
        time = pastBrokenMedia(this.fragments, time);
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
    // The time goes the way a page's does, as the faststream-timestamp parameter that
    // setSourceInternal reads and takes off again (whole seconds). Not for a live stream,
    // which joins at its live edge again, nor for a blob: or data: URL, which takes none.
    if (!this.isLive() && /^https?:/i.test(again.url)) {
      try {
        const withTime = new URL(again.url);
        // Whole seconds: past a broken segment, the second after it ends.
        withTime.searchParams.set('faststream-timestamp', String(skip ? Math.ceil(time) : Math.floor(time)));
        again.url = withTime.toString();
      } catch (e) {
        // Not a URL after all: from the start, still with everything downloaded.
      }
    }
    // The quality and the audio track the user had.
    again.defaultLevelInfo = {
      level: this.getCurrentVideoLevelID() ?? undefined,
      audioLevel: this.getCurrentAudioLevelID() ?? undefined,
    };

    // The next reset keeps what was downloaded: the new player asks for the same
    // fragments, and the stored ones answer at once.
    this.downloadManager.keepStorageOnce();
    // It plays on once at its time: played as soon as it was set, it played from 0 first.
    this.setSource(again, this.fallbacks.sources, {play: wasPlaying})
        .catch((e) => console.warn('Could not resume after building the player again', e));
    return true;
  }

  /**
   * Plays the source in Firefox's own player (PlayerModes.DIRECT, DirectVideoPlayer), for one
   * the MP4 player cannot load in ranges: a server that ignores Range answers each range with
   * the whole file, and loading it in 1 MB ranges downloaded it from byte 0 again for every
   * one (RangeAnswers.mjs). Firefox reads it once. At the time it was at; once per source, so
   * it cannot loop. What is lost there: FastStream's own buffering ahead, the RAM budget and
   * saving the parts already downloaded - it plays, where it ended in an error or downloaded
   * terabytes.
   * @param {Object} player - The player that hands it over.
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
      try {
        const withTime = new URL(direct.url);
        withTime.searchParams.set('faststream-timestamp', String(Math.floor(time)));
        direct.url = withTime.toString();
      } catch (e) {
        // Not a URL after all: from the start.
      }
    }
    this.setSource(direct, this.fallbacks.sources, {play: wasPlaying})
        .catch((e) => console.warn('Could not play the source directly', e));
    return true;
  }

  /**
   * A source's URL without the time recoverPlayer gives it, so its recoveries count as one
   * source's.
   * @param {string} url
   * @return {string}
   */
  recoverySourceURL(url) {
    try {
      const parsed = new URL(url);
      parsed.searchParams.delete('faststream-timestamp');
      return parsed.toString();
    } catch (e) {
      return url;
    }
  }

  failedToLoad(reason) {
    this.downloadManager.removeAllDownloaders();
    this.interfaceController.failedToLoad(reason);
    // The page may play its own media again. A stream that fails while it plays (a fatal
    // network error) plays out what it has and waits, never pausing: the page's player
    // stayed held under the error, paused each time it was started.
    this.reportPlaying(false);
  }

  /**
   * Resets the player and all related state.
   * @return {Promise<void>}
   */
  async resetPlayer() {
    const saveManager = this.interfaceController?.saveManager;
    if (saveManager?.makingDownload) {
      // An abandoned save left running against a player we're about to
      // destroy (and a download manager we're about to reset) would spin
      // forever and leave the Save button permanently stuck. Cancel it and
      // let it settle before tearing anything down.
      if (saveManager.downloadCancel) {
        saveManager.downloadCancel();
      }
      if (saveManager.pendingSave) {
        await saveManager.pendingSave.catch(() => {});
      }
    }
    // A new video defers to the MPV Allowlist's per-site default again,
    // rather than keeping the previous video's manual anime/movie override.
    saveManager?.resetMpvContentType();

    const promises = [];
    this.lastTime = 0;
    // The next video starts at 0. Until its first time update, the previous one's time
    // stayed on the progress bar, and the downloads were planned around it.
    this.state.currentTime = 0;

    this.fragmentsStore = {};
    this.pastSeeks.length = 0;
    this.pastUnseeks.length = 0;
    this.progressHashesCache = null;
    this.progressData = null;
    this.disableProgressSave = false;
    this.lastProgressSave = 0;
    // Its wait for a picture listens on the player going: a source that never got one left
    // it, and the next source joined it, its own picture then seen only by the wait's
    // once-a-second check. The next source makes its own.
    this.initPromise = null;
    clearInterval(this.initHookInterval);
    this.startPending = null;
    // A lookup for the last video is not this one's (loadProgressData).
    this.progressLoad = null;
    this.autoNextRequested = false;
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
    // A preview build still running is the old video's: the next video joined it, the build
    // discarded itself over the changed source, and the next video had no seek preview.
    this.previewPlayerSetup = null;
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
      this.audioContext.close().catch(()=>{});
      this.audioContext = null;
    }

    if (this.audioSource) {
      this.audioSource.disconnect();
      this.audioSource = null;
    }

    this.audioAnalyzer.reset();
    this.frameExtractor.reset();

    promises.push(this.downloadManager.reset());
    this.interfaceController.reset();

    this.state.buffering = false;

    this.storageAvailable = 0;
    this.hasDownloadSpace = true;
    this.previousLevel = -1;
    this.previousAudioLevel = -1;
    this.getLevelManager().reset();

    await Promise.all(promises);
  }

  /**
   * Sets media info and updates subtitles manager.
   * @param {Object} info
   */
  setMediaInfo(info) {
    this.mediaInfo = info;
    this.interfaceController.subtitlesManager.mediaInfoSet();
  }

  /**
   * Binds event listeners to the main player.
   * @param {Object} player
   */
  bindPlayer(player) {
    this.context = player.createContext();
    this.context.on(DefaultPlayerEvents.MANIFEST_PARSED, () => {
      console.log('MANIFEST_PARSED');
      this.updateQualityLevels();
    });

    this.context.on(DefaultPlayerEvents.ABORT, (event) => {

    });

    this.context.on(DefaultPlayerEvents.CANPLAY, (event) => {
      this.player.playbackRate = this.state.playbackRate;

      // Done only once it has started, as at the other two attempts: marked first, a play()
      // the browser blocked kept the later attempt from being made (and was an unhandled
      // rejection). Not before the source's own time is applied (startPending).
      if (!this.state.autoPlayTriggered && this.options.autoPlay && this.state.playing === false &&
          !this.startPending) {
        this.play().then(() => {
          this.state.autoPlayTriggered = true;
        }).catch((e) => console.warn('Autoplay failed', e));
      }
    });

    this.context.on(DefaultPlayerEvents.CANPLAYTHROUGH, (event) => {

    });

    this.context.on(DefaultPlayerEvents.COMPLETE, (event) => {

    });

    this.context.on(DefaultPlayerEvents.DURATIONCHANGE, (event) => {
      this.updateDuration();
      this.interfaceController.updateFragmentsLoaded();
    });

    this.context.on(DefaultPlayerEvents.EMPTIED, (event) => {
    });


    this.context.on(DefaultPlayerEvents.ENDED, (event) => {
      this.pause();
      // The end with autoplay on and no next episode: autoplay stops and says why (his wish,
      // 2026-10-11) - the series' last episode (content.js isSeriesEnd), or a page FastStream
      // cannot read yet, which is also noted for the options page's problem list.
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

    // A source this player cannot load (MP4Player, a server that ignores Range): Firefox's own
    // player plays it, once per source.
    this.context.on(DefaultPlayerEvents.PLAY_DIRECTLY, (reason) => {
      if (!this.playDirectly(player, reason)) {
        const message = Localize.getMessage('player_error_load');
        this.failedToLoad(message + ' (' + reason + ')');
      }
    });

    this.context.on(DefaultPlayerEvents.ERROR, (reason) => {
      console.error('ERROR', reason);
      // A video codec that just failed to decode for good: the same source again, without it.
      if (player.takeCodecReload?.() && this.reloadWithoutFailedCodec(player)) {
        return;
      }
      if (this.tryNextSource()) {
        return;
      }
      // After it has shown something: the same source again, at the same time, with what it
      // downloaded (recoverPlayer).
      if (this.recoverPlayer(player, reason)) {
        return;
      }
      // With what went wrong: the reason is the event's only argument, and the second one
      // this read instead was never passed, so every failure said only "Failed to load video!".
      const detail = describePlayerError(reason);
      const message = Localize.getMessage('player_error_load');
      this.failedToLoad(detail ? message + ' (' + detail + ')' : message);
    });

    this.context.on(DefaultPlayerEvents.NEED_KEY, (event) => {
      this.failedToLoad(Localize.getMessage('player_error_drm'));
    });

    this.context.on(DefaultPlayerEvents.LOADEDDATA, (event) => {
      // It shows something: a failure from now on is the stream's, not a wrong pick.
      this.fallbacks.sources = [];
      // This player's: an old one's late event is not the new source's.
      if (player === this.player) {
        this.playedSource = this.source;
      }
      // Made only where Web Audio is (constructor), as every other use checks
      this.audioOutput?.updateChannelCount();
    });


    this.context.on(DefaultPlayerEvents.LOADEDMETADATA, (event) => {
      this.interfaceController.updateQualityLevels();
    });


    this.context.on(DefaultPlayerEvents.PAUSE, (event) => {
      this.cancelEndStall();
      this.interfaceController.pause();
      this.reportPlaying(false);
      this.updatePeers();
    });


    this.context.on(DefaultPlayerEvents.PLAY, (event) => {
      this.interfaceController.play();
      this.reportPlaying(true);
      this.updatePeers();
    });


    this.context.on(DefaultPlayerEvents.PLAYING, (event) => {
      this.cancelEndStall();
      this.interfaceController.setBuffering(false);
    });


    this.context.on(DefaultPlayerEvents.PROGRESS, (event) => {
    });


    this.context.on(DefaultPlayerEvents.RATECHANGE, (event) => {
    });


    this.context.on(DefaultPlayerEvents.SEEKED, (event) => {
      this.interfaceController.updateFragmentsLoaded();
    });


    this.context.on(DefaultPlayerEvents.SEEKING, (event) => {
      this.cancelEndStall();
    });


    this.context.on(DefaultPlayerEvents.STALLED, (event) => {
    });


    this.context.on(DefaultPlayerEvents.SUSPEND, (event) => {
    });


    this.context.on(DefaultPlayerEvents.TIMEUPDATE, (event) => {
      if (this.interfaceController.isUserSeeking()) return;

      this.updateTime(this.currentTime);
    });


    this.context.on(DefaultPlayerEvents.VOLUMECHANGE, (event) => {

    });


    this.context.on(DefaultPlayerEvents.WAITING, (event) => {
      // In the last second, the next video instead of a wait - when there is one: with none,
      // this returned before the indicator, and the last video froze there with nothing
      // shown (glm's second look, 2026-10-13).
      if (this.duration > 5 && this.duration - this.currentTime < 1 && this.autoplayNextVideo()) {
        return;
      }
      this.watchEndStall();
      this.interfaceController.setBuffering(true);
    });

    this.context.on(DefaultPlayerEvents.FRAGMENT_UPDATE, () => {
      this.interfaceController.updateFragmentsLoaded();
    });
  }

  /**
   * Binds event listeners to the preview player.
   * @param {Object} player
   */
  bindPreviewPlayer(player) {
    this.previewContext = player.createContext();

    this.previewContext.on(DefaultPlayerEvents.MANIFEST_PARSED, () => {
      player.setCurrentVideoLevelID(this.getCurrentVideoLevelID());
      player.setCurrentAudioLevelID(this.getCurrentAudioLevelID());
    });

    this.previewContext.on(DefaultPlayerEvents.FRAGMENT_UPDATE, (fragment) => {
      this.interfaceController.updateFragmentsLoaded();
    });

    this.previewContext.on(DefaultPlayerEvents.SEEKED, (event) => {
      this.updatePreview();
    });


    this.previewContext.on(DefaultPlayerEvents.SEEKING, (event) => {
      this.updatePreview();
    });


    this.previewContext.on(DefaultPlayerEvents.ERROR, (e) => {
      console.log('Preview player error', e);
      // Still null while the preview player is being built: it is only stored once its
      // source has loaded, and a source that fails to load is exactly what gets here.
      this.previewPlayer?.destroy();
      this.previewPlayer = null;
      this.interfaceController.resetPreviewVideo();

      if (!this.interfaceController.failed) {
        const now = Date.now();
        if (this.lastPreviewReload && now - this.lastPreviewReload < 1000) {
          return;
        }
        // PREVIEW_RELOAD_LIMIT times in RECOVERY_WINDOW_MS, as recoverPlayer (glm's review,
        // 2026-10-13); resetPlayer starts the count again.
        this.previewReloads = (this.previewReloads || []).filter((time) => now - time < RECOVERY_WINDOW_MS);
        if (this.previewReloads.length >= PREVIEW_RELOAD_LIMIT) {
          return;
        }
        this.previewReloads.push(now);
        this.lastPreviewReload = now;
        console.error('Reloading preview player');
        this.setupPreviewPlayer();
      }
    });
  }

  /**
   * Plays the video and synced audio.
   * @return {Promise<void>}
   */
  async play() {
    if (!this.player) {
      throw new Error('No source is loaded!');
    }

    // Played again: its end may go on to the next video again (autoplayNextVideo).
    this.autoNextRequested = false;

    // A pause() (or another play()) made while this waits wins: this one went on after
    // it, showing "playing" over a paused video, and with a delay set, starting the
    // separate audio over it.
    const turn = ++this.playPauseTurn;

    // Will throw if browser blocks autoplay
    await this.player.play();

    // Everything below will only run if browser allows playing the video
    // (e.g. not blocked by autoplay policy)
    if (this.syncedAudioPlayer && turn === this.playPauseTurn) {
      await this.syncedAudioPlayer.play();
    }
    if (turn !== this.playPauseTurn) {
      return;
    }

    this.interfaceController.play();
    this.startAudio();
  }

  /**
   * Starts the audio context if it is suspended, without waiting for it: with no sound
   * device it never starts (resume() never settles; CI's Linux runner has none), and play()
   * waited for it forever, so what follows a play, autoplay's own bookkeeping included,
   * never ran. The background analyzer starts once the audio runs.
   */
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

  /**
   * Pauses the video and synced audio.
   * @return {Promise<void>}
   */
  async pause() {
    // No player while a source is being swapped: a key pressed then threw.
    if (!this.player) {
      return;
    }
    const turn = ++this.playPauseTurn;
    await this.player.pause();

    if (this.syncedAudioPlayer) {
      await this.syncedAudioPlayer.pause();
    }

    if (turn === this.playPauseTurn) {
      this.interfaceController.pause();
    }
  }

  /**
   * Undoes the last seek operation.
   */
  undoSeek() {
    if (this.player && this.pastSeeks.length) {
      this.pastUnseeks.push(this.player.currentTime);
      // Through the setter, so a separate audio track follows at once; not saved, or
      // the undo would be a seek to undo.
      this.setSeekSave(false);
      this.currentTime = this.pastSeeks.pop();
      this.setSeekSave(true);
      this.interfaceController.updateMarkers();
    }
  }

  /**
   * Redoes the last undone seek operation.
   */
  redoSeek() {
    if (this.player && this.pastUnseeks.length) {
      this.pastSeeks.push(this.player.currentTime);
      this.setSeekSave(false);
      this.currentTime = this.pastUnseeks.pop();
      this.setSeekSave(true);
      this.interfaceController.updateMarkers();
    }
  }

  /**
   * Saves the current playback position for undo/redo.
   */
  savePosition() {
    if (!this.pastSeeks.length || this.pastSeeks[this.pastSeeks.length - 1] != this.state.currentTime) {
      this.pastSeeks.push(this.state.currentTime);
    }
    if (this.pastSeeks.length > 50) {
      this.pastSeeks.shift();
    }
    this.pastUnseeks.length = 0;
    this.interfaceController.updateMarkers();
  }

  /**
   * Checks if a region of the video is fully buffered.
   * @param {number} start
   * @param {number} end
   * @return {boolean}
   */
  isRegionBuffered(start, end) {
    const fragments = this.getFragments(this.getCurrentVideoLevelID());
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
   * Sets the current playback time.
   *
   * Every seek comes through here, and several of them are relative (the arrows, J/K,
   * Z/X, undo), so near either end of the video they ask for a time outside it. The media
   * element clamps that itself; the state the download scheduler reads, the separate audio
   * track and MP4Player's "is the target buffered" check do not, so the time is clamped to
   * [0, duration] before it reaches any of them. A live stream's duration is Infinity and
   * only the lower bound applies.
   *
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

  /**
   * Gets the duration of the video.
   * @return {number}
   */
  get duration() {
    return this.player?.duration || 0;
  }

  /**
   * The seconds a Buffer ahead or Buffer behind setting keeps: Infinity for no limit (an
   * empty field, saved as -1), 0 for none.
   * @param {number} value - The setting as saved.
   * @return {number}
   */
  static bufferSeconds(value) {
    return typeof value === 'number' && value < 0 ? Infinity : value;
  }

  /**
   * Whether the video is a live stream. dash.js gives one an infinite duration; hls.js, as
   * HLSPlayer sets it up, the end of its live window, so HLSPlayer says it itself.
   * @return {boolean}
   */
  isLive() {
    return !Number.isFinite(this.duration) || !!this.player?.isLive;
  }

  /**
   * Gets the current playback time.
   * @return {number}
   */
  get currentTime() {
    return this.player?.currentTime || 0;
  }

  /**
   * Gets whether the video is paused.
   * @return {boolean}
   */
  get paused() {
    // ?? and not ||: `false || true` is true, so the || form answered "paused"
    // for a video that was playing, and the getter could never report anything else.
    return this.player?.paused ?? true;
  }

  /**
   * Gets available video quality levels.
   * @return {Map}
   */
  getVideoLevels() {
    return this.player?.getVideoLevels() || new Map();
  }

  /**
   * Gets available audio quality levels.
   * @return {Map}
   */
  getAudioLevels() {
    return this.player?.getAudioLevels() || new Map();
  }

  /**
   * Gets the current video level ID.
   * @return {string|number|null}
   */
  getCurrentVideoLevelID() {
    return this.player?.getCurrentVideoLevelID() ?? null;
  }

  /**
   * Gets the current audio level ID.
   * @return {string|number|null}
   */
  getCurrentAudioLevelID() {
    return this.player?.getCurrentAudioLevelID() ?? null;
  }

  /**
   * Sets the current video level ID. One of the page's qualities (getMenuVideoLevels) plays
   * that file instead.
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
   * The qualities the page's player offers this video in as files of their own
   * (VideoSource.qualities), as levels for the quality menu, when the player has no choice of
   * its own (an MP4: one level). The player's own levels are unchanged: the analyzers, the
   * downloads and the embed API go by them.
   * @return {?Map<string, VideoLevel>}
   */
  getPageQualityLevels() {
    const qualities = this.source?.qualities;
    if (!qualities || qualities.length < 2 || this.getVideoLevels().size > 1) return null;
    const index = this.playingPageQuality();
    if (index < 0) return null;
    // A label names a size class, not the picture's height: a film's "1080p" is 1920x816. The
    // file playing shows its own size, the others their label alone.
    const levels = new Map();
    qualities.forEach((entry, i) => {
      const id = PAGE_QUALITY_LEVEL + i;
      const playing = i === index && this.videoWidth > 0 && this.videoHeight > 0;
      levels.set(id, new VideoLevel({
        id,
        height: playing ? this.videoHeight : entry.height,
        width: playing ? this.videoWidth : 0,
        label: entry.label || (entry.height ? entry.height + 'p' : ''),
      }));
    });
    return levels;
  }

  /**
   * The video levels the quality menu offers: the page's qualities, else the player's own.
   * @return {Map}
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
   * Which of the page's qualities plays: the entry with the source's URL, both read the same
   * way (recoverySourceURL). A time taken off a URL's query writes the query anew, and a URL
   * with a query of its own came back spelt differently.
   * @return {number} Its index in VideoSource.qualities, -1 when none.
   */
  playingPageQuality() {
    const qualities = this.source?.qualities || [];
    const playing = this.recoverySourceURL(this.source?.url || '');
    return qualities.findIndex((entry) => this.recoverySourceURL(entry.url) === playing);
  }

  /**
   * Plays another of the page's qualities from where this one is, as a player built again
   * does (recoverPlayer): nothing of its start first, and on playing only if it played.
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
      try {
        const withTime = new URL(next.url);
        withTime.searchParams.set('faststream-timestamp', String(time));
        next.url = withTime.toString();
      } catch (e) {
        // Not a URL after all: from the start.
      }
    }
    console.log('Playing the page\'s ' + (entry.label || entry.height + 'p') + ' instead');
    this.setSource(next, [], {play: wasPlaying}).catch((e) => console.warn('Could not switch the quality', e));
  }

  /**
   * Sets the current audio level ID.
   * @param {string|number} levelID
   */
  setCurrentAudioLevelID(levelID) {
    if (!this.player) return;
    this.player.setCurrentAudioLevelID(levelID);
    this.checkLevelChange();
  }

  /**
   * Checks for changes in video/audio levels and updates state.
   */
  checkLevelChange() {
    const videoLevelID = this.getCurrentVideoLevelID();
    const audioLevelID = this.getCurrentAudioLevelID();

    const previousVideoLevelID = this.levelManager.getCurrentVideoLevelID();
    const previousAudioLevelID = this.levelManager.getCurrentAudioLevelID();

    const videoChanged = videoLevelID !== null && (videoLevelID !== previousVideoLevelID);
    const audioChanged = audioLevelID !== null && (audioLevelID !== previousAudioLevelID);

    if (videoChanged) {
      if (this.options.freeUnusedChannels && this.fragmentsStore[previousVideoLevelID]) {
        this.freeLevel(this.fragmentsStore[previousVideoLevelID]);
      }
      this.levelManager.setCurrentVideoLevelID(videoLevelID);
    }

    if (audioChanged) {
      if (this.options.freeUnusedChannels && this.fragmentsStore[previousAudioLevelID]) {
        this.freeLevel(this.fragmentsStore[previousAudioLevelID]);
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
   * Frees the fragments of a level that is no longer played, but not those a save is still
   * writing (SAVER): freed, they were downloaded a second time. The other pins go with the
   * level: the analyzers start again on the new one, and nothing would ever free them later,
   * since only the playing level is freed as it plays.
   * @param {Array} fragments - The level's fragments.
   */
  freeLevel(fragments) {
    fragments.forEach((fragment) => {
      if (!fragment.references.includes(ReferenceTypes.SAVER)) {
        this.freeFragment(fragment);
      }
    });
  }

  /**
   * Gets the current fullscreen state.
   * @return {string} 'fullscreen', 'pip', 'windowed', or 'normal'.
   */
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

  /**
   * Escapes all menus, fullscreen, and control bar.
   */
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
   * A stream stuck in its last seconds goes on to the next video (his report, 2026-10-11:
   * "sometimes it seems to hang"). A last fragment that does not come (a hoster's 404, a
   * timeout) or a playlist longer than its media leaves the video waiting a few seconds
   * before its end, which it then never reaches, where autoplay waited for the last
   * second. Stuck there for EndStallMs, not paused and not seeking, is the end. Measured
   * first: a seek to the end, playing or paused, MP4 or HLS, reached `ended` as it is.
   */
  watchEndStall() {
    this.cancelEndStall();
    if (!this.options.autoplayNext || this.autoNextRequested || !this.hasNextVideo() || !(this.duration > 5)) return;
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

  /** Stops watching a stall at the end: it played on, was paused or sought. */
  cancelEndStall() {
    if (this.endStallTimer) {
      clearTimeout(this.endStallTimer);
      this.endStallTimer = null;
    }
  }

  /**
   * Goes on to the next video when this one ends, once: the last second's `waiting` and then
   * `ended` each asked for it, and a page whose next button counts clicks skipped a video.
   * Playing again (after a seek back, say) lets the end ask again.
   * @return {boolean} Whether the next video is on its way (asked now or before).
   */
  autoplayNextVideo() {
    if (!this.options.autoplayNext || !this.hasNextVideo()) return false;
    if (this.autoNextRequested) return true;
    this.autoNextRequested = true;
    this.nextVideo();
    return true;
  }

  /**
   * Tells the background whether this player plays. While it does, the page around it
   * keeps its own media paused (content.js holdPageMedia): a site's player outside the box
   * this one took over, or in another frame, played on under it.
   * @param {boolean} playing - Whether it plays now.
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

  /**
   * Navigates to the next video in the playlist.
   */
  nextVideo() {
    if (!this.hasNextVideo()) return;
    if (EnvUtils.isExtension()) {
      chrome.runtime.sendMessage({
        type: MessageTypes.REQUEST_PLAYLIST_NAVIGATION,
        direction: 'next',
        continuationOptions: {
          fullscreenState: this.getFullscreenState(),
          autoPlay: true,
          disableLoadProgress: true,
        },
      }, ()=>{

      });
    }
  }

  /**
   * Navigates to the previous video in the playlist.
   */
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


  /**
   * Checks if there is a previous video available.
   * @return {boolean}
   */
  hasPreviousVideo() {
    if (!this.player) return false;
    if (window.top === window.self) return false;
    if (!this.state.hasPrevVideo) return false;
    return true;
  }

  /**
   * Checks if there is a next video available.
   * @return {boolean}
   */
  hasNextVideo() {
    if (!this.player) return false;
    if (window.top === window.self) return false;
    if (!this.state.hasNextVideo) return false;
    return true;
  }

  /**
   * Gets the current video fragments.
   * @return {Array|undefined}
   */
  get fragments() {
    return this.fragmentsStore[this.getCurrentVideoLevelID()];
  }

  /**
   * Gets the current audio fragments.
   * @return {Array|undefined}
   */
  get audioFragments() {
    return this.fragmentsStore[this.getCurrentAudioLevelID()];
  }

  /**
   * Gets the current video fragment.
   * @return {Object|null}
   */
  get currentFragment() {
    return this.player?.currentFragment || null;
  }

  /**
   * Gets the current audio fragment.
   * @return {Object|null}
   */
  get currentAudioFragment() {
    return this.player?.currentAudioFragment || null;
  }

  /**
   * Gets fragments for a given level.
   * @param {string|number} level
   * @return {Array|undefined}
   */
  getFragments(level) {
    return this.fragmentsStore[level];
  }

  /**
   * Sets the player volume.
   * @param {number} volume
   */
  setVolume(volume) {
    this.state.volume = volume;
    if (SET_VOLUME_USING_NODE || (volume > 1 && EnvUtils.isWebAudioSupported())) {
      if (this.player && (!this.syncedAudioPlayer || !this.syncedAudioPlayer.setVolume(1))) {
        this.player.volume = 1;
      }
      this.audioOutput?.updateVolume(volume);
    } else {
      if (this.player && (!this.syncedAudioPlayer || !this.syncedAudioPlayer.setVolume(volume))) {
        this.player.volume = volume;
      }
      if (EnvUtils.isWebAudioSupported()) this.audioOutput.updateVolume(1);
    }
  }

  /**
   * Gets the current volume.
   * @return {number}
   */
  get volume() {
    return this.state.volume;
  }

  /**
   * Sets the volume and updates the UI.
   * @param {number} value
   */
  set volume(value) {
    this.interfaceController.setVolume(value);
  }

  /**
   * Gets the current playback rate.
   * @return {number}
   */
  get playbackRate() {
    return this.player?.playbackRate || this.state.playbackRate;
  }

  /**
   * Sets the playback rate and updates the UI.
   * Within [0.1, options.maxPlaybackRate], whoever asks: only the speed menu clamped, so
   * holding the video at 5x ran it at 10x (silent in Firefox above 8x) while the menu
   * showed 8x, and a saved rate from a build with a higher cap was applied as it was.
   * @param {number} value
   */
  set playbackRate(value) {
    this.setPlaybackRate(value);
  }

  /**
   * Sets the playback rate, as the setter does; a speed preset (the 16x key) may go past the
   * cap, without sound, up to Firefox's own limit, and so may putting such a rate back.
   * @param {number} value
   * @param {boolean} [silentAllowed] - Whether a rate beyond the sound (above
   *   options.maxPlaybackRate, up to SILENT_MAX_PLAYBACK_RATE) is wanted.
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

  /**
   * Gets the current video element.
   * @return {HTMLVideoElement|null}
   */
  get currentVideo() {
    return this.player?.getVideo() || null;
  }

  /**
   * Gets the width of the current video.
   * @return {number}
   */
  get videoWidth() {
    return this.player?.getVideo().videoWidth || 0;
  }

  /**
   * Gets the height of the current video.
   * @return {number}
   */
  get videoHeight() {
    return this.player?.getVideo().videoHeight || 0;
  }

  /**
   * Runs a debug demo for the player.
   */
  debugDemo() {
    this.interfaceController.hideControlBar = ()=>{};

    this.currentTime = 6;
    this.player.getVideo().style.objectFit = 'cover';
  }
}

