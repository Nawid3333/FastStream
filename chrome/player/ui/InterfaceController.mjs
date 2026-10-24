// @ts-check
import {MessageTypes} from '../enums/MessageTypes.mjs';
import {PlayerModes} from '../enums/PlayerModes.mjs';
import {Coloris} from '../modules/coloris.mjs';
import {Localize} from '../modules/Localize.mjs';
import {ClickActions} from '../options/defaults/ClickActions.mjs';
import {MiniplayerPositions} from '../options/defaults/MiniplayerPositions.mjs';
import {VisChangeActions} from '../options/defaults/VisChangeActions.mjs';
import {SKIP_BUTTON_SECONDS} from '../options/KeybindUtils.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {InterfaceUtils} from '../utils/InterfaceUtils.mjs';
import {StringUtils} from '../utils/StringUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {ClickSequence} from './ClickSequence.mjs';
import {PointerMoves} from './PointerMoves.mjs';
import {DOMElements} from './DOMElements.mjs';
import {downloadStatusText} from './DownloadStatusText.mjs';
import {FineTimeControls} from './FineTimeControls.mjs';
import {AudioQualityChanger} from './menus/AudioQualityChanger.mjs';
import {LanguageChanger} from './menus/LanguageChanger.mjs';
import {LoopMenu} from './menus/LoopMenu.mjs';
import {PlaybackRateChanger} from './menus/PlaybackRateChanger.mjs';
import {VideoQualityChanger} from './menus/VideoQualityChanger.mjs';
import {OptionsWindow} from './OptionsWindow.mjs';
import {ProgressBar} from './ProgressBar.mjs';
import {SaveManager} from './SaveManager.mjs';
import {StatusManager, StatusTypes} from './StatusManager.mjs';
import {isPolicyRefusal} from './audio/AudioOutputDevice.mjs';
import {SubtitlesManager} from './subtitles/SubtitlesManager.mjs';
import {ToolManager} from './ToolManager.mjs';
import {VolumeControls} from './VolumeControls.mjs';

let MiniplayerCooldown = Date.now() + 500;
/**
 * Whether an element has the focus the keyboard gave it, not a click (:focus-visible).
 * @param {?Element} element
 * @return {boolean}
 */
function isKeyboardFocus(element) {
  try {
    return !!element?.matches?.(':focus-visible');
  } catch (e) {
    return false;
  }
}

/**
 * Chromium's Document Picture-in-Picture API, which TypeScript's DOM types do not have.
 * The nested window is read only after the API itself was found to be there.
 * @typedef {Window & typeof globalThis & {documentPictureInPicture: {window: Window}}} PipWindow
 */
export class InterfaceController {
  /** @param {import('../FastStreamClient.mjs').FastStreamClient} client */
  constructor(client) {
    this.client = client;
    // The client's state, with the flag this keeps there for a Document Picture-in-Picture window.
    /** @type {import('../FastStreamClient.mjs').FastStreamClient['state'] & {documentPip?: boolean}} */
    this.state = client.state;
    this.hidden = false;
    this.lastTime = 0;
    this.lastSpeed = 0;
    this.mouseOverControls = false;
    this.controlsVisible = true;
    // Which mouse moves are the user's (PointerMoves): those bring the controls back.
    this.pointerMoves = new PointerMoves();

    this.failed = false;

    this.toolManager = new ToolManager(this.client, this);

    this.toolManager.setupUI();

    this.fineTimeControls = new FineTimeControls(this.client);

    this.subtitlesManager = new SubtitlesManager(this.client);

    this.playbackRateChanger = new PlaybackRateChanger(this.client);
    this.playbackRateChanger.on('rateChanged', (/** @type {number} */ rate) => {
      this.client.playbackRate = rate;
    });
    this.playbackRateChanger.setupUI();

    this.videoQualityChanger = new VideoQualityChanger();
    this.videoQualityChanger.setupUI();
    // The version picked, whether to remember the choice, and the versions of its size.
    this.videoQualityChanger.on('qualityChanged', (/** @type {import('../players/Levels.mjs').VideoLevel} */ level, /** @type {boolean} */ savePriority, /** @type {Array<import('../players/Levels.mjs').VideoLevel>} */ versions) => {
      if (savePriority) {
        // Its container, and its codec only if the click chose between codecs.
        this.client.getLevelManager().rememberVideoChoice(level, versions);
      }
      // Chosen by hand: the dropped-frames watch leaves it as chosen.
      this.client.droppedFrameWatch?.userChose(level.id);
      this.client.setCurrentVideoLevelID(level.id);
    });

    this.audioQualityChanger = new AudioQualityChanger();
    this.audioQualityChanger.setupUI();
    this.audioQualityChanger.on('qualityChanged', (/** @type {import('../players/Levels.mjs').AudioLevel} */ level) => {
      const mimeType = (level.mimeType || '').split('/');
      if (mimeType.length > 1) {
        this.client.getLevelManager().setPrioritizedAudioContainer(mimeType[1]);
      }

      if (level.audioCodec) {
        this.client.getLevelManager().setPrioritizedAudioCodec(level.audioCodec);
      }

      const usesDRC = level.id.includes('-drc');
      this.client.getLevelManager().setShouldPreferDRCAudio(usesDRC);

      this.client.setCurrentAudioLevelID(level.id);
    });

    this.languageChanger = new LanguageChanger();
    this.languageChanger.setupUI();
    // 'video' or 'audio', the language, and that type's tracks in it.
    this.languageChanger.on('languageChanged', (/** @type {string} */ type, /** @type {string} */ language, /** @type {Array<import('../players/Levels.mjs').VideoLevel|import('../players/Levels.mjs').AudioLevel>} */ tracks) => {
      this.client.changeLanguage(type, language);
    });

    this.loopControls = new LoopMenu(this.client);
    this.loopControls.setupUI();

    this.saveManager = new SaveManager(this.client);
    this.saveManager.setupUI();

    this.playbackRateChanger.on('open', this.closeAllMenus.bind(this));
    this.videoQualityChanger.on('open', this.closeAllMenus.bind(this));
    this.audioQualityChanger.on('open', this.closeAllMenus.bind(this));
    this.languageChanger.on('open', this.closeAllMenus.bind(this));
    this.subtitlesManager.on('open', this.closeAllMenus.bind(this));
    this.loopControls.on('open', this.closeAllMenus.bind(this));

    this.progressBar = new ProgressBar(this.client);
    this.progressBar.on('show-next-video', () => {
      this.showControlBarTemporarily(5000);
    });
    this.progressBar.setupUI();

    this.volumeControls = new VolumeControls(this.client);
    this.volumeControls.on('volume', (/** @type {number} */ volume)=>{
      this.client.setVolume(volume);
    });
    this.volumeControls.setupUI();

    this.statusManager = new StatusManager();
    this.optionsWindow = new OptionsWindow();

    this.setupDOM();
  }

