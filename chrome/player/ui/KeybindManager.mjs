import {DefaultKeybinds} from '../options/defaults/DefaultKeybinds.mjs';
import {
  FIXED_SEEKS, SEEK_PERCENTS, SPEED_PRESETS, actionsForKey, applySpeedPreset,
  isTextEntryTarget, seekPercentAction, seekPercentTarget, speedPresetAction,
} from '../options/KeybindUtils.mjs';
import {EventEmitter} from '../modules/eventemitter.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {DOMElements} from './DOMElements.mjs';
import {Utils} from '../utils/Utils.mjs';

export class KeybindManager extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.keybindMap = new Map();
    this.setup();
  }
  setup() {
    for (const keybind in DefaultKeybinds) {
      if (Object.hasOwn(DefaultKeybinds, keybind)) {
        this.keybindMap.set(keybind, DefaultKeybinds[keybind]);
      }
    }

    DOMElements.playerContainer.addEventListener('keydown', (e) => {
      this.onKeyDown(e);
    });

    document.addEventListener('keydown', (e) => {
      this.onKeyDown(e);
    });

    this.on('HidePlayer', (e) => {
      this.client.interfaceController.toggleHide();
    });

    this.on('ToggleControls', (e) => {
      this.client.interfaceController.toggleControlBar();
    });

    this.on('NextChapter', (e) => {
      const chapters = this.client.chapters;
      const time = this.client.currentTime;
      const chapter = chapters.findIndex((chapter) => chapter.startTime <= time && chapter.endTime >= time);
      if (chapter === -1) {
        return;
      }

      if (chapter + 1 < chapters.length) {
        this.client.currentTime = chapters[chapter + 1].startTime;
      }
    });

    this.on('GoToStart', (e) => {
      this.client.currentTime = 0;
    });

    // YouTube-style percentage seeks: 1..9 jump to 10%..90% of the video
    // (0 already maps to GoToStart, i.e. 0%). Same semantics as mpv's
    // "seek <N> absolute-percent" default bindings. Assigned with seek
    // saving left on, like GoToStart, so Z undoes the jump.
    for (const percent of SEEK_PERCENTS) {
      this.on(seekPercentAction(percent), (e) => {
        const target = seekPercentTarget(this.client.duration, percent);
        if (target !== null) {
          this.client.currentTime = target;
        }
      });
    }

    this.on('VolumeUp', (e) => {
      this.client.volume = Math.round(Math.min(this.client.volume + 0.10, 3) * 100) / 100;
      this.client.interfaceController.showControlBarTemporarily();
    });

    this.on('VolumeDown', (e) => {
      this.client.volume = Math.round(Math.max(this.client.volume - 0.10, 0) * 100) / 100;
      this.client.interfaceController.showControlBarTemporarily();
    });

    this.on('VolumeReset', (e) => {
      this.client.volume = 1;
      this.client.interfaceController.showControlBarTemporarily();
    });

    this.on('Mute', (e) => {
      this.client.interfaceController.volumeControls.muteToggle();
    });

    this.on('SeekForward', (e) => {
      this.client.setSeekSave(false);
      this.client.currentTime += this.client.options.seekStepSize;
      this.client.setSeekSave(true);
    });

    this.on('SeekBackward', (e) => {
      this.client.setSeekSave(false);
      this.client.currentTime += -this.client.options.seekStepSize;
      this.client.setSeekSave(true);
    });

    // mpv's frame-step: pause, then exactly one frame, however long a frame is.
    this.on('SeekForwardFrame', (e) => this.stepFrame(1));
    this.on('SeekBackwardFrame', (e) => this.stepFrame(-1));

    this.on('PlayPause', (e) => {
      this.client.interfaceController.playPauseToggle();
    });

    this.on('Fullscreen', (e) => {
      this.client.interfaceController.fullscreenToggle();
      this.client.interfaceController.hideControlBarOnAction(2000);
    });

    this.on('PictureInPicture', (e) => {
      this.client.interfaceController.pipToggle();
    });

    // mpv's fixed hops: J/K 10 s, Z/X 60 s. Relative seeks like the arrows, so they are
    // not saved for undo either.
    this.on('SeekBackward10s', (e) => this.seekBy(FIXED_SEEKS.SeekBackward10s));
    this.on('SeekForward10s', (e) => this.seekBy(FIXED_SEEKS.SeekForward10s));
    this.on('SeekBackward60s', (e) => this.seekBy(FIXED_SEEKS.SeekBackward60s));
    this.on('SeekForward60s', (e) => this.seekBy(FIXED_SEEKS.SeekForward60s));

    this.on('IncreasePlaybackRate', (e) => {
      this.client.playbackRate = Math.min(this.client.playbackRate + 0.1, this.client.options.maxPlaybackRate);
      this.client.interfaceController.showControlBarTemporarily();
    });

    this.on('DecreasePlaybackRate', (e) => {
      this.client.playbackRate = Math.max(this.client.playbackRate - 0.1, 0.1);
      this.client.interfaceController.showControlBarTemporarily();
    });

    this.on('ResetPlaybackRate', (e) => {
      this.client.playbackRate = 1;
      this.client.interfaceController.showControlBarTemporarily();
    });

    // mpv-style speed presets (a port of the user's speed-presets.lua): a preset key
    // sets its speed; pressing the SAME key again reverts to the speed that was active
    // just before that key took effect. Memory is per KEY for the session, so
    // q(3x) -> y(5x) -> y reverts to 3x, and a(4x) remembers 3x. Fine adjustments
    // (Shift+arrows) are deliberately not tracked as revert targets: they are
    // adjustments, not presets - the next preset press simply reverts to whatever they
    // left active. The rules live in applySpeedPreset.
    this.presetRevertMemory = {};
    for (const preset of SPEED_PRESETS) {
      const action = speedPresetAction(preset);
      this.on(action, (e) => {
        const {rate, remembered} = applySpeedPreset(
            preset, this.client.playbackRate, this.client.options.maxPlaybackRate,
            this.presetRevertMemory[action]);
        this.presetRevertMemory[action] = remembered;
        if (rate !== this.client.playbackRate) {
          this.client.playbackRate = rate;
        }
        this.client.interfaceController.showControlBarTemporarily();
      });
    }

    this.on('UndoSeek', (e) => {
      this.client.undoSeek();
      this.client.interfaceController.showControlBarTemporarily();
    });

    this.on('RedoSeek', (e) => {
      this.client.redoSeek();
      this.client.interfaceController.showControlBarTemporarily();
    });

    this.on('ResetFailed', (e) => {
      this.client.resetFailed();
    });

    this.on('RemoveDownloader', (e) => {
      if (this.client.downloadManager.downloaders.length > 0) {
        this.client.downloadManager.removeDownloader();
        this.client.interfaceController.updateFragmentsLoaded();
      }
    });

    this.on('AddDownloader', (e) => {
      if (!this.client.options.maximumDownloaders || this.client.downloadManager.downloaders.length < this.client.options.maximumDownloaders) {
        this.client.downloadManager.addDownloader();
        this.client.interfaceController.updateFragmentsLoaded();
      }
    });

    this.on('SkipIntroOutro', (e) => {
      this.client.interfaceController.skipSegment();
    });

    // Only act while a track is open in the subtitle resync tool.
    this.on('ShiftSubtitlesLater', (e) => {
      this.client.interfaceController.subtitlesManager.subtitleSyncer.shiftSubtitles(0.2);
    });

    this.on('ShiftSubtitlesEarlier', (e) => {
      this.client.interfaceController.subtitlesManager.subtitleSyncer.shiftSubtitles(-0.2);
    });

    this.on('ToggleSubtitles', (e) => {
      this.client.interfaceController.subtitlesManager.toggleSubtitles();
    });


    this.on('FlipVideo', (e) => {
      const options = this.client.options;
      options.videoFlip = (options.videoFlip + 1) % 4;
      this.client.updateCSSFilters();
    });

    this.on('RotateVideo', (e) => {
      const options = this.client.options;
      options.videoRotate = (options.videoRotate + 3) % 4;
      this.client.updateCSSFilters();
    });

    this.on('ZoomInVideo', (e) => {
      const options = this.client.options;
      options.videoZoom = Utils.clamp(options.videoZoom + 0.05, 0, 2);
      this.client.updateCSSFilters();
    });

    this.on('ZoomOutVideo', (e) => {
      const options = this.client.options;
      options.videoZoom = Utils.clamp(options.videoZoom - 0.05, 0, 2);
      this.client.updateCSSFilters();
    });

    this.on('ZoomReset', (e) => {
      const options = this.client.options;
      options.videoZoom = 1;
      this.client.updateCSSFilters();
    });

    this.on('WindowedFullscreen', (e) => {
      this.client.interfaceController.toggleWindowedFullscreen();
    });

    this.on('NextVideo', (e) => {
      this.client.nextVideo();
    });

    this.on('PreviousVideo', (e) => {
      this.client.previousVideo();
    });

    this.on('SaveVideo', (e) => {
      this.client.interfaceController.saveManager.saveVideo(e);
    });

    this.on('Screenshot', (e) => {
      this.client.interfaceController.saveManager.saveScreenshot(e);
    });

    this.on('ToggleVisualFilters', (e) => {
      this.client.interfaceController.toggleVisualFilters();
    });

    this.on('PauseDownloaders', (e) => {
      if (!this.client.downloadManager.paused) {
        this.client.downloadManager.pause();
      } else {
        this.client.downloadManager.resume();
      }
    });

    this.on('keybind', (keybind, e) => {
      // console.log("Keybind", keybind);
    });
  }

  seekBy(seconds) {
    // A 60 s hop from 20 s would hand -40 to the scheduler's state and the separate
    // audio track; the media element clamps, they do not.
    this.client.setSeekSave(false);
    this.client.currentTime = Math.max(0, this.client.currentTime + seconds);
    this.client.setSeekSave(true);
  }

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

  setKeybinds(keybinds) {
    for (const keybind in keybinds) {
      if (this.keybindMap.has(keybind)) {
        this.keybindMap.set(keybind, keybinds[keybind]);
      }
    }
  }

  eventToKeybind(e) {
    return this.eventToKeybinds(e)[0];
  }

  eventToKeybinds(e) {
    const keyString = WebUtils.getKeyString(e);
    return this.keyStringToKeybinds(keyString, e);
  }

  keyStringToKeybinds(keyString) {
    return actionsForKey(keyString, this.keybindMap);
  }

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

  onKeyDown(e) {
    // Typing in a field is not a command: a digit typed into a number box must not jump
    // the video, nor a letter typed into a search box change the speed. Combinations
    // with Ctrl, Alt or Meta still count, since Right Alt hides the player.
    if (isTextEntryTarget(e.target) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      return;
    }

    const keyString = WebUtils.getKeyString(e);

    if (this.handleKeyString(keyString, e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}
