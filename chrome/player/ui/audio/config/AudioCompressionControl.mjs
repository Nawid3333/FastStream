import {finiteOr} from './ConfigNumbers.mjs';

// +20 dB, the top of the compressor's gain knob.
const MAX_MAKEUP_GAIN = 10;

export class AudioCompressionControl {
  constructor(enabled, attack, knee, ratio, release, threshold, gain) {
    this.enabled = !!enabled;
    this.attack = parseFloat(attack);
    this.knee = parseFloat(knee);
    this.ratio = parseFloat(ratio);
    this.release = parseFloat(release);
    this.threshold = parseFloat(threshold);
    this.gain = parseFloat(gain);
  }

  static fromObj(obj) {
    // Within the knobs' ranges; a value that is not a number threw when the compressor was
    // built, so it takes the default.
    const def = AudioCompressionControl.default();
    return new AudioCompressionControl(obj.enabled,
        finiteOr(obj.attack, def.attack, 0, 1),
        finiteOr(obj.knee, def.knee, 0, 40),
        finiteOr(obj.ratio, def.ratio, 1, 20),
        finiteOr(obj.release, def.release, 0, 1),
        finiteOr(obj.threshold, def.threshold, -80, 0),
        finiteOr(obj.gain, def.gain, 1, MAX_MAKEUP_GAIN));
  }

  static default() {
    return new AudioCompressionControl(false, 0.003, 30, 12, 0.25, -24, 1);
  }

  isDefault() {
    const def = AudioCompressionControl.default();
    return this.enabled === def.enabled &&
      this.attack === def.attack &&
      this.knee === def.knee &&
      this.ratio === def.ratio &&
      this.release === def.release &&
      this.threshold === def.threshold &&
      this.gain === def.gain;
  }

  toObj() {
    return {
      enabled: this.enabled,
      attack: this.attack,
      knee: this.knee,
      ratio: this.ratio,
      release: this.release,
      threshold: this.threshold,
      gain: this.gain,
    };
  }
}

