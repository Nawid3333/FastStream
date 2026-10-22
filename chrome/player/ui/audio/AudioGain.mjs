// @ts-check
import {AbstractAudioModule} from './AbstractAudioModule.mjs';

export class AudioGain extends AbstractAudioModule {
  constructor() {
    super('AudioGain');
    this.gainNode = null;
    this.gain = 1;
  }

  /** @param {AudioContext} audioContext */
  setupNodes(audioContext) {
    super.setupNodes(audioContext);
    this.gainNode = null;
    /** @type {any} */ (this.getInputNode()).connect(this.getOutputNode());
    this.updateNodes();
  }

  /** @param {number} gain */
  setGain(gain) {
    this.gain = gain;
    this.updateNodes();

    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.updateNodes(true);
    }, 200);
  }

  updateNodes(yeet = false) {
    if (!this.audioContext) {
      return;
    }

    if (this.gain !== 1) {
      if (!this.gainNode) {
        this.gainNode = this.audioContext.createGain();
        /** @type {any} */ (this.getInputNode()).disconnect(this.getOutputNode());
        /** @type {any} */ (this.getInputNode()).connect(this.gainNode);
        /** @type {any} */ (this.getOutputNode()).connectFrom(this.gainNode);
      }
      this.gainNode.gain.value = this.gain;
    } else {
      if (this.gainNode && yeet) {
        /** @type {any} */ (this.getInputNode()).disconnect(this.gainNode);
        /** @type {any} */ (this.getOutputNode()).disconnectFrom(this.gainNode);
        /** @type {any} */ (this.getInputNode()).connect(this.getOutputNode());
        this.gainNode = null;
      } else if (this.gainNode) {
        // The node goes once the volume has settled; until then the old volume stayed on.
        this.gainNode.gain.value = 1;
      }
    }
  }
}