  updateAutoNextIndicator() {
    const on = !!this.client.options.autoplayNext;
    /** @type {HTMLElement} */ (DOMElements.autoNextIndicator).style.display = on ? '' : 'none';
    /** @type {HTMLElement} */ (DOMElements.autoplaySwitch).setAttribute('aria-checked', String(on));
    /** @type {HTMLElement} */ (DOMElements.autoplaySwitch).classList.toggle('on', on);
  }

  updateToolVisibility() {
    this.toolManager.updateToolVisibility();
  }

  openTimeline() {
    this.progressBar.startPreciseMode(true);
  }

  closeTimeline() {
    this.fineTimeControls.removeAll();
    this.progressBar.endPreciseMode();
    this.subtitlesManager.subtitleSyncer.stop();
    this.playbackRateChanger.closeSilenceSkipperUI();
  }

  /**
   * @param {boolean|{target: Element|null}} [e] - true keeps the extra tools open; a menu's
   *     'open' event keeps them open when its button is among them.
   * @return {boolean} Whether a menu was open.
   */
  closeAllMenus(e) {
    let closedSomething = false;
    if (e !== true && (!e || (e.target && !/** @type {HTMLElement} */ (DOMElements.extraTools).contains(e.target)))) {
      if (/** @type {HTMLElement} */ (DOMElements.extraTools).classList.contains('visible')) {
        /** @type {HTMLElement} */ (DOMElements.extraTools).classList.remove('visible');
        closedSomething = true;
      }
    }
    closedSomething = this.playbackRateChanger.closeUI() || closedSomething;
    closedSomething = this.videoQualityChanger.closeUI() || closedSomething;
    closedSomething = this.audioQualityChanger.closeUI() || closedSomething;
    closedSomething = this.languageChanger.closeUI() || closedSomething;
    closedSomething = this.subtitlesManager.closeUI() || closedSomething;
    closedSomething = this.loopControls.closeUI() || closedSomething;
    return closedSomething;
  }

  /**
   * @param {string} key - The status level (StatusManager).
   * @param {string|null} [message] - null or none clears the level's message.
   * @param {string} [type] - info by default.
   * @param {number} [expiry] - Milliseconds it shows; none for as long as it is set.
   * @param {?(() => void)} [onClick] - What a click on it does.
   */
  setStatusMessage(key, message, type, expiry, onClick = null) {
    this.statusManager.setStatusMessage(key, message, type, expiry, onClick);
  }

  tick() {
    if (this.client.player) {
      this.updateFragmentsLoaded();
      this.checkBuffering();
    }

    this.statusManager.updateStatusMessage();
  }

  checkBuffering() {
    const currentVideo = this.client.currentVideo;
    if (this.state.playing) {
      const time = this.client.currentTime;
      if (time === this.lastTime) {
        this.setBuffering(true);
      } else {
        this.setBuffering(false);
      }
      this.lastTime = time;
    } else if (currentVideo) {
      if (currentVideo.readyState === 0) {
        this.setBuffering(true);
      } else if (currentVideo.readyState > 1) {
        this.setBuffering(false);
      }
    }
  }

  reset() {
    /** @type {HTMLElement} */ (DOMElements.videoContainer).replaceChildren();

    this.resetPreviewVideo();
    this.progressBar.reset();
    this.saveManager.reset();
    this.failed = false;
    this.setStatusMessage('error', null, 'error');
    // The last video's download line stayed up over a next video that never loaded.
    this.setStatusMessage('download', null, 'success');
    // And its "all buffered" was the next one's: one buffered from the start never said so.
    this.shownDownloadComplete = false;
    // The next video may never have fragments to count, and then nothing else hides it.
    /** @type {HTMLElement} */ (DOMElements.resetFailed).style.display = 'none';
    this.stopProgressLoop();
    this.state.playing = false;
    this.updatePlayPauseButton();
    /** @type {HTMLElement} */ (DOMElements.playPauseButtonBigCircle).style.display = '';
    // Shown the way every other show is, with its hide check (showControlBar): only the
    // class was added, nothing checked, and the bar could stay up after the next video.
    this.showControlBar();
    this.updateToolVisibility();
    this.fineTimeControls.reset();
    this.playbackRateChanger.reset();
    this.loopControls.reset();
    // A video that never loads sends no time update, and kept the previous one's time.
    this.timeUpdated();
  }

  /** @param {string} reason - The message shown. */
  failedToLoad(reason) {
    this.failed = true;
    this.setStatusMessage('error', reason, 'error');
    this.setBuffering(false);
  }

  /** @param {boolean} isBuffering */
  setBuffering(isBuffering) {
    if (this.failed) {
      isBuffering = false;
    }

    if (this.state.buffering === isBuffering) {
      return;
    }

    this.state.buffering = isBuffering;

    if (isBuffering) {
      /** @type {HTMLElement} */ (DOMElements.bufferingSpinner).style.display = '';
    } else {
      /** @type {HTMLElement} */ (DOMElements.bufferingSpinner).style.display = 'none';
    }
  }

  /** @param {HTMLVideoElement} video - A player's video element. */
  dressVideo(video) {
    video.setAttribute('playsinline', 'playsinline');
    video.disableRemotePlayback = true;
  }

  /** @param {HTMLVideoElement} video - The player's video element. */
  addVideo(video) {
    this.dressVideo(video);
    /** @type {HTMLElement} */ (DOMElements.videoContainer).appendChild(video);
  }

  /** @param {HTMLVideoElement} video - The seek preview player's video element. */
  addPreviewVideo(video) {
    this.dressVideo(video);
    /** @type {HTMLElement} */ (DOMElements.seekPreviewVideo).style.display = '';
    /** @type {HTMLElement} */ (DOMElements.seekPreviewVideo).appendChild(video);
  }

