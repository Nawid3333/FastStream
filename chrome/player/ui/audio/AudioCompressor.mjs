import {Localize} from '../../modules/Localize.mjs';
import {AudioUtils} from '../../utils/AudioUtils.mjs';
import {WebUtils} from '../../utils/WebUtils.mjs';
import {createKnob} from '../components/Knob.mjs';
import {AbstractAudioModule} from './AbstractAudioModule.mjs';

// The DynamicsCompressorNode's look-ahead in seconds: the pre-delay of Blink's
// DynamicsCompressor, which Firefox's node is built on.
const COMPRESSOR_PRE_DELAY = 0.006;

/**
 * A DelayNode that holds the sound back exactly as long as a compressor does: Firefox
 * rounds the look-ahead down to whole frames (288 at 48 kHz, 264 at 44.1 kHz).
 * @param {BaseAudioContext} audioContext
 * @return {DelayNode}
 */
function createLookAheadDelay(audioContext) {
  const delay = audioContext.createDelay(COMPRESSOR_PRE_DELAY * 2);
  delay.delayTime.value = Math.floor(COMPRESSOR_PRE_DELAY * audioContext.sampleRate) / audioContext.sampleRate;
  return delay;
}

/**
 * The channels each compressor takes, for a source of more than two channels, in Web
 * Audio's order (5.1: L R C LFE SL SR). A DynamicsCompressorNode takes two at most. A
 * pair of speakers shares one, so both sides are turned down together and the image stays
 * put; the centre and the LFE get one each, so a bass hit does not turn the dialogue down.
 * @param {number} count - The number of channels, 3 or more.
 * @return {number[][]}
 */
function compressorGroups(count) {
  const groups = [[0, 1]];
  let next = 2;
  // A centre in every layout but quad (L R SL SR); an LFE from 5.1 on.
  if (count !== 4) {
    groups.push([next++]);
  }
  if (count >= 6) {
    groups.push([next++]);
  }
  while (next < count) {
    groups.push(next + 1 < count ? [next, next + 1] : [next]);
    next += 2;
  }
  return groups;
}

export class AudioCompressor extends AbstractAudioModule {
  constructor(customTitlePrepend, numberOfChannelsGetter) {
    super('AudioCompressor');
    this.compressorNode = null;
    this.compressorGain = null;
    this.compressorConfig = null;
    this.customTitlePrepend = customTitlePrepend || '';
    this.renderCache = {};
    this.numberOfChannelsGetter = numberOfChannelsGetter;
    this.setupUI();
  }

  isEnabled() {
    return this.compressorConfig && this.compressorConfig.enabled;
  }

  getElement() {
    return this.ui.compressor;
  }

  setConfig(config) {
    this.compressorConfig = config;
    this.setupCompressorControls();
    this.updateCompressor();
    this.emit('upscale');
    this.emit('change');
  }

  setupUI() {
    this.ui = {};
    this.ui.compressor = WebUtils.create('div', null, 'compressor');

    this.ui.compressorTitle = WebUtils.create('div', null, 'compressor_title');
    this.ui.compressorTitle.textContent = this.customTitlePrepend + Localize.getMessage('audiocompressor_title');
    this.ui.compressor.appendChild(this.ui.compressorTitle);

    this.ui.compressorContainer = WebUtils.create('div', null, 'compressor_container');
    this.ui.compressor.appendChild(this.ui.compressorContainer);

    this.ui.compressorGraph = WebUtils.create('div', null, 'compressor_graph');
    this.ui.compressorContainer.appendChild(this.ui.compressorGraph);

    this.ui.compressorYAxis = WebUtils.create('div', null, 'compressor_y_axis');
    this.ui.compressorGraph.appendChild(this.ui.compressorYAxis);

    this.ui.compressorXAxis = WebUtils.create('div', null, 'compressor_x_axis');
    this.ui.compressorGraph.appendChild(this.ui.compressorXAxis);

    this.setupCompressorAxis();

    this.ui.compressorGraphContainer = WebUtils.create('div', null, 'compressor_graph_container');
    this.ui.compressorGraph.appendChild(this.ui.compressorGraphContainer);

    this.ui.compressorGraphCanvas = WebUtils.create('canvas', null, 'compressor_graph_canvas');
    this.ui.compressorGraphContainer.appendChild(this.ui.compressorGraphCanvas);

    this.ui.compressorGraphCtx = this.ui.compressorGraphCanvas.getContext('2d');

    this.ui.compressorControls = WebUtils.create('div', null, 'compressor_controls');
    this.ui.compressorContainer.appendChild(this.ui.compressorControls);

    this.setupCompressorControls();
  }

