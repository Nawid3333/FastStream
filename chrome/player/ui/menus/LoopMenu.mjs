import {EventEmitter} from '../../modules/eventemitter.mjs';
import {DOMElements} from '../DOMElements.mjs';
import {Localize} from '../../modules/Localize.mjs';
import {WebUtils} from '../../utils/WebUtils.mjs';
import {Utils} from '../../utils/Utils.mjs';
import {GIF} from '../../modules/gif/gif.mjs';

export class LoopMenu extends EventEmitter {
  constructor(client) {
    super();

    this.client = client;
    this.loopEnabled = false;
    // Whether the two times make a loop: one half typed (the end at 3 on the way to 3:00) does
    // not, and looping waits. It turned the loop off, and it stayed off once the time was typed.
    this.loopRangeValid = true;
    this.loopStart = null;
    this.loopEnd = null;
    // An empty end is the end of the video: "00:00:00.000" there read as "end at 0".
    this.loopTimeSettings = {
      start: '00:00:00.000',
      end: '',
    };
    this.timeInputs = {};

    this.loopHandler = this.checkLoopLoop.bind(this);
  }

  reset() {
    if (this.gifLoopRunning) {
      this.gifLoopRunning = false;
      if (this.gif) {
        this.gif.abort();
        this.gif = null;
      }
      this.client.playbackRate = this.previousPlaybackRate;
    }
    this.recordingGif = false;
    this.loopEnabled = false;
    this.loopStart = null;
    this.loopEnd = null;
    this.loopLoopRunning = false;
    this.updateLoopAndGif();
  }

