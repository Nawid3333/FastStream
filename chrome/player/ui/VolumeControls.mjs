import {EventEmitter} from '../modules/eventemitter.mjs';
import {Localize} from '../modules/Localize.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {DOMElements} from './DOMElements.mjs';

const MAX_VOLUME = EnvUtils.isWebAudioSupported() ? 3 : 1;

if (!EnvUtils.isWebAudioSupported()) {
  DOMElements.volumeUnity.style.display = 'none';
}

export class VolumeControls extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.volume = 1;
    this.previousVolume = 1;
    this.muted = false;
  }

  setupUI() {
    DOMElements.volumeContainer.addEventListener('mousedown', this.onVolumeBarMouseDown.bind(this));
    DOMElements.volumeContainer.addEventListener('dblclick', (e) => {
      this.setVolume(1);
      e.stopPropagation();
    });
    DOMElements.muteBtn.addEventListener('click', this.muteToggle.bind(this));
    DOMElements.volumeBlock.tabIndex = 0;
    DOMElements.volumeBlock.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.muteToggle();
        e.stopPropagation();
      } else if (e.key === 'ArrowLeft') {
        this.setVolume(Math.max(0, this.volume - 0.1));
        e.stopPropagation();
      } else if (e.key === 'ArrowRight') {
        this.setVolume(Math.min(MAX_VOLUME, this.volume + 0.1));
        e.stopPropagation();
      }
    });

    DOMElements.volumeBlock.addEventListener('wheel', (e) => {
      let delta = e.deltaY;
      if (!EnvUtils.isMacOS()) {
        delta = -delta;
      }
      this.setVolume(Math.max(0, Math.min(3, this.client.volume + Utils.clamp(delta, -1, 1) * 0.01)));
      e.preventDefault();
      e.stopPropagation();
    });

    this.loadVolumeState();
  }

  setVolume(volume, dontSave = false) {
    if (volume < 0) {
      volume = 0;
    }

    if (volume > MAX_VOLUME) {
      volume = MAX_VOLUME;
    }

    if (volume === 0 && this.volume !== 0) {
      this.previousVolume = this.volume;
    }

    this.muted = volume === 0;
    this.volume = volume;

    this.updateVolumeBar(volume);

    if (!dontSave) {
      this.saveVolumeState();
    }

    this.emit('volume', volume);
  }

  muteToggle() {
    if (0 !== this.volume && !this.muted) {
      this.setVolume(0);
    } else {
      this.setVolume(this.previousVolume);
    }
  }

  onVolumeBarMouseDown(event) {
    // Only the left button drags. A right-click's context menu takes the mouseup, and the
    // volume then followed the mouse until the next click.
    if (event.button !== 0) {
      return;
    }

    const shiftVolume = (volumeBarX) => {
      const totalWidth = DOMElements.volumeControlBar.clientWidth;

      if (totalWidth) {
        const newVolume = volumeBarX / totalWidth * MAX_VOLUME;

        if (newVolume < 0.025) {
          this.setVolume(0);
        } else if (newVolume > 2.975) {
          this.setVolume(3);
        } else if (newVolume > 0.975 && newVolume < 1.025) {
          this.setVolume(1);
        } else {
          this.setVolume(newVolume);
        }
      }
    };

    const onVolumeBarMouseMove = (event) => {
      // No button held: it was let go where this drag never heard of it.
      if (event.type === 'mousemove' && event.buttons === 0) {
        stopDrag();
        return;
      }
      const currentX = event.clientX - WebUtils.getOffsetLeft(DOMElements.volumeContainer) - 10;
      shiftVolume(currentX);
    };

    const stopDrag = () => {
      DOMElements.playerContainer.removeEventListener('mousemove', onVolumeBarMouseMove);
      DOMElements.playerContainer.removeEventListener('touchmove', onVolumeBarMouseMove);
      DOMElements.playerContainer.removeEventListener('mouseup', onVolumeBarMouseUp);
      DOMElements.playerContainer.removeEventListener('touchend', onVolumeBarMouseUp);
      document.removeEventListener('mouseup', onVolumeBarMouseUp);
    };

    const onVolumeBarMouseUp = (event) => {
      stopDrag();

      const currentX = event.clientX - WebUtils.getOffsetLeft(DOMElements.volumeContainer) - 10;

      if (!isNaN(currentX)) {
        shiftVolume(currentX);
      }
    };

    DOMElements.playerContainer.addEventListener('mouseup', onVolumeBarMouseUp);
    DOMElements.playerContainer.addEventListener('touchend', onVolumeBarMouseUp, {passive: true});
    DOMElements.playerContainer.addEventListener('mousemove', onVolumeBarMouseMove);
    DOMElements.playerContainer.addEventListener('touchmove', onVolumeBarMouseMove, {passive: true});
    // Let go outside the player: a drag keeps the mouse events in the document it started
    // in, and only the document hears that mouseup.
    document.addEventListener('mouseup', onVolumeBarMouseUp);

    event.stopPropagation();
  }

  updateVolumeBar(volume) {
    const currentVolumeTag = DOMElements.currentVolume;
    const muteButtonTag = DOMElements.muteBtn;

    if (volume === 0) {
      muteButtonTag.classList.add('muted');
    } else {
      muteButtonTag.classList.remove('muted');
    }

    currentVolumeTag.style.width = (volume * 100) / MAX_VOLUME + '%';
    DOMElements.currentVolumeText.textContent = Math.round(volume * 100) + '%';

    DOMElements.volumeBanner.textContent = Math.round(volume * 100) + '%';
    if (volume === 1 || volume === 0) {
      DOMElements.volumeBanner.style.display = 'none';
    } else {
      DOMElements.volumeBanner.style.display = '';
    }

    WebUtils.setLabels(DOMElements.volumeBlock, Localize.getMessage('player_volume_label', [Math.round(volume * 100)]));
    // The block is a slider (role="slider"), and a screen reader reads a slider's value
    // from these; it had none.
    DOMElements.volumeBlock.setAttribute('aria-valuemin', 0);
    DOMElements.volumeBlock.setAttribute('aria-valuemax', Math.round(MAX_VOLUME * 100));
    DOMElements.volumeBlock.setAttribute('aria-valuenow', Math.round(volume * 100));
    DOMElements.volumeBlock.setAttribute('aria-valuetext', Math.round(volume * 100) + '%');
  }

  async loadVolumeState() {
    const state = await Utils.loadAndParseOptions('volumeState', {
      volume: 1,
    });
    this.setVolume(state.volume, true);
  }

  async saveVolumeState() {
    await Utils.setConfig('volumeState', JSON.stringify({
      volume: this.volume,
    }));
  }
}
