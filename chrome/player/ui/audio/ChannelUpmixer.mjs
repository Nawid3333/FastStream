import {AbstractAudioModule} from './AbstractAudioModule.mjs';

export class ChannelUpmixer extends AbstractAudioModule {
  constructor() {
    super('ChannelUpmixer');
    this.enabled = false;
  }

  setupNodes(audioContext) {
    super.setupNodes(audioContext);
    this.getInputNode().connect(this.getOutputNode());
    this.mixerNode = null;
    this.enabled = false;
  }

  updateChannelCount(inputChannelCount, outputChannelCount) {
    if (!this.audioContext) {
      return;
    }

    const shouldEnable = inputChannelCount < outputChannelCount;
    if (!shouldEnable) {
      this.disable();
      return;
    }

    if (!this.enabled) {
      this.enable(outputChannelCount);
      return;
    }

    if (this.outputChannelCount !== outputChannelCount) {
      // Kept, as enable() keeps it: it was never updated, so each call set the count
      // again, and a count the node refused threw out of the whole channel update.
      this.outputChannelCount = outputChannelCount;
      try {
        this.mixerNode.channelCount = outputChannelCount;
      } catch (e) {
        console.warn('Could not set channel count on upmixer', e);
      }
    }
  }

  enable(channelCount = 2) {
    if (this.enabled || !this.audioContext) {
      return;
    }

    this.outputChannelCount = channelCount;
    this.mixerNode = this.audioContext.createGain();
    this.mixerNode.gain.value = 1;
    this.mixerNode.channelCountMode = 'explicit';
    try {
      this.mixerNode.channelCount = channelCount;
    } catch (e) {
      console.warn('Could not set channel count on upmixer', e);
    }


    this.getInputNode().disconnect(this.getOutputNode());
    this.getInputNode().connect(this.mixerNode);
    this.getOutputNode().connectFrom(this.mixerNode);

    this.enabled = true;
  }

  disable() {
    if (!this.enabled) {
      return;
    }

    this.getInputNode().disconnect(this.mixerNode);
    this.getOutputNode().disconnectFrom(this.mixerNode);
    this.getInputNode().connect(this.getOutputNode());
    this.mixerNode = null;
    this.enabled = false;
  }
}
