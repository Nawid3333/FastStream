import {finiteOr} from './ConfigNumbers.mjs';

export class AudioCrosstalkControl {
  constructor(enabled, decay, colorgain, microdelay, lowbypass, highbypass) {
    this.enabled = !!enabled;
    this.decay = parseFloat(decay);
    this.colorgain = parseFloat(colorgain);
    this.microdelay = parseFloat(microdelay);
    this.lowbypass = parseFloat(lowbypass);
    this.highbypass = parseFloat(highbypass);
  }

  static fromObj(obj) {
    // Within the knobs' ranges. The decay and the microdelay may be NaN (stored as null):
    // that means the value worked out from the distances. The others must be numbers: a
    // crossover frequency that was not one made the filter throw when it was built.
    const def = AudioCrosstalkControl.default();
    return new AudioCrosstalkControl(obj.enabled,
        finiteOr(obj.decay || obj.decaygain / 1000, NaN, -5, -0.01),
        finiteOr(obj.colorgain, def.colorgain, 0, 20),
        finiteOr(obj.microdelay, NaN, 30, 200),
        finiteOr(obj.lowbypass, def.lowbypass, 20, 2000),
        finiteOr(obj.highbypass, def.highbypass, 2000, 20000));
  }

  static default() {
    return new AudioCrosstalkControl(false, NaN, 5, NaN, 200, 6000);
  }

  isDefault() {
    const def = AudioCrosstalkControl.default();
    return this.enabled === def.enabled &&
      (this.decay === def.decay || (isNaN(this.decay) && isNaN(def.decay))) &&
      this.colorgain === def.colorgain &&
      (this.microdelay === def.microdelay || (isNaN(this.microdelay) && isNaN(def.microdelay))) &&
      this.lowbypass === def.lowbypass &&
      this.highbypass === def.highbypass;
  }

  toObj() {
    return {
      enabled: this.enabled,
      decay: this.decay,
      colorgain: this.colorgain,
      microdelay: this.microdelay,
      lowbypass: this.lowbypass,
      highbypass: this.highbypass,
    };
  }
}

