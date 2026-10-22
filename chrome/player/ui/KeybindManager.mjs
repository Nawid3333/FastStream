// @ts-check
import {DefaultKeybinds} from '../options/defaults/DefaultKeybinds.mjs';
import {
  FIXED_SEEKS, SEEK_PERCENTS, SILENT_MAX_PLAYBACK_RATE, SPEED_PRESETS, actionsForKey, applySpeedPreset, describePlaybackRate,
  isTextEntryTarget, seekPercentAction, seekPercentTarget, speedPresetAction,
} from '../options/KeybindUtils.mjs';
import {EventEmitter} from '../modules/eventemitter.mjs';
import {Localize} from '../modules/Localize.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {DOMElements} from './DOMElements.mjs';
import {OnScreenDisplay} from './OnScreenDisplay.mjs';
import {Utils} from '../utils/Utils.mjs';
import {AspectRatios} from '../options/defaults/AspectRatios.mjs';

export class KeybindManager extends EventEmitter {
  /**
   * @param {import('../FastStreamClient.mjs').FastStreamClient} client
   */
  constructor(client) {
    super();
    this.client = client;
    /** @type {Map<string, string>} Action to key string, e.g. 'PlayPause' to 'Space'. */
    this.keybindMap = new Map();
    this.setup();
  }
  setup() {
    for (const keybind in DefaultKeybinds) {
      if (Object.hasOwn(DefaultKeybinds, keybind)) {
        this.keybindMap.set(keybind, DefaultKeybinds[/** @type {keyof typeof DefaultKeybinds} */ (keybind)]);
      }
    }

    /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('keydown', (e) => {
      this.onKeyDown(e);
    });

    document.addEventListener('keydown', (e) => {
      this.onKeyDown(e);
    });

    this.on('HidePlayer', /** @param {KeyboardEvent} e */ (e) => {
      this.client.interfaceController.toggleHide();
    });

    this.on('ToggleControls', /** @param {KeyboardEvent} e */ (e) => {
      this.client.interfaceController.toggleControlBar();
    });

    this.on('GoToStart', /** @param {KeyboardEvent} e */ (e) => {
      this.client.currentTime = 0;
    });

    // YouTube-style percentage seeks: 1..9 jump to 10%..90% of the video
    // (0 already maps to GoToStart, i.e. 0%). Same semantics as mpv's
    // "seek <N> absolute-percent" default bindings. Assigned with seek
    // saving left on, like GoToStart, so Z undoes the jump.
    for (const percent of SEEK_PERCENTS) {
      this.on(seekPercentAction(percent), /** @param {KeyboardEvent} e */ (e) => {
        const target = seekPercentTarget(this.client.duration, percent);
        if (target !== null) {
          this.client.currentTime = target;
        }
      });
    }

    this.on('VolumeUp', /** @param {KeyboardEvent} e */ (e) => {
      this.client.volume = Math.round(Math.min(this.client.volume + 0.10, 3) * 100) / 100;
      this.client.interfaceController.showControlBarTemporarily();
    });

    this.on('VolumeDown', /** @param {KeyboardEvent} e */ (e) => {
      this.client.volume = Math.round(Math.max(this.client.volume - 0.10, 0) * 100) / 100;
      this.client.interfaceController.showControlBarTemporarily();
    });

    this.on('VolumeReset', /** @param {KeyboardEvent} e */ (e) => {
      this.client.volume = 1;
      this.client.interfaceController.showControlBarTemporarily();
    });

    this.on('Mute', /** @param {KeyboardEvent} e */ (e) => {
      this.client.interfaceController.volumeControls.muteToggle();
    });

    this.on('SeekForward', /** @param {KeyboardEvent} e */ (e) => {
      this.client.setSeekSave(false);
      this.client.currentTime += this.client.options.seekStepSize;
      this.client.setSeekSave(true);
    });

    this.on('SeekBackward', /** @param {KeyboardEvent} e */ (e) => {
      this.client.setSeekSave(false);
      this.client.currentTime += -this.client.options.seekStepSize;
      this.client.setSeekSave(true);
    });

    // mpv's frame-step: pause, then exactly one frame, however long a frame is.
    this.on('SeekForwardFrame', /** @param {KeyboardEvent} e */ (e) => this.stepFrame(1));
    this.on('SeekBackwardFrame', /** @param {KeyboardEvent} e */ (e) => this.stepFrame(-1));

    this.on('PlayPause', /** @param {KeyboardEvent} e */ (e) => {
      this.client.interfaceController.playPauseToggle();
    });

    this.on('Fullscreen', /** @param {KeyboardEvent} e */ (e) => {
      this.client.interfaceController.fullscreenToggle();
      this.client.interfaceController.hideControlBarOnAction();
    });

    this.on('PictureInPicture', /** @param {KeyboardEvent} e */ (e) => {
      this.client.interfaceController.pipToggle();
    });

    // mpv's fixed hops: J/K 10 s, Z/X 60 s. Relative seeks like the arrows, so they are
    // not saved for undo either.
    this.on('SeekBackward10s', /** @param {KeyboardEvent} e */ (e) => this.seekBy(FIXED_SEEKS.SeekBackward10s));
    this.on('SeekForward10s', /** @param {KeyboardEvent} e */ (e) => this.seekBy(FIXED_SEEKS.SeekForward10s));
    this.on('SeekBackward60s', /** @param {KeyboardEvent} e */ (e) => this.seekBy(FIXED_SEEKS.SeekBackward60s));
    this.on('SeekForward60s', /** @param {KeyboardEvent} e */ (e) => this.seekBy(FIXED_SEEKS.SeekForward60s));

    // Every speed key shows the speed it left, top left over the video, as mpv does: the
    // control bar's rate button alone was easy to miss (and the bar may be hidden).
    /** @type {OnScreenDisplay} */
    this.osd = new OnScreenDisplay();

    this.on('IncreasePlaybackRate', /** @param {KeyboardEvent} e */ (e) => {
      // Above the rate with sound (the 16x key), it stays: min() took it down to 8x.
      const rate = this.client.playbackRate;
      if (rate < this.client.options.maxPlaybackRate) {
        this.client.playbackRate = Math.min(rate + 0.1, this.client.options.maxPlaybackRate);
      }
      this.client.interfaceController.showControlBarTemporarily();
      this.showSpeed();
      this.rememberSpeed();
    });

    this.on('DecreasePlaybackRate', /** @param {KeyboardEvent} e */ (e) => {
      this.client.playbackRate = Math.max(this.client.playbackRate - 0.1, 0.1);
      this.client.interfaceController.showControlBarTemporarily();
      this.showSpeed();
      this.rememberSpeed();
    });

    this.on('ResetPlaybackRate', /** @param {KeyboardEvent} e */ (e) => {
      this.client.playbackRate = 1;
      this.client.interfaceController.showControlBarTemporarily();
      this.showSpeed();
      this.rememberSpeed();
    });

    // mpv-style speed presets (a port of the user's speed-presets.lua): a preset key
    // sets its speed; pressing the SAME key again reverts to the speed that was active
    // just before that key took effect. Memory is per KEY for the session, so
    // q(3x) -> y(5x) -> y reverts to 3x, and a(4x) remembers 3x. Fine adjustments
    // (Shift+arrows) are deliberately not tracked as revert targets: they are
    // adjustments, not presets - the next preset press simply reverts to whatever they
    // left active. The rules live in applySpeedPreset.
    /** @type {Record<string, number|undefined>} */
    this.presetRevertMemory = {};
    for (const preset of SPEED_PRESETS) {
      const action = speedPresetAction(preset);
      this.on(action, /** @param {KeyboardEvent} e */ (e) => {
        const {rate, remembered} = applySpeedPreset(
            preset, this.client.playbackRate, SILENT_MAX_PLAYBACK_RATE,
            this.presetRevertMemory[action]);
        this.presetRevertMemory[action] = remembered;
        if (rate !== this.client.playbackRate) {
          // Past the sound only for a preset: 16x plays 16x, silent (2026-10-10).
          this.client.setPlaybackRate(rate, true);
        }
        this.client.interfaceController.showControlBarTemporarily();
        this.showSpeed();
        this.rememberSpeed();
      });
    }

    this.on('UndoSeek', /** @param {KeyboardEvent} e */ (e) => {
      this.client.undoSeek();
      this.client.interfaceController.showControlBarTemporarily();
    });

    this.on('RedoSeek', /** @param {KeyboardEvent} e */ (e) => {
      this.client.redoSeek();
      this.client.interfaceController.showControlBarTemporarily();
    });

    this.on('ResetFailed', /** @param {KeyboardEvent} e */ (e) => {
      this.client.resetFailed();
    });

    this.on('RemoveDownloader', /** @param {KeyboardEvent} e */ (e) => {
      if (this.client.downloadManager.downloaders.length > 0) {
        this.client.downloadManager.removeDownloader();
        this.client.interfaceController.updateFragmentsLoaded();
      }
    });

    this.on('AddDownloader', /** @param {KeyboardEvent} e */ (e) => {
      if (this.client.downloadManager.downloaders.length < this.client.downloadManager.downloaderLimit()) {
        this.client.downloadManager.addDownloader();
        this.client.interfaceController.updateFragmentsLoaded();
      }
    });

    // Only act while a track is open in the subtitle resync tool.
    this.on('ShiftSubtitlesLater', /** @param {KeyboardEvent} e */ (e) => {
      this.client.interfaceController.subtitlesManager.subtitleSyncer.shiftSubtitles(0.2);
    });

    this.on('ShiftSubtitlesEarlier', /** @param {KeyboardEvent} e */ (e) => {
      this.client.interfaceController.subtitlesManager.subtitleSyncer.shiftSubtitles(-0.2);
    });

    this.on('ToggleSubtitles', /** @param {KeyboardEvent} e */ (e) => {
      this.client.interfaceController.subtitlesManager.toggleSubtitles();
    });


    this.on('FlipVideo', /** @param {KeyboardEvent} e */ (e) => {
      const options = this.client.options;
      options.videoFlip = (options.videoFlip + 1) % 4;
      this.client.updateVideoTransform();
    });

    this.on('RotateVideo', /** @param {KeyboardEvent} e */ (e) => {
      const options = this.client.options;
      options.videoRotate = (options.videoRotate + 3) % 4;
      this.client.updateVideoTransform();
    });

    this.on('ZoomInVideo', /** @param {KeyboardEvent} e */ (e) => {
      const options = this.client.options;
      options.videoZoom = Utils.clamp(options.videoZoom + 0.05, 0, 2);
      this.client.updateVideoTransform();
    });

    this.on('ZoomOutVideo', /** @param {KeyboardEvent} e */ (e) => {
      const options = this.client.options;
      options.videoZoom = Utils.clamp(options.videoZoom - 0.05, 0, 2);
      this.client.updateVideoTransform();
    });

    this.on('ZoomReset', /** @param {KeyboardEvent} e */ (e) => {
      const options = this.client.options;
      options.videoZoom = 1;
      this.client.updateVideoTransform();
    });

    // Auto, then each ratio, then stretch, then auto again (upstream #552).
    this.on('CycleAspectRatio', /** @param {KeyboardEvent} e */ (e) => {
      const options = this.client.options;
      const ratios = Object.values(AspectRatios);
      options.videoAspectRatio = ratios[(ratios.indexOf(options.videoAspectRatio) + 1) % ratios.length];
      this.client.updateVideoTransform();
    });

    this.on('WindowedFullscreen', /** @param {KeyboardEvent} e */ (e) => {
      this.client.interfaceController.toggleWindowedFullscreen();
    });

    this.on('NextVideo', /** @param {KeyboardEvent} e */ (e) => {
      this.client.nextVideo();
    });

    this.on('PreviousVideo', /** @param {KeyboardEvent} e */ (e) => {
      this.client.previousVideo();
    });

    this.on('SaveVideo', /** @param {KeyboardEvent} e */ (e) => {
      this.client.interfaceController.saveManager.saveVideo(e);
    });

    this.on('Screenshot', /** @param {KeyboardEvent} e */ (e) => {
      this.client.interfaceController.saveManager.saveScreenshot(e);
    });

    this.on('PauseDownloaders', /** @param {KeyboardEvent} e */ (e) => {
      if (!this.client.downloadManager.paused) {
        this.client.downloadManager.pause();
      } else {
        this.client.downloadManager.resume();
      }
    });
  }