  setupCompressor() {
    this.ui.compressor.replaceChildren();
    this.updateCompressor();
  }

  async updateChannelCount() {
    const count = this.numberOfChannelsGetter ? await this.numberOfChannelsGetter() : 2;
    if (count && !this.compressorNode && this.compressorConfig?.enabled) {
      // A recount (each new video brings one) drops the count a build is waiting for, and
      // the build gave up: the compressor stayed off for the whole video.
      this.updateCompressor();
    } else if (count && this.compressorNode) {
      // Rebuilt through updateCompressor, which also sets the new nodes to the settings;
      // built alone, they had the defaults.
      if (count > 2 && (!this.splitterNode || this.splitterNode.numberOfOutputs !== count)) {
        this.destroyCompressorNodes();
        this.updateCompressor();
      } else if (count <= 2 && this.splitterNode) {
        this.destroyCompressorNodes();
        this.updateCompressor();
      }
    }
  }

  async updateCompressor() {
    if (!this.compressorConfig) return;

    const compressor = this.compressorConfig;
    this.ui.compressorToggle.textContent = compressor.enabled ? Localize.getMessage('audiocompressor_enabled') : Localize.getMessage('audiocompressor_disabled');
    this.ui.compressorToggle.classList.toggle('enabled', compressor.enabled);

    if (compressor.enabled) {
      await this.createCompressorNodes();
      // Every compressor, with the same settings.
      for (const stage of this.compressorStages || []) {
        stage.compressor.threshold.value = compressor.threshold;
        stage.compressor.knee.value = compressor.knee;
        stage.compressor.ratio.value = compressor.ratio;
        stage.compressor.attack.value = compressor.attack;
        stage.compressor.release.value = compressor.release;
        stage.gain.gain.value = compressor.gain;
      }
    } else {
      this.destroyCompressorNodes();
    }
  }

  async createCompressorNodes() {
    const numChannels = this.numberOfChannelsGetter ? await this.numberOfChannelsGetter() : 2;
    // Switched off while the count was on its way, it was built anyway and kept running.
    if (numChannels === 0 || this.compressorNode || !this.compressorConfig?.enabled) return;

    const audioContext = this.audioContext;
    this.removeBypassDelay();

    const shouldUseSplitterMerger = numChannels > 2;
    if (shouldUseSplitterMerger) {
      // A DynamicsCompressorNode takes two channels at most: one compressor per group of
      // channels (compressorGroups), all with the same settings. Only the front pair used to
      // be compressed, the other channels went around it. Every compressor delays by the
      // same look-ahead, so the channels stay in time.
      this.splitterNode = audioContext.createChannelSplitter(numChannels);
      this.mergerNode = audioContext.createChannelMerger(numChannels);
      this.compressorStages = compressorGroups(numChannels).map((channels) => {
        const stage = {
          compressor: audioContext.createDynamicsCompressor(),
          gain: audioContext.createGain(),
        };
        stage.compressor.connect(stage.gain);
        if (channels.length === 1) {
          this.splitterNode.connect(stage.compressor, channels[0], 0);
          stage.gain.connect(this.mergerNode, 0, channels[0]);
        } else {
          stage.merger = audioContext.createChannelMerger(2);
          stage.splitter = audioContext.createChannelSplitter(2);
          channels.forEach((channel, i) => {
            this.splitterNode.connect(stage.merger, channel, i);
            stage.splitter.connect(this.mergerNode, i, channel);
          });
          stage.merger.connect(stage.compressor);
          stage.gain.connect(stage.splitter);
        }
        return stage;
      });

      this.getInputNode().disconnect(this.getOutputNode());
      this.getInputNode().connect(this.splitterNode);
      this.getOutputNode().connectFrom(this.mergerNode);
    } else {
      const stage = {
        compressor: audioContext.createDynamicsCompressor(),
        gain: audioContext.createGain(),
      };
      stage.compressor.connect(stage.gain);
      this.compressorStages = [stage];

      this.getInputNode().disconnect(this.getOutputNode());
      this.getInputNode().connect(stage.compressor);
      this.getOutputNode().connectFrom(stage.gain);
    }
    // The front pair's: the graph shows its gain reduction.
    this.compressorNode = this.compressorStages[0].compressor;
    this.compressorGain = this.compressorStages[0].gain;
  }

