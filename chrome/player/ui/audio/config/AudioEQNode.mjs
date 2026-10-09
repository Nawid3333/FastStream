import {finiteOr} from './ConfigNumbers.mjs';

// What a BiquadFilterNode can be. It ignores any other type it is given, so a node of an
// unknown type stayed a lowpass at its frequency.
const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass'];

export class AudioEQNode {
  constructor(type, frequency, gain, q) {
    this.type = type;
    this.frequency = parseFloat(frequency);
    this.gain = parseFloat(gain);
    this.q = parseFloat(q);
  }

  /**
   * @param {Object} obj - A node as stored or imported.
   * @return {AudioEQNode|null} null for a node with no usable type or frequency.
   */
  static fromObj(obj) {
    const frequency = parseFloat(obj?.frequency);
    if (!FILTER_TYPES.includes(obj?.type) || !Number.isFinite(frequency) || frequency <= 0) {
      return null;
    }
    // null too: JSON writes a gain that was no number as null, and the band's gain under
    // its old name was lost.
    const gain = obj.gainDb == null ? obj.gain : obj.gainDb;
    return new AudioEQNode(obj.type, frequency, finiteOr(gain, 0), finiteOr(obj.q, 1));
  }

  toObj() {
    return {
      type: this.type,
      frequency: this.frequency,
      gainDb: this.gain,
      q: this.q,
    };
  }
}
