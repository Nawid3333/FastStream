import {AudioEQNode} from './AudioEQNode.mjs';
import {AudioCompressionControl} from './AudioCompressionControl.mjs';
import {finiteOr} from './ConfigNumbers.mjs';

// +10 dB, the top of a channel's fader.
const MAX_CHANNEL_GAIN = Math.pow(10, 10 / 20);

export class AudioChannelControl {
  constructor(channelId, gain, mutedOrMono, solo, equalizerNodes, compressor) {
    this.id = channelId === 'master' ? channelId : parseInt(channelId);
    this.gain = parseFloat(gain);

    if (this.isMaster()) {
      this.mono = mutedOrMono;
    } else {
      this.muted = mutedOrMono;
      this.solo = solo;
    }

    this.equalizerNodes = equalizerNodes;
    this.compressor = compressor;
  }

  static default(id) {
    return new AudioChannelControl(id, 1, false, false, [], AudioCompressionControl.default());
  }

  static fromObj(obj) {
    const equalizerNodes = Array.isArray(obj.equalizerNodes) ? obj.equalizerNodes.map((nodeObj) => {
      return AudioEQNode.fromObj(nodeObj);
    }).filter((node) => node) : [];
    const compressor = obj.compressor ? AudioCompressionControl.fromObj(obj.compressor) : AudioCompressionControl.default();
    // The fader's range, -∞ to +10 dB; a gain that is not a number (it threw in the
    // mixer, which then left the other channels as they were) is unity.
    const gain = finiteOr(obj.gain, 1, 0, MAX_CHANNEL_GAIN);

    if (obj.id === 'master') {
      return new AudioChannelControl(obj.id, gain, !!obj.mono, null, equalizerNodes, compressor);
    } else {
      return new AudioChannelControl(obj.id, gain, !!obj.muted, !!obj.solo, equalizerNodes, compressor);
    }
  }

  isDefault() {
    if (this.gain !== 1) return false;
    if (this.isMaster()) {
      if (this.mono !== false) return false;
    } else {
      if (this.muted !== false) return false;
      if (this.solo !== false) return false;
    }

    if (this.equalizerNodes.length !== 0) return false;
    if (!this.compressor.isDefault()) return false;

    return true;
  }

  toObj() {
    if (this.isMaster()) {
      return {
        id: 'master',
        gain: this.gain,
        mono: this.mono,
        equalizerNodes: this.equalizerNodes.map((node) => {
          return node.toObj();
        }),
        compressor: this.compressor.toObj(),
      };
    } else {
      return {
        id: this.id,
        gain: this.gain,
        muted: this.muted,
        solo: this.solo,
        equalizerNodes: this.equalizerNodes.map((node) => {
          return node.toObj();
        }),
        compressor: this.compressor.toObj(),
      };
    }
  }

  isMaster() {
    return this.id === 'master';
  }
}