  destroyCompressorNodes(skipDisconnect = false) {
    if (!this.compressorNode) return;

    if (!skipDisconnect) {
      if (this.splitterNode) {
        this.getInputNode().disconnect(this.splitterNode);
        this.getOutputNode().disconnectFrom(this.mergerNode);
        this.splitterNode.disconnect();
        for (const stage of this.compressorStages) {
          stage.merger?.disconnect();
          stage.compressor.disconnect();
          stage.gain.disconnect();
          stage.splitter?.disconnect();
        }
      } else {
        this.getInputNode().disconnect(this.compressorNode);
        this.getOutputNode().disconnectFrom(this.compressorGain);
        this.compressorNode.disconnect(this.compressorGain);
      }

      this.getInputNode().connect(this.getOutputNode());
    }

    this.splitterNode = null;
    this.mergerNode = null;
    this.compressorStages = null;
    this.compressorNode = null;
    this.compressorGain = null;

    if (!skipDisconnect) {
      this.updateBypassDelay();
    }
  }

  /**
   * Has the sound wait as long as the compressor would make it wait, while the compressor
   * is off: the mixer asks it of a channel whose compressor is off while another channel's
   * is on, or that channel reached the speakers 6 ms before the compressed ones.
   * @param {boolean} match - Whether to wait.
   */
  setLatencyMatch(match) {
    this.latencyMatch = match;
    this.updateBypassDelay();
  }

  updateBypassDelay() {
    if (!this.audioContext || !this.getInputNode()) return;
    const wanted = !!this.latencyMatch && !this.compressorNode;
    if (wanted && !this.bypassDelay) {
      this.bypassDelay = createLookAheadDelay(this.audioContext);
      this.getInputNode().disconnect(this.getOutputNode());
      this.getInputNode().connect(this.bypassDelay);
      this.getOutputNode().connectFrom(this.bypassDelay);
    } else if (!wanted) {
      this.removeBypassDelay();
    }
  }

  removeBypassDelay() {
    if (!this.bypassDelay) return;
    this.getInputNode().disconnect(this.bypassDelay);
    this.getOutputNode().disconnectFrom(this.bypassDelay);
    this.getInputNode().connect(this.getOutputNode());
    this.bypassDelay = null;
  }

  setupNodes(audioContext) {
    super.setupNodes(audioContext);
    this.getInputNode().connect(this.getOutputNode());
    this.destroyCompressorNodes(true);
    this.bypassDelay = null;
    this.updateBypassDelay();
    this.updateCompressor();
  }