  resetPreviewVideo() {
    /** @type {HTMLElement} */ (DOMElements.seekPreviewVideo).replaceChildren();
    const spinner = document.createElement('div');
    spinner.classList.add('spinner');
    /** @type {HTMLElement} */ (DOMElements.seekPreviewVideo).appendChild(spinner);
    /** @type {HTMLElement} */ (DOMElements.seekPreviewVideo).classList.remove('loading');
    /** @type {HTMLElement} */ (DOMElements.seekPreviewVideo).style.display = 'none';
  }

  updateMarkers() {
    this.progressBar.updateMarkers();
  }

  updateFragmentsLoaded() {
    this.progressBar.updateFragmentsLoaded();
    this.updateDownloadStatus();
  }

  updateDownloadStatus() {
    if (this.client.downloadManager.paused) {
      this.setStatusMessage('download', Localize.getMessage('player_download_paused'), 'warning');
      return;
    }

    const {loaded, total, failed} = /** @type {{loaded: number, total: number, failed: number}} */ (this.progressBar.getFragmentCounts());
    if (total === 0) {
      this.setStatusMessage('download', null);
      return;
    }

    const percentDone = total === 0 ? 0 :
        Math.floor((loaded / total) * 1000) / 10;

    const newSpeed = this.client.downloadManager.getSpeed();
    if (newSpeed > 0 && this.lastSpeed > 0) {
      this.lastSpeed = (newSpeed * 0.05 + this.lastSpeed * 0.95) || 0;
    } else {
      this.lastSpeed = newSpeed;
    }

    if (total === 0 || loaded < total) {
      this.shownDownloadComplete = false;
      // "3C": the connections downloading now, as upstream showed (the owner's wish, 2026-10-22).
      this.setStatusMessage('download', downloadStatusText(this.client.downloadManager.runningCount(), this.lastSpeed, percentDone), 'success');
    } else if (!this.shownDownloadComplete) {
      this.shownDownloadComplete = true;
      this.setStatusMessage('download', Localize.getMessage('player_fragment_allbuffered'), 'success', 2000);
    }

    if (failed > 0) {
      /** @type {HTMLElement} */ (DOMElements.resetFailed).style.display = '';
      /** @type {HTMLElement} */ (DOMElements.resetFailed).textContent = Localize.getMessage(failed === 1 ? 'player_fragment_failed_singular' : 'player_fragment_failed_plural', [failed]);
    } else {
      /** @type {HTMLElement} */ (DOMElements.resetFailed).style.display = 'none';
    }
  }

