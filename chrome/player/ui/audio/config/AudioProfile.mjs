import {AudioChannelControl} from './AudioChannelControl.mjs';
import {AudioCompressionControl} from './AudioCompressionControl.mjs';
import {AudioCrosstalkControl} from './AudioCrosstalkControl.mjs';
import {AudioEQNode} from './AudioEQNode.mjs';

export const MAX_AUDIO_CHANNELS = 6; // 8; Change to 8 when 7.1 audio is fixed.
export const CHANNEL_NAMES = ['Left', 'Right', 'Center', 'Bass (LFE)', 'Left Surround', 'Right Surround', 'Side Left', 'Side Right'];

// The convolver is deliberately not part of an audio profile: it has its own
// global config and profile list (see OutputConvolver / AudioConvolverControl),
// because its impulse responses live in IndexedDB and describe the output
// device, not the content being played.
export class AudioProfile {
  constructor(id) {
    this.id = parseInt(id);
    this.channels = Array.from({length: MAX_AUDIO_CHANNELS}, (_, i) => {
      return AudioChannelControl.default(i);
    });
    this.master = AudioChannelControl.default('master');
    this.crosstalk = AudioCrosstalkControl.default();
    this.label = `Profile ${id}`;
  }

  static fromObj(obj) {
    const profile = new AudioProfile(obj.id);
    profile.label = obj.label;

    if (Array.isArray(obj.channels) && obj.channels.length <= MAX_AUDIO_CHANNELS) {
      profile.channels = obj.channels.filter((channel) => channel && typeof channel === 'object').map((channel) => {
        return AudioChannelControl.fromObj(channel);
      });
    } else if (obj.mixerChannels && obj.mixerChannels.length === 7) { // Legacy
      profile.channels = obj.mixerChannels.map((channel) => {
        return AudioChannelControl.fromObj(channel);
      });
      profile.master = profile.channels.pop();
    }

    // One channel per ID, 0 to MAX_AUDIO_CHANNELS - 1, in order, the missing ones default:
    // a full list with an ID out of range (7) or twice had no channel for some ID, and the
    // mixer threw on it. The first of an ID wins; other IDs are dropped.
    const channels = profile.channels;
    profile.channels = Array.from({length: MAX_AUDIO_CHANNELS}, (_, i) => {
      return channels.find((ch) => ch.id === i) || AudioChannelControl.default(i);
    });

    if (obj.master) {
      profile.master = AudioChannelControl.fromObj({...obj.master, id: 'master'});
    }

    if (!profile.master) {
      profile.master = AudioChannelControl.default('master');
    }

    if (Array.isArray(obj.equalizerNodes)) {
      profile.master.equalizerNodes = obj.equalizerNodes.map((node) => {
        return AudioEQNode.fromObj(node);
      }).filter((node) => node);
    }

    if (obj.compressor) {
      profile.master.compressor = AudioCompressionControl.fromObj(obj.compressor);
    }

    if (obj.crosstalk) {
      profile.crosstalk = AudioCrosstalkControl.fromObj(obj.crosstalk);
    }

    // console.log('Loaded audio profile:', profile, obj);
    return profile;
  }

  copy() {
    return AudioProfile.fromObj(this.toObj());
  }

  toObj() {
    const obj = {
      id: this.id,
      label: this.label,
    };

    const nonDefaultChannels = this.channels.filter((channel) => !channel.isDefault());
    if (nonDefaultChannels.length > 0) {
      obj.channels = this.channels.map((channel) => {
        return channel.toObj();
      });
    }

    if (!this.master.isDefault()) {
      obj.master = this.master.toObj();
    }

    if (!this.crosstalk.isDefault()) {
      obj.crosstalk = this.crosstalk.toObj();
    }

    return obj;
  }
}