  /**
   * Shows the playback speed now in effect on screen (OnScreenDisplay), as "2×".
   */
  /**
   * Keeps the speed a key set for the next video, as the speed menu keeps its own (and
   * mpv's remember-speed every speed): only the menu saved it. The menu's save, 500 ms
   * after the last change; a 16x left by its key comes back as 8x (PlaybackRateChanger's
   * loadState). Holding the video's double speed is not a key's and is not kept.
   */
  rememberSpeed() {
    this.client.interfaceController.playbackRateChanger?.scheduleSave();
  }

  showSpeed() {
    this.osd.show(describePlaybackRate(this.client.playbackRate, this.client.options.maxPlaybackRate,
        Localize.getMessage('player_speed_nosound')));
  }

  /**
   * @param {number} seconds - Forward when positive, back when negative.
   */
  seekBy(seconds) {
    // The client's currentTime setter keeps the target inside the video, as it does for
    // the arrows.
    this.client.setSeekSave(false);
    this.client.currentTime = this.client.currentTime + seconds;
    this.client.setSeekSave(true);
  }

  /**
   * @param {number} direction - 1 forward, -1 back.
   */
  async stepFrame(direction) {
    if (!this.client.player) {
      return;
    }
    if (!this.client.paused) {
      await this.client.pause();
    }
    this.client.setSeekSave(false);
    this.client.currentTime = this.client.frameStepper.step(this.client.currentTime, direction);
    this.client.setSeekSave(true);
  }