  currentTimeToTimecode(time) {
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor(time / 60) % 60;
    const seconds = Math.floor(time % 60);
    const milliseconds = Math.floor(time * 1000) % 1000;

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
  }
  setupUI() {
    DOMElements.loopMenu.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });

    DOMElements.loopMenu.addEventListener('keyup', (e) => {
      e.stopPropagation();
    });

    DOMElements.loopMenu.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    DOMElements.loopMenu.addEventListener('mouseup', (e) => {
      e.stopPropagation();
    });

    DOMElements.loopMenu.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    DOMElements.loopButton.addEventListener('click', (e) => {
      if (this.isOpen()) {
        this.closeUI();
      } else {
        this.openUI();
      }
      e.stopPropagation();
    });
    WebUtils.setupTabIndex(DOMElements.loopButton);

    const timeSettings = this.loopTimeSettings;

    for (const [name, value] of Object.entries(timeSettings)) {
      const option = document.createElement('div');
      option.classList.add('option');

      const label = document.createElement('div');
      label.classList.add('label');
      label.textContent = Localize.getMessage('loop_menu_' + name);

      const input = document.createElement('input');
      input.name = name;
      input.type = 'text';
      input.value = value;
      if (name === 'end') input.placeholder = Localize.getMessage('loop_menu_end_placeholder');
      input.ariaLabel = label.textContent;
      this.timeInputs[name] = input;
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('autocapitalize', 'off');
      input.setAttribute('spellcheck', 'false');

      let timeout = null;
      input.addEventListener('keyup', () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          this.loopTimeSettings[name] = input.value;
          this.updateLoopAndGif();
        }, 200);
      });

      input.addEventListener('input', () => {
        this.loopTimeSettings[name] = input.value;
        this.updateLoopAndGif();
      });
      option.appendChild(label);

      const nowButton = document.createElement('div');
      nowButton.role = 'button';
      nowButton.classList.add('now_button');
      nowButton.textContent = '→';
      nowButton.addEventListener('click', () => {
        input.value = this.currentTimeToTimecode(this.client.currentTime);
        this.loopTimeSettings[name] = input.value;
        this.updateLoopAndGif();
      });
      WebUtils.setupTabIndex(nowButton);
      option.appendChild(nowButton);

      option.appendChild(input);


      DOMElements.loopMenu.appendChild(option);
    }

    const loopButtonContainer = document.createElement('div');
    loopButtonContainer.style = 'display: flex; justify-content: center';
    DOMElements.loopMenu.appendChild(loopButtonContainer);

    const toggleLoopButton = document.createElement('div');
    this.toggleLoopButton = toggleLoopButton;
    toggleLoopButton.role = 'button';
    toggleLoopButton.classList.add('loop_menu_toggle_button');
    toggleLoopButton.textContent = Localize.getMessage('loop_menu_toggle_' + (this.loopEnabled ? 'enabled' : 'disabled'));
    toggleLoopButton.addEventListener('click', (e) => {
      this.loopEnabled = !this.loopEnabled;
      this.updateLoopAndGif();
      e.stopPropagation();
    });
    WebUtils.setupTabIndex(toggleLoopButton);
    loopButtonContainer.appendChild(toggleLoopButton);

    const gifButton = document.createElement('div');
    gifButton.role = 'button';
    gifButton.classList.add('loop_menu_gif_button');
    gifButton.addEventListener('click', (e) => {
      // Put back once the GIF is made: it turned a loop the user had on off.
      if (!this.gifLoopRunning) this.loopWasEnabled = this.loopEnabled;
      this.loopEnabled = true;
      this.updateLoopAndGif();
      this.recordGif();
      e.stopPropagation();
    });
    WebUtils.setupTabIndex(gifButton);

    const svgIcon = WebUtils.createSVGIcon('assets/fluidplayer/static/icons2.svg#gif');
    gifButton.appendChild(svgIcon);
    loopButtonContainer.appendChild(gifButton);

    this.updateUI();
  }

  timecodeToSeconds(timecode) {
    // A decimal comma, as French and German write it: "10,5" was 10.
    const split = timecode.replace(',', '.').split(':');
    const seconds = parseFloat(split.pop());
    const minutes = parseInt(split.pop() || 0);
    const hours = parseInt(split.pop() || 0);
    return hours * 3600 + minutes * 60 + seconds;
  }

  updateLoopAndGif() {
    const player = this.client.player;
    if (this.gifLoopRunning) {
      this.stopGifRecording(true);
    }
    if (this.loopEnabled && player) {
      this.loopStart = this.timecodeToSeconds(this.loopTimeSettings.start);
      this.loopEnd = this.timecodeToSeconds(this.loopTimeSettings.end);

      // A start field that holds no time (emptied, or half typed) is the start of the video,
      // as the video's own loop already made it. NaN never let a GIF record a frame, and
      // with the end emptied too, the recording ran at 4x for good.
      if (!Number.isFinite(this.loopStart)) {
        this.loopStart = 0;
      }
      if (!Number.isFinite(this.loopEnd) || this.loopEnd <= 0) {
        this.loopEnd = this.client.duration;
      }

      this.loopRangeValid = this.loopStart < this.loopEnd && this.loopStart < this.client.duration;
      if (this.loopRangeValid) {
        this.loopStart = Utils.clamp(this.loopStart, 0, this.client.duration);
        this.loopEnd = Utils.clamp(this.loopEnd, 0, this.client.duration);
      } else {
        this.loopStart = null;
        this.loopEnd = null;
      }
    } else {
      this.loopRangeValid = true;
      this.loopStart = null;
      this.loopEnd = null;
    }
    for (const input of Object.values(this.timeInputs)) {
      input.classList.toggle('invalid', !this.loopRangeValid);
      input.setAttribute('aria-invalid', String(!this.loopRangeValid));
    }

    this.toggleLoopButton.textContent = Localize.getMessage('loop_menu_toggle_' + (this.loopEnabled ? 'enabled' : 'disabled'));
    if (this.loopEnabled) {
      this.toggleLoopButton.classList.add('enabled');
    } else {
      this.toggleLoopButton.classList.remove('enabled');
    }

    if (player) {
      if (this.loopEnabled && this.loopRangeValid) {
        player.getVideo().loop = true;
        this.startLoopLoop();
      } else {
        player.getVideo().loop = false;
      }
    }
  }

  updateUI() {

  }

  isOpen() {
    return DOMElements.loopMenu.style.display !== 'none';
  }

  openUI() {
    this.emit('open', {
      target: DOMElements.loopButton,
    });

    DOMElements.loopMenu.style.display = '';
  }

  closeUI() {
    if (DOMElements.loopMenu.style.display === 'none') {
      return false;
    }
    DOMElements.loopMenu.style.display = 'none';
    return true;
  }

  recordGif() {
    if (!this.loopEnabled || !this.loopRangeValid || this.gifLoopRunning) {
      return;
    }
    this.gif = new GIF({
      workers: 4,
      quality: 4,
      dither: false,
    });

    const player = this.client.player;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = player.getVideo().videoWidth;
    canvas.height = player.getVideo().videoHeight;

    this.gifCanvas = canvas;
    this.gifCtx = ctx;
    this.lastTimeRecorded = null;

    const loopStart = this.loopStart;

    this.client.currentTime = Math.max(loopStart - 1, 0);
    this.client.play();

    this.previousPlaybackRate = this.client.playbackRate;
    this.client.playbackRate = 4;

    this.startGifRecording();
  }

  startGifRecording() {
    if (this.gifLoopRunning) {
      return;
    }
    console.log('start gif recording');
    this.client.interfaceController.setStatusMessage('save-gif', Localize.getMessage('loop_menu_gif_start'), 'info');
    this.recordingGif = true;
    this.gifLoopRunning = true;
    this.gifLoop();
  }

  stopGifRecording(abort) {
    this.recordingGif = false;
    if (abort && this.gif) {
      this.gif.abort();
      this.gif = null;
      this.client.interfaceController.setStatusMessage('save-gif', Localize.getMessage('loop_menu_gif_abort'), 'info', 5000);
    }
  }

  gifLoop() {
    const player = this.client.player;
    if (!player) {
      this.gifLoopRunning = false;
      this.recordingGif = false;
      return;
    }
    const currentTime = Math.floor(player.currentTime * 100) / 100;
    const loopStart = this.loopStart;
    let reachedEnd = false;
    if (currentTime >= loopStart) {
      const lastRecorded = this.lastTimeRecorded;

      if (currentTime >= this.loopEnd || (lastRecorded !== null && currentTime < lastRecorded)) {
        reachedEnd = true;
      } else if (lastRecorded === null || currentTime - lastRecorded > 1/30) {
        if (lastRecorded !== null && this.gif) {
          this.gif.addFrame(this.gifCanvas, {
            delay: Math.round((currentTime - lastRecorded) * 1000),
            copy: true,
          });
        }

        this.gifCtx.drawImage(player.getVideo(), 0, 0, this.gifCanvas.width, this.gifCanvas.height);
        this.lastTimeRecorded = currentTime;
      }
    }

    if (reachedEnd || !this.loopEnabled || !this.recordingGif) {
      console.log('gif recording reached end');
      this.gifLoopRunning = false;
      this.loopEnabled = !!this.loopWasEnabled;
      this.loopWasEnabled = false;
      this.client.pause();
      this.client.playbackRate = this.previousPlaybackRate;
      this.updateLoopAndGif();
      this.finishGif();
      return;
    }
    requestAnimationFrame(this.gifLoop.bind(this));
  }

  finishGif() {
    this.recordingGif = false;
    this.gifLoopRunning = false;
    this.lastTimeRecorded = null;
    this.gifCtx = null;
    this.gifCanvas = null;


    const gif = this.gif;
    if (gif) {
      this.client.interfaceController.setStatusMessage('save-gif', Localize.getMessage('loop_menu_gif_end'), 'info', 5000);
      gif.on('progress', (p) => {
        if (this.gif === gif) {
          this.client.interfaceController.setStatusMessage('save-gif', Localize.getMessage('loop_menu_gif_progress', [Math.round(p * 1000) / 10]), 'info');
        }
      });
      gif.on('finished', (blob) => {
        this.client.interfaceController.setStatusMessage('save-gif', Localize.getMessage('loop_menu_gif_finished'), 'info', 5000);
        gif.abort();
        console.log('gif finished');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'loop.gif';
        a.click();
        URL.revokeObjectURL(url);
      });
      gif.render();
    }
  }

  startLoopLoop() {
    if (this.loopLoopRunning) {
      return;
    }
    this.loopLoopRunning = true;
    this.checkLoopLoop();
  }

  checkLoopLoop() {
    const player = this.client.player;
    if (!player || !this.loopEnabled || !this.loopRangeValid) {
      this.loopLoopRunning = false;
      return;
    }

    requestAnimationFrame(this.loopHandler);

    const currentTime = this.client.currentTime;

    if (this.gifLoopRunning) {
      if (currentTime >= this.loopEnd) {
        this.stopGifRecording();
      }
      return;
    }

    if (currentTime >= this.loopEnd) {
      this.client.currentTime = this.loopStart;
    } else if (this.loopStart > 0 && !this.gifLoopRunning) {
      if (currentTime < this.loopStart) {
        this.client.currentTime = this.loopStart;
      }
    }
  }
}