  setupCompressorControls() {
    this.ui.compressorControls.replaceChildren();

    this.ui.compressorToggle = WebUtils.create('div', null, 'compressor_toggle');
    this.ui.compressorControls.appendChild(this.ui.compressorToggle);
    WebUtils.setupTabIndex(this.ui.compressorToggle);

    this.ui.compressorToggle.addEventListener('click', () => {
      // No config yet (setConfig comes with the audio profile): nothing to switch.
      if (!this.compressorConfig) return;
      this.compressorConfig.enabled = !this.compressorConfig.enabled;
      this.updateCompressor();
      this.emit('upscale');
      this.emit('change');
    });

    this.compressorKnobs = {};

    this.compressorKnobs.threshold = createKnob(Localize.getMessage('audiocompressor_threshold'), -80, 0, (val) => {
      if (this.compressorConfig && val !== this.compressorConfig.threshold) {
        this.compressorConfig.threshold = val;
        this.updateCompressor();
        this.emit('change');
      }
    }, 'dB');
    this.ui.compressorControls.appendChild(this.compressorKnobs.threshold.container);

    this.compressorKnobs.knee = createKnob(Localize.getMessage('audiocompressor_knee'), 0, 40, (val) => {
      if (this.compressorConfig && val !== this.compressorConfig.knee) {
        this.compressorConfig.knee = val;
        this.updateCompressor();
        this.emit('change');
      }
    }, 'dB');

    this.ui.compressorControls.appendChild(this.compressorKnobs.knee.container);

    this.compressorKnobs.ratio = createKnob(Localize.getMessage('audiocompressor_ratio'), 1, 20, (val) => {
      if (this.compressorConfig && val !== this.compressorConfig.ratio) {
        this.compressorConfig.ratio = val;
        this.updateCompressor();
        this.emit('change');
      }
    }, 'dB');
    this.ui.compressorControls.appendChild(this.compressorKnobs.ratio.container);

    this.compressorKnobs.attack = createKnob(Localize.getMessage('audiocompressor_attack'), 0, 1, (val) => {
      if (this.compressorConfig && val !== this.compressorConfig.attack) {
        this.compressorConfig.attack = val;
        this.updateCompressor();
        this.emit('change');
      }
    }, 's');
    this.ui.compressorControls.appendChild(this.compressorKnobs.attack.container);

    this.compressorKnobs.release = createKnob(Localize.getMessage('audiocompressor_release'), 0, 1, (val) => {
      if (this.compressorConfig && val !== this.compressorConfig.release) {
        this.compressorConfig.release = val;
        this.updateCompressor();
        this.emit('change');
      }
    }, 's');
    this.ui.compressorControls.appendChild(this.compressorKnobs.release.container);

    this.compressorKnobs.gain = createKnob(Localize.getMessage('audiocompressor_gain'), 0, 20, (val) => {
      if (this.compressorConfig && AudioUtils.dbToGain(val) !== this.compressorConfig.gain) {
        this.compressorConfig.gain = AudioUtils.dbToGain(val);
        this.updateCompressor();
        this.emit('change');
      }
    }, 'dB');
    this.ui.compressorControls.appendChild(this.compressorKnobs.gain.container);

    if (this.compressorConfig) {
      this.compressorKnobs.threshold.knob.val(this.compressorConfig.threshold);
      this.compressorKnobs.knee.knob.val(this.compressorConfig.knee);
      this.compressorKnobs.ratio.knob.val(this.compressorConfig.ratio);
      this.compressorKnobs.attack.knob.val(this.compressorConfig.attack);
      this.compressorKnobs.release.knob.val(this.compressorConfig.release);
      this.compressorKnobs.gain.knob.val(AudioUtils.gainToDB(this.compressorConfig.gain));
    }
  }
  setupCompressorAxis() {
    this.ui.compressorXAxis.replaceChildren();
    this.ui.compressorYAxis.replaceChildren();

    const maxDB = 0;
    const minDB = -80;

    for (let i = minDB; i <= maxDB; i += 10) {
      const tick = WebUtils.create('div', null, 'compressor_x_axis_tick');
      tick.style.left = `${(i - minDB) / (maxDB - minDB) * 100}%`;
      this.ui.compressorXAxis.appendChild(tick);

      if (i % 20 === 0) {
        const label = WebUtils.create('div', null, 'tick_label');
        label.textContent = `${i}`;
        tick.classList.add('major');
        tick.appendChild(label);
      } else {
        tick.classList.add('minor');
      }

      if (i === minDB || i === maxDB) {
        tick.classList.add('zero');
      }
    }

    for (let i = minDB; i <= maxDB; i += 10) {
      const tick = WebUtils.create('div', null, 'compressor_y_axis_tick');
      tick.style.top = `${(-i) / (maxDB - minDB) * 100}%`;
      this.ui.compressorYAxis.appendChild(tick);

      if (i % 20 === 0) {
        const label = WebUtils.create('div', null, 'tick_label');
        label.textContent = `${i}`;
        tick.classList.add('major');
        tick.appendChild(label);
      } else {
        tick.classList.add('minor');
      }

      if (i === minDB || i === maxDB) {
        tick.classList.add('zero');
      }
    }
  }

