import {ChannelCounterNode} from '../../modules/channelcounter/channelcounter.mjs';
import {Utils} from '../../utils/Utils.mjs';
import {AbstractAudioModule} from './AbstractAudioModule.mjs';
import {AudioGain} from './AudioGain.mjs';

const RECOUNTED = 'Channel counter node changed';

/**
 * The player's audio output: the volume (above 100 % as well) and as many output channels
 * as the video has, so 5.1 stays 5.1 where the output device takes it. What is left of the
 * audio settings window (mixer, equalizer, compressor, crosstalk, convolver), which went on
 * 2026-10-10.
 */
export class AudioOutput extends AbstractAudioModule {
  constructor() {
    super('AudioOutput');
    this.gain = new AudioGain();
    this.cachedChannelCount = null;
    this.channelCounterPromise = null;
    this.channelCounterNode = null;
  }

  setupNodes(audioContext) {
    super.setupNodes(audioContext);
    this.gain.setupNodes(audioContext);
    this.getInputNode().connect(this.gain.getInputNode());
    this.gain.getOutputNode().connect(this.getOutputNode());
    this.updateChannelCount();
  }

  /**
   * @param {number} value - 1 is as recorded; above 1 is louder (Web Audio's gain).
   */
  updateVolume(value) {
    this.gain.setGain(value);
  }

  updateChannelCount() {
    this.discardChannelCount();
    this.getInputChannelCount().then((count) => {
      try {
        this.audioContext.destination.channelCount = Utils.clamp(count, 2, this.audioContext.destination.maxChannelCount);
      } catch (e) {
      }
    }).catch((e) => {
      // Anything but a recount that replaced this one used to vanish here.
      if (e?.message !== RECOUNTED) {
        console.warn('The audio channels were not updated', e);
      }
    });
  }

  async getInputChannelCount() {
    if (!this.audioContext) {
      return 0;
    }

    if (this.cachedChannelCount) {
      return this.cachedChannelCount;
    }

    if (this.channelCounterPromise) {
      await this.channelCounterPromise;
      return this.cachedChannelCount;
    }

    const node = new ChannelCounterNode(this.audioContext);
    this.channelCounterNode = node;
    this.channelCounterPromise = new Promise(async (resolve, reject) => {
      try {
        await node.init();
      } catch (e) {
        // Fallback to 2 channels if init fails for ppl who have older browsers. Kept, or
        // the next caller waited on this settled promise and got null.
        if (this.channelCounterNode === node) {
          this.cachedChannelCount = 2;
          this.channelCounterPromise = null;
          this.channelCounterNode = null;
        }
        resolve(2);
        return;
      }
      // A recount while its worklet loaded (each video and each level switch asks for
      // one) discarded it: it must not run. It used to connect itself anyway and stayed
      // connected and counting for the life of the audio context.
      if (this.channelCounterNode !== node) {
        node.destroy();
        reject(new Error(RECOUNTED));
        return;
      }
      node.once('channelcount', (count) => {
        if (this.channelCounterNode !== node) {
          reject(new Error(RECOUNTED));
          return;
        }
        this.cachedChannelCount = count;
        this.channelCounterPromise = null;
        this.channelCounterNode = null;
        this.getInputNode().disconnect(node.getNode());
        node.destroy();
        resolve(count);
      });

      this.getInputNode().connect(node.getNode());
    });

    return this.channelCounterPromise;
  }

  discardChannelCount() {
    this.cachedChannelCount = null;
    this.channelCounterPromise = null;
    if (this.channelCounterNode) {
      try {
        this.getInputNode().disconnect(this.channelCounterNode.getNode());
      } catch (e) {
      }
      this.channelCounterNode.destroy();
      const node = this.channelCounterNode;
      this.channelCounterNode = null;
      node.emit('channelcount', 0);
    }
  }
}