  /**
   * @param {Object<string, string>} keybinds - Action to key string (the options' keybinds).
   */
  setKeybinds(keybinds) {
    for (const keybind in keybinds) {
      if (this.keybindMap.has(keybind)) {
        this.keybindMap.set(keybind, keybinds[keybind]);
      }
    }
  }

  /**
   * @param {string} keyString - As WebUtils.getKeyString builds it, e.g. 'Shift+KeyW'.
   * @return {string[]} The actions the key triggers.
   */
  keyStringToKeybinds(keyString) {
    return actionsForKey(keyString, this.keybindMap);
  }

  /**
   * @param {string} keyString - As WebUtils.getKeyString builds it.
   * @param {KeyboardEvent} e - The key press, passed on to each action.
   * @return {boolean} Whether the key triggered an action.
   */
  handleKeyString(keyString, e) {
    const keybinds = this.keyStringToKeybinds(keyString);
    if (keybinds.length !== 0) {
      this.emit('keybind', keybinds, e);
      keybinds.forEach((keybind) => {
        this.emit(keybind, e);
      });
      return true;
    }
    return false;
  }

  /**
   * @param {KeyboardEvent} e
   */
  onKeyDown(e) {
    // Typing in a field is not a command: a digit typed into a number box must not jump
    // the video, nor a letter typed into a search box change the speed. Combinations
    // with Ctrl, Alt or Meta still count, since Right Alt hides the player - but not AltGr,
    // which types a character (@, €, { on a German keyboard): Windows reports it as
    // Ctrl+Alt, and typing @ into the subtitle search hid the player (review, 2026-10-09).
    if (isTextEntryTarget(e.target)) {
      const altGraph = e.key === 'AltGraph' ||
        (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'));
      if (altGraph || (!e.ctrlKey && !e.altKey && !e.metaKey)) {
        return;
      }
    }

    const keyString = WebUtils.getKeyString(e);

    if (this.handleKeyString(keyString, e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}