  getCompressorNewDBfromOldDB(db) {
    const compressor = this.compressorConfig;

    const threshold = compressor.threshold;
    const ratio = compressor.ratio;
    const slope = 1 / ratio;
    const knee = compressor.knee;

    if (db < threshold) { // no compression
      return db;
    } else if (db <= threshold + knee) { // soft knee
      const diff = db - threshold;
      return (slope - 1) * (diff * diff / 2) / knee + diff + threshold;
    } else { // hard knee
      const yOffset = (slope - 1) * (knee / 2) + knee + threshold;
      return slope * (db - threshold - knee) + yOffset;
    }
  }

  render() {
    if (!this.compressorConfig) return;

    const width = this.ui.compressorGraphCanvas.clientWidth * window.devicePixelRatio;
    const height = this.ui.compressorGraphCanvas.clientHeight * window.devicePixelRatio;

    if (width === 0 || height === 0) return;
    const ctx = this.ui.compressorGraphCtx;


    // draw line
    const minDB = -80;
    const maxDB = 0;
    const rangeDB = maxDB - minDB;


    const reduction = this.compressorNode ? this.compressorNode.reduction : 0;
    const threshold = this.compressorConfig.threshold;
    const knee = this.compressorConfig.knee;
    const ratio = this.compressorConfig.ratio;

    if (
      this.renderCache.width === width &&
      this.renderCache.height === height &&
      this.renderCache.reduction === reduction &&
      this.renderCache.threshold === threshold &&
      this.renderCache.knee === knee &&
      this.renderCache.ratio === ratio
    ) {
      return;
    }

    if (this.renderCache.width !== width || this.renderCache.height !== height) {
      this.ui.compressorGraphCanvas.width = width;
      this.ui.compressorGraphCanvas.height = height;
    }

    this.renderCache.width = width;
    this.renderCache.height = height;
    this.renderCache.reduction = reduction;
    this.renderCache.threshold = threshold;
    this.renderCache.knee = knee;
    this.renderCache.ratio = ratio;

    ctx.clearRect(0, 0, width, height);

    ctx.beginPath();
    ctx.strokeStyle = 'green';
    ctx.lineWidth = 2;
    // Draw response line
    for (let x = 0; x < width; x++) {
      const db = minDB + rangeDB * x / width;
      const newDB = this.getCompressorNewDBfromOldDB(db);

      const y = height - (newDB - minDB) * height / rangeDB;

      if (x === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // draw threshold line
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(230, 0, 0, 0.7)';
    ctx.lineWidth = 1;
    const x = (threshold - minDB) * width / rangeDB;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();

    // draw knee line
    if (knee > 0) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(0, 200, 255, 0.7)';
      ctx.lineWidth = 1;
      const x2 = (threshold + knee - minDB) * width / rangeDB;
      ctx.moveTo(x2, 0);
      ctx.lineTo(x2, height);
      ctx.stroke();
    }

    if (reduction !== 0) {
      // reduction line
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(0, 200, 0, 0.7)';
      ctx.lineWidth = 1;
      const y = height - (reduction - minDB) * height / rangeDB;
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }
}
