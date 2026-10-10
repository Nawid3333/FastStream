import {MAX_AUDIO_CHANNELS} from './AudioProfile.mjs';
import {finiteOr} from './ConfigNumbers.mjs';

/**
 * An impulse length as the field gives it: -1 (or an empty field) is the whole file, a number
 * at least 128 samples. Anything else is the fallback.
 * @param {*} value - A number, -1, or the field's text.
 * @param {number} fallback
 * @return {number}
 */
export function impulseLengthOf(value, fallback) {
  if (value === -1 || value === '') return -1;
  const number = Math.floor(finiteOr(value, NaN));
  return Number.isFinite(number) ? Math.max(128, number) : fallback;
}

export class AudioConvolverChannel {
  constructor(id, enabled, normalize) {
    this.id = id;
    this.enabled = !!enabled;
    this.normalize = !!normalize;
  }

  toObj() {
    return {
      id: this.id,
      enabled: this.enabled,
      normalize: this.normalize,
    };
  }

  static fromObj(obj) {
    return new AudioConvolverChannel(obj.id, obj.enabled, obj.normalize);
  }

  static default(id) {
    return new AudioConvolverChannel(id, false, false);
  }

  isDefault() {
    const def = AudioConvolverChannel.default(0);
    return this.enabled === def.enabled &&
            this.normalize === def.normalize;
  }
}

export class AudioConvolverProfile {
  constructor(id, label, downmix, bufferSize, channels) {
    this.id = id;
    this.label = label;
    this.downmix = !!downmix;
    this.bufferSize = bufferSize;

    this.channels = channels || [];
  }

  static fromObj(obj) {
    const channels = (obj.channels || []).map((ch) => AudioConvolverChannel.fromObj(ch));
    const newChannels = [];
    for (let i = 0; i < MAX_AUDIO_CHANNELS; i++) {
      const existingChannel = channels.find((ch) => ch.id === i);
      if (existingChannel) {
        newChannels.push(existingChannel);
      } else {
        newChannels.push(AudioConvolverChannel.default(i));
      }
    }
    // -1 is the whole file (an empty field: no limit, the owner's rule); a number is at least
    // 128 samples, with no upper limit since 2026-10-10. A stored value that is no number is
    // the default.
    const bufferSize = impulseLengthOf(obj.bufferSize, 4096);
    return new AudioConvolverProfile(obj.id, obj.label, obj.downmix, bufferSize, newChannels);
  }

  static default(id) {
    const channels = [];
    for (let i = 0; i < MAX_AUDIO_CHANNELS; i++) {
      channels.push(AudioConvolverChannel.default(i));
    }
    return new AudioConvolverProfile(id, `Profile ${id + 1}`, true, 4096, channels);
  }

  isDefault() {
    const def = AudioConvolverProfile.default(this.id);
    if (this.label !== def.label || this.downmix !== def.downmix || this.bufferSize !== def.bufferSize) {
      return false;
    }
    if (this.channels.length !== def.channels.length) {
      return false;
    }
    for (let i = 0; i < this.channels.length; i++) {
      if (!this.channels[i].isDefault()) {
        return false;
      }
    }
    return true;
  }

  toObj() {
    return {
      id: this.id,
      label: this.label,
      downmix: this.downmix,
      bufferSize: this.bufferSize,
      channels: this.channels.filter((ch) => !ch.isDefault()).map((ch) => ch.toObj()),
    };
  }
}


export const NUM_CONVOLVER_PROFILES = 8;

export class AudioConvolverControl {
  constructor(enabled, profiles) {
    this.enabled = !!enabled;
    this.profiles = profiles || [];
  }
  static fromObj(obj) {
    const profiles = (obj.profiles || []).map((p) => AudioConvolverProfile.fromObj(p));
    const newProfiles = [];
    for (let i = 0; i < NUM_CONVOLVER_PROFILES; i++) {
      const existingProfile = profiles.find((p) => p.id === i);
      if (existingProfile) {
        newProfiles.push(existingProfile);
      } else {
        newProfiles.push(AudioConvolverProfile.default(i));
      }
    }
    return new AudioConvolverControl(obj.enabled, newProfiles);
  }

  static default() {
    const profiles = [];
    for (let i = 0; i < NUM_CONVOLVER_PROFILES; i++) {
      profiles.push(AudioConvolverProfile.default(i));
    }
    return new AudioConvolverControl(false, profiles);
  }

  isDefault() {
    for (let i = 0; i < this.profiles.length; i++) {
      if (!this.profiles[i].isDefault()) {
        return false;
      }
    }
    return this.enabled === false;
  }

  toObj() {
    return {
      enabled: this.enabled,
      profiles: this.profiles.filter((p) => !p.isDefault()).map((p) => p.toObj()),
    };
  }
}
