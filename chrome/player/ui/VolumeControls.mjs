// @ts-check
import {EventEmitter} from '../modules/eventemitter.mjs';
import {Localize} from '../modules/Localize.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {DOMElements} from './DOMElements.mjs';

const MAX_VOLUME = EnvUtils.isWebAudioSupported() ? 3 : 1;

if (!EnvUtils.isWebAudioSupported()) {
  /** @type {HTMLElement} */ (DOMElements.volumeUnity).style.display = 'none';
}

const VolumeSaveDelayMs = 500;

export class VolumeControls extends EventEmitter {
  /** @param {import('../FastStreamClient.mjs').FastStreamClient} client */
  constructor(client) {
    super();
    this.client = client;
    this.volume = 1;
    this.previousVolume = 1;
    this.muted = false;
    // The volume is saved this long after its last change: a wheel or a drag saved it at
    // every step (review of 2026-10-14). What is heard and shown changes at once.
    this.saveTimer = null;
    globalThis.addEventListener?.('pagehide', () => this.saveVolumeNow());
  }

  setupUI() {
    /** @type {HTMLElement} */ (DOMElements.volumeContainer).addEventListener('mousedown', this.onVolumeBarMouseDown.bind(this));
    /** @type {HTMLElement} */ (DOMElements.volumeContainer).addEventListener('dblclick', (e) => {
      this.setVolume(1);
      e.stopPropagation();
    });
    /** @type {HTMLElement} */ (DOMElements.muteBtn).addEventListener('click', this.muteToggle.bind(this));
    /** @type {HTMLElement} */ (DOMElements.volumeBlock).tabIndex = 0;
    /** @type {HTMLElement} */ (DOMElements.volumeBlock).addEventListener('keydown', (e) => {
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

    /** @type {HTMLElement} */ (DOMElements.volumeBlock).addEventListener('wheel', (e) => {
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

  /** @param {number} volume */
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
      clearTimeout(/** @type {ReturnType<typeof setTimeout>|undefined} */ (this.saveTimer));
      this.saveTimer = setTimeout(() => this.saveVolumeNow(), VolumeSaveDelayMs);
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

  /** @param {MouseEvent} event */
  onVolumeBarMouseDown(event) {
    // Only the left button drags. A right-click's context menu takes the mouseup, and the
    // volume then followed the mouse until the next click.
    if (event.button !== 0) {
      return;
    }

    /** @param {number} volumeBarX */
    const shiftVolume = (volumeBarX) => {
      const totalWidth = /** @type {HTMLElement} */ (DOMElements.volumeControlBar).clientWidth;

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

    /** @param {MouseEvent|TouchEvent} event */
    const onVolumeBarMouseMove = (event) => {
      // No button held: it was let go where this drag never heard of it.
      if (event.type === 'mousemove' && /** @type {MouseEvent} */ (event).buttons === 0) {
        stopDrag();
        return;
      }
      const currentX = /** @type {MouseEvent} */ (event).clientX - WebUtils.getOffsetLeft(/** @type {HTMLElement} */ (DOMElements.volumeContainer)) - 10;
      shiftVolume(currentX);
    };

    const stopDrag = () => {
      /** @type {HTMLElement} */ (DOMElements.playerContainer).removeEventListener('mousemove', onVolumeBarMouseMove);
      /** @type {HTMLElement} */ (DOMElements.playerContainer).removeEventListener('touchmove', onVolumeBarMouseMove);
      /** @type {HTMLElement} */ (DOMElements.playerContainer).removeEventListener('mouseup', onVolumeBarMouseUp);
      /** @type {HTMLElement} */ (DOMElements.playerContainer).removeEventListener('touchend', onVolumeBarMouseUp);
      document.removeEventListener('mouseup', onVolumeBarMouseUp);
    };

    /** @param {MouseEvent|TouchEvent} event */
    const onVolumeBarMouseUp = (event) => {
      stopDrag();

      const currentX = /** @type {MouseEvent} */ (event).clientX - WebUtils.getOffsetLeft(/** @type {HTMLElement} */ (DOMElements.volumeContainer)) - 10;

      if (!isNaN(currentX)) {
        shiftVolume(currentX);
      }
    };

    /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('mouseup', onVolumeBarMouseUp);
    /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('touchend', onVolumeBarMouseUp, {passive: true});
    /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('mousemove', onVolumeBarMouseMove);
    /** @type {HTMLElement} */ (DOMElements.playerContainer).addEventListener('touchmove', onVolumeBarMouseMove, {passive: true});
    // Let go outside the player: a drag keeps the mouse events in the document it started
    // in, and only the document hears that mouseup.
    document.addEventListener('mouseup', onVolumeBarMouseUp);

    event.stopPropagation();
  }

  /** @param {number} volume */
  updateVolumeBar(volume) {
    const currentVolumeTag = /** @type {HTMLElement} */ (DOMElements.currentVolume);
    const muteButtonTag = /** @type {HTMLElement} */ (DOMElements.muteBtn);

    if (volume === 0) {
      muteButtonTag.classList.add('muted');
    } else {
      muteButtonTag.classList.remove('muted');
    }

    currentVolumeTag.style.width = (volume * 100) / MAX_VOLUME + '%';
    /** @type {HTMLElement} */ (DOMElements.currentVolumeText).textContent = Math.round(volume * 100) + '%';

    /** @type {HTMLElement} */ (DOMElements.volumeBanner).textContent = Math.round(volume * 100) + '%';
    if (volume === 1 || volume === 0) {
      /** @type {HTMLElement} */ (DOMElements.volumeBanner).style.display = 'none';
    } else {
      /** @type {HTMLElement} */ (DOMElements.volumeBanner).style.display = '';
    }

    WebUtils.setLabels(/** @type {HTMLElement} */ (DOMElements.volumeBlock), Localize.getMessage('player_volume_label', [Math.round(volume * 100)]));
    // The block is a slider (role="slider"), and a screen reader reads a slider's value
    // from these; it had none.
    /** @type {HTMLElement} */ (DOMElements.volumeBlock).setAttribute('aria-valuemin', /** @type {any} */ (0));
    /** @type {HTMLElement} */ (DOMElements.volumeBlock).setAttribute('aria-valuemax', /** @type {any} */ (Math.round(MAX_VOLUME * 100)));
    /** @type {HTMLElement} */ (DOMElements.volumeBlock).setAttribute('aria-valuenow', /** @type {any} */ (Math.round(volume * 100)));
    /** @type {HTMLElement} */ (DOMElements.volumeBlock).setAttribute('aria-valuetext', Math.round(volume * 100) + '%');
  }

  async loadVolumeState() {
    const state = await Utils.loadAndParseOptions('volumeState', {
      volume: 1,
    });
    this.setVolume(/** @type {{volume: number}} */ (state).volume, true);
  }

  /** Saves a volume change still waiting for its delay. */
  saveVolumeNow() {
    if (this.saveTimer === null) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saveVolumeState().catch((e) => console.error('Saving the volume failed', e));
  }

  async saveVolumeState() {
    await Utils.setConfig('volumeState', JSON.stringify({
      volume: this.volume,
    }));
  }
}