  setupDOM() {
    /** @param {Event} e - A keydown, mousedown or touchstart. */
    const interactHandler = (e) => {
      this.client.userInteracted();
    };

    /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('keydown', interactHandler, true);
    /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('mousedown', interactHandler, true);
    /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('touchstart', interactHandler, true);

    /** @type {HTMLElement} */ (DOMElements.playPauseButton).addEventListener('click', this.playPauseToggle.bind(this));
    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.playPauseButton));

    /** @type {HTMLElement} */ (DOMElements.playPauseButtonBigCircle).addEventListener('click', (e) => {
      this.hideControlBarOnAction();
      this.playPauseToggle();
      e.stopPropagation();
    });
    // Tab skipped it: a role="button" with no tabindex.
    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.playPauseButtonBigCircle));

    /** @type {HTMLElement} */ (DOMElements.fullscreen).addEventListener('click', (e)=>{
      if (e.shiftKey) {
        this.pipToggle();
        return;
      } else if (e.altKey) {
        this.toggleWindowedFullscreen();
        return;
      }

      this.fullscreenToggle();
      e.stopPropagation();
    });

    /** @type {HTMLElement} */ (DOMElements.fullscreen).addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleWindowedFullscreen();
    });

    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.fullscreen));

    /** @type {HTMLElement} */ (DOMElements.windowedFullscreen).addEventListener('click', (e)=>{
      if (this.state.carriedFullscreen) {
        this.exitCarriedFullscreen();
        return;
      }
      this.toggleWindowedFullscreen();
    });
    // Escape where the keyboard is in the player (after a click in it); in the page around
    // it content.js passes it on (EXIT_CARRIED_FULLSCREEN).
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.state.carriedFullscreen) {
        this.exitCarriedFullscreen();
        e.preventDefault();
      }
    }, true);
    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.windowedFullscreen));

    document.addEventListener('fullscreenchange', this.updateFullScreenButton.bind(this));

    /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('mousemove', this.onPlayerMouseMove.bind(this));
    /** @type {HTMLElement} */ (DOMElements.controlsContainer).addEventListener('mouseenter', this.onControlsMouseEnter.bind(this));
    /** @type {HTMLElement} */ (DOMElements.controlsContainer).addEventListener('mouseleave', this.onControlsMouseLeave.bind(this));
    /** @type {HTMLElement} */ (DOMElements.controlsContainer).addEventListener('focusin', (e)=>{
      // Keyboard focus only (:focus-visible): a click on a button focuses it too, and the bar
      // then stayed up while it kept the focus - after a click on fullscreen, until the
      // video was played or paused by a click on it.
      this.focusingControls = isKeyboardFocus(/** @type {?Element} */ (e.target));
      this.showControlBar();
      // Kept while focus is there (queueControlsHide looks again until it may go): focus
      // can leave without a focusout (isFocusInControls), and then nothing else asked (#383).
      this.queueControlsHide();
    });
    /** @type {HTMLElement} */ (DOMElements.controlsContainer).addEventListener('focusout', ()=>{
      this.focusingControls = false;
      this.queueControlsHide();
    });

    /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('mouseleave', (e)=>{
      this.queueControlsHide(1);
    });

    /** @type {any} */
    let holdTimeout = null;
    /** @type {any} */
    let lastSpeed = null;
    let wasPlaying = false;
    /** @type {HTMLElement} */ (DOMElements.videoContainer).addEventListener('mousedown', (e)=>{
      if (e.button === 0) {
        clearTimeout(holdTimeout);
        holdTimeout = setTimeout(() => {
          if (lastSpeed !== null || !this.client.player) {
            return;
          }
          wasPlaying = this.state.playing;
          lastSpeed = this.client.playbackRate;
          // Twice as fast, up to the rate with sound; never slower than it was (the 16x key).
          this.client.setPlaybackRate(Math.max(lastSpeed, Math.min(lastSpeed * 2, this.client.options.maxPlaybackRate)), true);

          this.client.play();
        }, 800);
      }
    });

    const stopSpeedUp = () => {
      if (lastSpeed !== null) {
        // What it was, a silent 16x too.
        this.client.setPlaybackRate(lastSpeed, true);
        lastSpeed = null;

        if (!wasPlaying) {
          this.client.pause();
        }
      }
      clearTimeout(holdTimeout);
    };

    // DOMElements.videoContainer.addEventListener('mouseup', (e)=>{
    //   stopSpeedUp();
    // });

    /** @type {HTMLElement} */ (DOMElements.videoContainer).addEventListener('mouseleave', (e)=>{
      stopSpeedUp();
    });

    // One, two or three clicks on the video, each with its action (ClickSequence: a single
    // click's play or pause at once).
    const clicks = new ClickSequence(() => this.client.options, (clickAction) => {
      switch (clickAction) {
        case ClickActions.FULLSCREEN:
          this.fullscreenToggle();
          break;
        case ClickActions.WINDOWED_FULLSCREEN:
          this.toggleWindowedFullscreen();
          break;
        case ClickActions.PIP:
          this.pipToggle();
          break;
        case ClickActions.PLAY_PAUSE:
          this.playPauseToggle();
          break;
        case ClickActions.HIDE_CONTROLS:
          this.focusingControls = false;
          this.mouseOverControls = false;
          this.hideControlBar();
          break;
        case ClickActions.HIDE_PLAYER:
          this.toggleHide();
          break;
      }
    });
    /** @type {HTMLElement} */ (DOMElements.videoContainer).addEventListener('click', (e) => {
      clearTimeout(holdTimeout);
      if (lastSpeed !== null) {
        stopSpeedUp();
        return;
      }

      if (this.closeAllMenus(false)) {
        return;
      }

      if (InterfaceUtils.closeWindows()) {
        return;
      }

      if (this.isBigPlayButtonVisible()) {
        this.playPauseToggle();
        return;
      }

      clicks.click();
    });
    /** @type {HTMLElement} */ (DOMElements.hideButton).addEventListener('click', () => {
      /** @type {HTMLElement} */ (DOMElements.hideButton).blur();
      this.focusingControls = false;
      this.hideControlBar();
    });

    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.hideButton));

    /** @type {HTMLElement} */ (DOMElements.resetFailed).addEventListener('click', (e) => {
      this.client.resetFailed();
      e.stopPropagation();
    });
    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.resetFailed));

    /** @type {HTMLElement} */ (DOMElements.pip).addEventListener('click', (e) => {
      this.pipToggle();
    });

    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.pip));

    /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('dragenter', (e) => {
      e.stopPropagation();
      e.preventDefault();
    }, false);
    /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('dragover', (e) => {
      e.stopPropagation();
      e.preventDefault();
    }, false);

    /** @type {HTMLElement} */ (DOMElements.settingsButton).addEventListener('click', (e) => {
      if (e.shiftKey) {
        chrome.runtime.openOptionsPage();
      } else {
        this.optionsWindow.toggleUI();
      }
      e.stopPropagation();
    });
    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.settingsButton));

    const welcomeText = Localize.getMessage('player_welcometext', [this.client.version]);
    this.setStatusMessage('welcome', welcomeText, 'info', 3000);

    /** @type {HTMLElement} */ (DOMElements.controlsContainer).addEventListener('click', (e) => {
      e.stopPropagation();
    });

    document.addEventListener('visibilitychange', ()=>{
      if (!document.hidden) {
        this.visibilityChanged(true);
      } else {
        this.visibilityChanged(false);
      }
    });

    /** @type {HTMLElement} */ (DOMElements.skipForwardButton).addEventListener('click', (e) => {
      this.client.setSeekSave(false);
      this.client.currentTime += SKIP_BUTTON_SECONDS;
      this.client.setSeekSave(true);
      e.stopPropagation();
    });

    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.skipForwardButton));

    /** @type {HTMLElement} */ (DOMElements.skipBackwardButton).addEventListener('click', (e) => {
      this.client.setSeekSave(false);
      this.client.currentTime += -SKIP_BUTTON_SECONDS;
      this.client.setSeekSave(true);
      e.stopPropagation();
    });

    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.skipBackwardButton));

    /** @type {HTMLElement} */ (DOMElements.moreButton).addEventListener('click', (e) => {
      if (!/** @type {HTMLElement} */ (DOMElements.extraTools).classList.contains('visible')) {
        this.closeAllMenus(true);
        /** @type {HTMLElement} */ (DOMElements.extraTools).classList.add('visible');
      } else {
        /** @type {HTMLElement} */ (DOMElements.extraTools).classList.remove('visible');
      }
      e.stopPropagation();
    });
    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.moreButton));

    /** @type {HTMLElement} */ (DOMElements.duration).addEventListener('click', (e) => {
      this.copySourceLink();
    });
    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.duration));

    /** @type {HTMLElement} */ (DOMElements.nextVideo).addEventListener('click', (e) => {
      if (e.shiftKey || e.altKey) {
        this.toggleAutoplayNext();
        return;
      }

      this.client.nextVideo();
      e.stopPropagation();
    });

    /** @type {HTMLElement} */ (DOMElements.nextVideo).addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleAutoplayNext();
    });

    // The autoplay switch, a tool of its own (his wish, 2026-10-11): what the right click on
    // the next button did, for this tab, which nobody found. The options page's setting is
    // where a new tab starts.
    /** @type {HTMLElement} */ (DOMElements.autoplaySwitch).tabIndex = 0;
    /** @type {HTMLElement} */ (DOMElements.autoplaySwitch).addEventListener('click', (e) => {
      this.toggleAutoplayNext();
      e.stopPropagation();
    });
    /** @type {HTMLElement} */ (DOMElements.autoplaySwitch).addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        this.toggleAutoplayNext();
        e.preventDefault();
        e.stopPropagation();
      }
    });

    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.nextVideo));

    /** @type {HTMLElement} */ (DOMElements.previousVideo).addEventListener('click', (e) => {
      this.client.previousVideo();
      e.stopPropagation();
    });

    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.previousVideo));

    const o = new IntersectionObserver(([entry]) => {
      if (entry.intersectionRatio > 0.25 && !document.hidden) {
        this.visibilityChanged(true);
      } else {
        this.visibilityChanged(false);
      }
    }, {
      threshold: [0, 0.25, 0.5],
    });

    o.observe(document.body);
    try {
      // eslint-disable-next-line new-cap
      Coloris({
        parent: '.mainplayer',
        theme: 'pill',
        themeMode: 'dark',
        formatToggle: true,
        swatches: [
          'rgb(255,255,255)',
          'rgba(10,10,10,0.3)',
          '#067bc2',
          '#ecc30b',
          '#f37748',
          '#d56062',
        ],
        alpha: true,
        focusInput: false,
      });
    } catch (e) {
      console.warn('Coloris failed to initialize', e);
    }

    /** @param {MouseEvent} e */
    const mouseUpHandler = (e) => {
      /** @type {HTMLElement} */ (DOMElements.playerContainer).removeEventListener('mousemove', mouseMoveHandler);
      // With capture, as it was added: without, the remove did nothing, and each drag left one more.
      /** @type {HTMLElement} */ (DOMElements.playerContainer).removeEventListener('mouseup', mouseUpHandler, true);
      /** @type {HTMLElement} */ (DOMElements.playerContainer).removeEventListener('mouseleave', mouseUpHandler);
    };

    /** @param {MouseEvent} e */
    const mouseMoveHandler = (e) => {
      const currentY = Math.min(Math.max(e.clientY - WebUtils.getOffsetTop(/** @type {HTMLElement} */ (DOMElements.progressContainer)), -100), 100);
      const isExpanded = /** @type {HTMLElement} */ (DOMElements.playerContainer).classList.contains('expanded');
      const offset = isExpanded ? 0 : 80;
      if (currentY > 50) {
        this.closeTimeline();
      } else if (currentY <= -5 - offset) {
        this.openTimeline();
      }
    };

    /** @type {HTMLElement} */ (DOMElements.controlsLeft).addEventListener('mousedown', (e) => {
      if (e.button !== 0) {
        return;
      }

      // Ignore if user is over an element contained by .tools_container_left
      if (/** @type {HTMLElement} */ (DOMElements.leftToolsContainer).contains(/** @type {?Node} */ (e.target))) {
        return;
      }


      /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('mousemove', mouseMoveHandler);
      /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('mouseup', mouseUpHandler, true);
      /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('mouseleave', mouseUpHandler);
    });
  }

  toggleAutoplayNext() {
    this.client.options.autoplayNext = !this.client.options.autoplayNext;
    sessionStorage.setItem('autoplayNext', String(this.client.options.autoplayNext));
    this.updateAutoNextIndicator();
  }

  /** @param {boolean} isVisible - Whether the page is visible now. */
  async handleVisibilityChange(isVisible) {
    if (this.client.needsUserInteraction()) { // Don't do anything if the user needs to interact with the player
      return;
    }

    const action = this.client.options.visChangeAction;

    if (isVisible === this.lastPageVisibility) {
      return;
    }

    if (!isVisible && (this.state.fullscreen || this.isInPip())) {
      return;
    }

    switch (action) {
      case VisChangeActions.NOTHING:
        break;
      case VisChangeActions.PLAY_PAUSE:
        if (!isVisible) {
          this.shouldPlay = this.client.state.playing;
          await this.client.player?.pause();
        } else {
          if (this.shouldPlay) {
            await this.client.player?.play();
          }
        }
        break;
      // VisChangeActions has no PIP at present (commented out there), so this reads undefined.
      case /** @type {Record<string, string|undefined>} */ (VisChangeActions).PIP:
        if (!isVisible) {
          await this.enterPip();
        } else {
          await this.exitPip();
        }
        break;
      case VisChangeActions.MINI_PLAYER:
        if (!this.state.miniplayer && !isVisible && !this.state.windowedFullscreen && Date.now() > MiniplayerCooldown) {
          this.requestMiniplayer(!isVisible);
        }
        break;
    }

    /** @type {boolean|undefined} The visibility last acted on; none before the first change. */
    this.lastPageVisibility = isVisible;
  }

  /**
   * The tab's or the player's visibility changed: its action, a failure of it said on the
   * console. A play the browser blocks, or picture-in-picture with no click behind it
   * (Firefox has no such API for a page), was an unhandled rejection at every tab change.
   * @param {boolean} isVisible
   */
  visibilityChanged(isVisible) {
    this.handleVisibilityChange(isVisible).catch((e) => console.warn('The visibility action failed', e));
  }

  /** @param {boolean} [force] - In or out; toggles without. */
  requestMiniplayer(force) {
    if (EnvUtils.isExtension()) {
      // Check if source is vimeo, then dont do miniplayer
      if (this.client.source && this.client.source.mode === PlayerModes.ACCELERATED_VM) {
        return;
      }


      /** @type {{top?: string, left?: string, right?: string, bottom?: string}} The corner it goes to. */
      const styles = {};
      switch (this.client.options.miniPos) {
        case MiniplayerPositions.TOP_LEFT:
          styles.top = '0px';
          styles.left = '0px';
          break;
        case MiniplayerPositions.TOP_RIGHT:
          styles.top = '0px';
          styles.right = '0px';
          break;
        case MiniplayerPositions.BOTTOM_LEFT:
          styles.bottom = '0px';
          styles.left = '0px';
          break;
        case MiniplayerPositions.BOTTOM_RIGHT:
          styles.bottom = '0px';
          styles.right = '0px';
          break;
      }


      this.state.miniplayer = !this.state.miniplayer;
      if (force !== undefined) {
        this.state.miniplayer = force;
      }

      chrome.runtime.sendMessage({
        type: MessageTypes.REQUEST_MINIPLAYER,
        size: this.client.options.miniSize,
        force: this.state.miniplayer,
        styles,
        autoExit: true,
      }, (response) => {
        MiniplayerCooldown = Date.now() + 200;
        this.state.miniplayer = response === 'enter';
        /** @type {HTMLElement} */ (DOMElements.playerContainer).classList.toggle('miniplayer', this.state.miniplayer);
      });
    }
  }

  /** @param {boolean} isMini */
  setMiniplayerStatus(isMini) {
    if (isMini) {
      this.requestMiniplayer(true);
    } else {
      this.requestMiniplayer(false);
    }
  }

  toggleHide() {
    if (this.hidden) {
      /** @type {HTMLElement} */ (DOMElements.playerContainer).classList.remove('player-hidden');
      this.hidden = false;
      if (this.shouldPlay) {
        this.client.player?.play();
      }
    } else {
      /** @type {HTMLElement} */ (DOMElements.playerContainer).classList.add('player-hidden');

      this.hidden = true;
      this.shouldPlay = this.client.state.playing;
      this.client.player?.pause();
    }
  }

  /** @param {boolean} [force] - In or out; toggles without. */
  pipToggle(force) {
    if (force !== undefined && !!force === this.isInPip()) {
      return;
    }
    if (this.isInPip()) {
      return this.exitPip();
    } else {
      return this.enterPip();
    }
  }

  isInPip() {
    return !!document.pictureInPictureElement || !!/** @type {PipWindow} */ (window).documentPictureInPicture?.window || this.state.documentPip;
  }

  shouldDoDocumentPip() {
    // Check if in pip
    if (this.state.documentPip) {
      return true;
    }

    if (!/** @type {PipWindow} */ (window).documentPictureInPicture) {
      return false;
    }

    // Check if top level frame
    if (window !== window.top) {
      return false;
    }

    return true;
  }

  exitPip() {
    if (/** @type {PipWindow} */ (window).documentPictureInPicture?.window) {
      /** @type {PipWindow} */ (window).documentPictureInPicture.window.close();
    } else if (this.state.documentPip) {
      window.close();
    }

    if (document.pictureInPictureElement) {
      return document.exitPictureInPicture();
    }
    return Promise.resolve();
  }

  enterPip() {
    if (this.shouldDoDocumentPip()) {
      return this.enterDocumentPip();
    }

    if (!document.pictureInPictureElement && this.client.player) {
      return this.client.player.getVideo().requestPictureInPicture();
    }
    return Promise.resolve();
  }

  async enterDocumentPip() {
    /** @type {Window} */
    // @ts-ignore - Chromium's global documentPictureInPicture is not in TypeScript's DOM types.
    const pipWindow = await documentPictureInPicture.requestWindow({
      width: /** @type {HTMLElement} */ (DOMElements.playerContainer).clientWidth,
      height: /** @type {HTMLElement} */ (DOMElements.playerContainer).clientHeight,
    });

    // Copy all except script tags from the current document to the new window
    const children = [...document.body.children].filter((child) => child.tagName.toLowerCase() !== 'script');
    pipWindow.document.body.append(...children);
    this.state.documentPip = true;

    // Copy style sheets over from the initial document
    // so that the player looks the same.
    // A style sheet of this document, copied over as CSS text when its rules can be read,
    // else as a link to it; the fallback link takes the media query text and the URL as
    // plain strings (the link's media setter stringifies the MediaList).
    /** @type {Array<CSSStyleSheet & {media: string, href: string}>} */ ([...document.styleSheets]).forEach((styleSheet) => {
      try {
        const cssRules = [...styleSheet.cssRules]
            .map((rule) => rule.cssText)
            .join('');
        const style = document.createElement('style');

        style.textContent = cssRules;
        pipWindow.document.head.appendChild(style);
      } catch (e) {
        const link = document.createElement('link');

        link.rel = 'stylesheet';
        link.type = styleSheet.type;
        link.media = styleSheet.media;
        link.href = styleSheet.href;
        pipWindow.document.head.appendChild(link);
      }
    });

    pipWindow.addEventListener('pagehide', (event) => {
      this.state.documentPip = false;
      document.body.append(...pipWindow.document.body.children);
    });
  }

  destroy() {
    // Its hide check looks again for as long as the bar is up (queueControlsHide).
    this.destroyed = true;
    clearTimeout(/** @type {ReturnType<typeof setTimeout>|undefined} */ (this.hideControlBarTimeout));
    this.saveManager.destroy();
  }

  progressLoop() {
    // Every frame, so a short video's bar moves smoothly: while it plays, or while the fine
    // time controls are open. A paused video's time moves only by a seek, and its
    // timeupdate shows that; the loop ran on at 60 a second while it sat paused. play()
    // starts it again.
    if (!this.shouldRunProgressLoop || (!this.state.playing && !this.fineTimeControls.started)) {
      this.isRunningProgressLoop = false;
      return;
    }
    window.requestAnimationFrame(this.progressLoop.bind(this));
    this.client.updateTime(this.client.currentTime);
  }

  durationChanged() {
    const duration = this.client.duration;
    if (duration < (5 * 60 * this.client.playbackRate) || this.fineTimeControls.started) {
      this.runProgressLoop();
    } else {
      this.stopProgressLoop();
    }
    this.timeUpdated();
  }

  runProgressLoop() {
    // Set unconditionally, before the isRunning guard: stopProgressLoop()
    // only clears shouldRunProgressLoop, and isRunningProgressLoop isn't
    // cleared until the *next* frame observes that. Between those two points
    // - a window that lasts as long as the tab is backgrounded, since rAF is
    // paused there - a runProgressLoop() call would otherwise hit the guard,
    // leave shouldRunProgressLoop false, and let the pending frame stop the
    // loop for good even though it had just been asked to run.
    this.shouldRunProgressLoop = true;
    if (!this.isRunningProgressLoop) {
      this.isRunningProgressLoop = true;
      this.progressLoop();
    }
  }

  stopProgressLoop() {
    this.shouldRunProgressLoop = false;
  }

  onControlsMouseEnter() {
    this.showControlBar();
    this.mouseOverControls = true;
    // Kept while the pointer is over the bar (queueControlsHide looks again until it may
    // go), so the bar does not hang on a mouseleave alone (#383).
    this.queueControlsHide();
  }
  onControlsMouseLeave() {
    this.mouseOverControls = false;
    if (document.activeElement && /** @type {HTMLElement} */ (DOMElements.controlsContainer).contains(document.activeElement)) /** @type {HTMLElement} */ (document.activeElement).blur();
    this.queueControlsHide();
  }
  /** @param {MouseEvent} event - A mousemove over the player. */
  onPlayerMouseMove(event) {
    if (!this.pointerMoves.moved(event)) {
      return;
    }
    this.showControlBar();
    this.queueControlsHide();
  }

  /**
   * Whether keyboard focus is in the control bar. focusingControls follows focusin and
   * focusout, but focus can leave without a focusout: when the focused control is hidden,
   * Firefox moves focus to <body> and does not always fire one (seen on Firefox 156 and
   * 157 on Windows). A stale flag kept the bar up for good, so it is checked against
   * where focus actually is.
   * @return {boolean}
   */
  isFocusInControls() {
    const focused = document.activeElement;
    if (this.focusingControls && (!/** @type {HTMLElement} */ (DOMElements.controlsContainer).contains(focused) || !isKeyboardFocus(focused))) {
      this.focusingControls = false;
    }
    return /** @type {boolean} */ (this.focusingControls);
  }

  /**
   * Whether the pointer is over the control bar. mouseOverControls follows mouseenter and
   * mouseleave; should a mouseleave ever not come, the flag would keep the bar up for good,
   * so it is checked against what Firefox finds under the pointer, as isFocusInControls
   * does for focus. (Leaving the player's frame straight from the bar does send one:
   * measured on Firefox 157 for #383.)
   * @return {boolean}
   */
  isPointerOverControls() {
    if (this.mouseOverControls && !/** @type {HTMLElement} */ (DOMElements.controlsContainer).matches(':hover')) {
      this.mouseOverControls = false;
    }
    return this.mouseOverControls;
  }

  /** @param {number} [time] - Milliseconds until it hides; 2000 without. */
  queueControlsHide(time) {
    clearTimeout(/** @type {ReturnType<typeof setTimeout>|undefined} */ (this.hideControlBarTimeout));
    this.hideControlBarTimeout = null;
    if (this.destroyed) return;
    this.hideControlBarTimeout = setTimeout(() => {
      this.hideControlBarTimeout = null;
      if (!this.isFocusInControls() && !this.isPointerOverControls() && !this.isBigPlayButtonVisible() && this.state.playing && this.toolManager.canHideControls() && !InterfaceUtils.isAnyWindowOpen()) {
        this.hideControlBar();
      } else if (this.controlsVisible && !this.destroyed) {
        // Asked once, the bar stayed for as long as nothing asked again: a hide refused
        // while the video was paused or a menu open, then played or closed by a way that
        // queues no hide (#383). It looks again until it may go.
        this.queueControlsHide();
      }
    }, time || 2000);
  }

  hideControlBarOnAction() {
    if (!this.isPointerOverControls() && !this.isFocusInControls()) {
      if (!this.isBigPlayButtonVisible()) {
        this.hideControlBar();
      }
    }
  }

  hideBigPlayButton() {
    /** @type {HTMLElement} */ (DOMElements.playPauseButtonBigCircle).style.display = 'none';
  }

  isBigPlayButtonVisible() {
    return /** @type {HTMLElement} */ (DOMElements.playPauseButtonBigCircle).style.display !== 'none';
  }

  hideControlBar() {
    clearTimeout(/** @type {ReturnType<typeof setTimeout>|undefined} */ (this.hideControlBarTimeout));
    this.hideControlBarTimeout = null;
    this.controlsVisible = false;
    /** @type {HTMLElement} */ (DOMElements.playerContainer).classList.remove('controls_visible');
    /** @type {HTMLElement} */ (DOMElements.controlsContainer).classList.remove('fade_in');
    /** @type {HTMLElement} */ (DOMElements.controlsContainer).classList.add('fade_out');
    /** @type {HTMLElement} */ (DOMElements.progressContainer).classList.remove('freeze');
  }

  toggleControlBar() {
    if (this.controlsVisible) {
      this.hideControlBar();
    } else {
      this.showControlBar();
    }
  }

  showControlBar() {
    this.controlsVisible = true;
    /** @type {HTMLElement} */ (DOMElements.playerContainer).classList.add('controls_visible');
    /** @type {HTMLElement} */ (DOMElements.controlsContainer).classList.remove('fade_out');
    /** @type {HTMLElement} */ (DOMElements.controlsContainer).classList.add('fade_in');
    // Every bar shown has a hide check (#383): a pause, the show-controls key, a new video,
    // a closed menu or a tab come back to showed it without one, and it stayed up until
    // something else asked. One already waiting keeps its own time.
    if (!this.hideControlBarTimeout) this.queueControlsHide();
  }

  showControlBarTemporarily(timeout = 1000) {
    this.showControlBar();
    this.queueControlsHide(timeout);
  }

  /**
   * Copies a link to the source at the current time (a click on the time readout), with
   * its headers but not its login ones (VideoSource.toCopyURL).
   */
  async copySourceLink() {
    let copyURL = '';
    if (this.client.source) {
      try {
        const url = this.client.source.toCopyURL();
        url.searchParams.set('faststream-timestamp', Math.floor(this.client.currentTime).toString());
        copyURL = url.toString();
      } catch (e) {
      }
    }

    // Nothing to copy (no source, or none that can be copied): the clipboard was emptied, and
    // "Link copied" said otherwise.
    if (!copyURL) return;
    await WebUtils.copyText(copyURL, /** @type {HTMLElement} */ (DOMElements.playerContainer));

    this.setStatusMessage(StatusTypes.COPY, Localize.getMessage('source_copied'), 'info', 2000);
  }

  updatePlaybackRate() {
    this.playbackRateChanger.setPlaybackRate(this.state.playbackRate, true);
    this.durationChanged();
  }

  updateLanguageTracks() {
    this.languageChanger.updateLanguageTracks(this.client);
  }

  updateQualityLevels() {
    this.videoQualityChanger.updateQualityLevels(this.client);
    this.audioQualityChanger.updateQualityLevels(this.client);
  }

  /**
   * The audio list's output part, for the device the client's sound goes to now. A choice
   * refused by the page (its permissions policy) or a device that cannot play is said in the
   * status line; the sound stays where it was.
   */
  updateAudioOutputs() {
    const device = this.client.audioOutputDevice;
    if (!device) return;
    if (this.audioQualityChanger.outputDevice === device) {
      this.audioQualityChanger.renderOutputs();
      return;
    }
    this.audioQualityChanger.setOutputDevice(device, (/** @type {*} */ e) => this.audioOutputRefused(e));
  }

  /**
   * A choice of output the page refused (its permissions policy) or a device that could not
   * play: said, and the sound stays where it was.
   * @param {*} e
   */
  audioOutputRefused(e) {
    console.warn('The audio output was not changed', e);
    this.setStatusMessage(StatusTypes.AUDIO_OUTPUT, isPolicyRefusal(e) ? Localize.getMessage('player_audio_output_refused') :
      Localize.getMessage('player_audio_output_failed', [Localize.getMessage('player_audio_output_device')]), 'warning', 10000);
  }

  /** @param {number} volume - 0 to 3, 1 as the video is. */
  setVolume(volume) {
    this.volumeControls.setVolume(volume);
  }

  timeUpdated() {
    const duration = this.client.duration;
    if (!this.progressBar.isSeeking) {
      // Until the duration is known, 0 / 0 made a width the style refused, which left the
      // previous video's progress on the bar.
      /** @type {HTMLElement} */ (DOMElements.currentProgress).style.width = (duration > 0 ? Utils.clamp(this.state.currentTime / duration, 0, 1) * 100 : 0) + '%';
    }
    // Written only when it changes: a short video's time is updated every frame (up to 144
    // times a second), its text once a second.
    const timeText = StringUtils.formatTime(this.state.currentTime) + ' / ' + StringUtils.formatTime(duration);
    if (/** @type {HTMLElement} */ (DOMElements.duration).textContent !== timeText) {
      /** @type {HTMLElement} */ (DOMElements.duration).textContent = timeText;
    }

    this.subtitlesManager.renderSubtitles();
    this.fineTimeControls.onVideoTimeUpdate();
    this.progressBar.updateNextVideoBanner();
  }

  /** @param {boolean} [force] - In or out; toggles without. */
  toggleWindowedFullscreen(force) {
    chrome.runtime.sendMessage({
      type: MessageTypes.REQUEST_WINDOWED_FULLSCREEN,
      force,
    }, (response) => {
      this.state.windowedFullscreen = response === 'enter';
    });
  }

  /**
   * The next episode after a fullscreen one: Firefox lets no page go fullscreen without a
   * click, so the background makes the browser window fullscreen and this player fills
   * the page. To the user it is fullscreen: the button, Escape and a double click end it.
   */
  carryFullscreen() {
    if (!EnvUtils.isExtension() || this.state.carriedFullscreen) return;
    chrome.runtime.sendMessage({type: MessageTypes.REQUEST_WINDOW_FULLSCREEN, force: true}, (response) => {
      void chrome.runtime.lastError;
      if (response !== 'enter') return;
      this.state.carriedFullscreen = true;
      this.toggleWindowedFullscreen(true);
      /** @type {HTMLElement} */ (DOMElements.fullscreen).classList.add('out');
    });
  }

  /** Ends a carried fullscreen: the page and the window as they were. */
  exitCarriedFullscreen() {
    if (!this.state.carriedFullscreen) return;
    this.state.carriedFullscreen = false;
    this.toggleWindowedFullscreen(false);
    /** @type {HTMLElement} */ (DOMElements.fullscreen).classList.remove('out');
    chrome.runtime.sendMessage({type: MessageTypes.REQUEST_WINDOW_FULLSCREEN, force: false}, () => {
      void chrome.runtime.lastError;
    });
  }

  /**
   * @param {boolean} [force] - In or out; toggles without.
   * @return {Promise<void>}
   */
  async fullscreenToggle(force) {
    // A carried fullscreen is left like a real one (a click here could not enter one).
    if (this.state.carriedFullscreen) {
      if (force !== true) this.exitCarriedFullscreen();
      return;
    }
    if (document.fullscreenEnabled) {
      const newValue = force === undefined ? !document.fullscreenElement : force;
      if (newValue) {
        await document.documentElement.requestFullscreen();
      } else if (document.exitFullscreen && document.fullscreenElement) {
        document.exitFullscreen();
      }

      this.updateFullScreenButton();
    } else {
      if (EnvUtils.isExtension()) {
        return new Promise(/** @type {(resolve: (value: void | PromiseLike<void>) => void, reject: (reason?: any) => void) => void} */ ((resolve, reject) => {
          chrome.runtime.sendMessage({
            type: MessageTypes.REQUEST_FULLSCREEN,
            force,
          }, (response) => {
            if (response === 'error') {
              reject(new Error('Fullscreen not supported'));
              return;
            }
            this.setFullscreenStatus(response === 'enter');
            resolve();
          });
        }));
      }
    }
  }

  updateFullScreenButton() {
    this.setFullscreenStatus(document.fullscreenElement);
  }

  /** @param {Element|boolean|null} status - Fullscreen when truthy: the fullscreen element, or the background's answer. */
  setFullscreenStatus(status) {
    const fullScreenButton = /** @type {HTMLElement} */ (DOMElements.fullscreen);
    if (status) {
      fullScreenButton.classList.add('out');
      this.state.fullscreen = true;
    } else {
      fullScreenButton.classList.remove('out');
      if (this.state.fullscreen) {
        this.state.fullscreen = false;
        this.fullscreenToggle(false);
      }
    }
  }

  playPauseToggle() {
    if (!this.client.player) return;

    if (!this.state.playing) {
      this.client.play();
    } else {
      this.client.pause();
    }
  }

  play() {
    const previousValue = this.state.playing;
    this.state.playing = true;
    // progressLoop stops while paused.
    if (this.shouldRunProgressLoop) {
      this.runProgressLoop();
    }
    this.hideBigPlayButton();
    this.updatePlayPauseButton();
    if (!previousValue) {
      this.queueControlsHide();
    }
  }

  pause() {
    this.state.playing = false;
    this.updatePlayPauseButton();
    this.showControlBar();
  }

  updatePlayPauseButton() {
    const playButton = /** @type {HTMLElement} */ (DOMElements.playPauseButton);
    const playButtonBig = /** @type {HTMLElement} */ (DOMElements.playPauseButtonBig);
    if (this.state.playing) {
      playButton.classList.add('playing');
      playButtonBig.classList.replace('fluid_initial_play_button', 'fluid_initial_pause_button');
      WebUtils.setLabels(playButton, Localize.getMessage('player_pause_label'));
    } else {
      playButton.classList.remove('playing');
      playButtonBig.classList.replace('fluid_initial_pause_button', 'fluid_initial_play_button');
      WebUtils.setLabels(playButton, Localize.getMessage('player_play_label'));
    }
  }

  isUserSeeking() {
    return this.progressBar.isSeeking || this.fineTimeControls.isSeeking;
  }
}
