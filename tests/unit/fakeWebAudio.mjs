// A stand-in for the Web Audio graph, for the audio layer's unit tests (Node has no
// AudioContext). Each node records its connections in the context's edge list, so a test
// can follow the real signal path the VirtualAudioNodes expand into. An AudioParam's value,
// like the browser's (a WebIDL float), refuses NaN and Infinity with a TypeError.

/**
 * An AudioParam whose value refuses what the browser refuses.
 * @param {number} initial - The default value.
 * @return {{value: number}}
 */
export function fakeParam(initial) {
  let value = initial;
  return {
    get value() {
      return value;
    },
    set value(v) {
      if (!Number.isFinite(v)) {
        throw new TypeError('AudioParam.value: Value being assigned is not a finite floating-point value.');
      }
      value = v;
    },
  };
}

export class FakeNode {
  /**
   * @param {FakeAudioContext} context - The context it belongs to.
   * @param {string} kind - What it is ('gain', 'splitter', ...).
   * @param {Object} props - Its own properties (params, counts).
   */
  constructor(context, kind, props = {}) {
    this.context = context;
    this.kind = kind;
    this.channelCount = 2;
    this.channelCountMode = 'max';
    this.channelInterpretation = 'speakers';
    Object.assign(this, props);
  }

  connect(to, output, input) {
    this.context.edges.push({from: this, to, output: output ?? 0, input: input ?? 0});
    return to;
  }

  disconnect(to, output, input) {
    const edges = this.context.edges;
    const matches = (edge) => edge.from === this &&
      (to === undefined || edge.to === to) &&
      (output === undefined || edge.output === output) &&
      (input === undefined || edge.input === input);
    const before = edges.length;
    this.context.edges = edges.filter((edge) => !matches(edge));
    if (to !== undefined && this.context.edges.length === before) {
      throw new Error(`InvalidAccessError: ${this.kind} is not connected to ${to.kind}`);
    }
  }
}

export class FakeAudioContext {
  /**
   * @param {{sampleRate?: number, maxChannelCount?: number}} options
   */
  constructor({sampleRate = 48000, maxChannelCount = 2} = {}) {
    this.sampleRate = sampleRate;
    this.edges = [];
    this.nodes = [];
    this.destination = this.node('destination', {channelCount: 2, maxChannelCount});
  }

  node(kind, props) {
    const node = new FakeNode(this, kind, props);
    this.nodes.push(node);
    return node;
  }

  createGain() {
    return this.node('gain', {gain: fakeParam(1)});
  }

  createDelay(maxDelayTime = 1) {
    return this.node('delay', {delayTime: fakeParam(0), maxDelayTime});
  }

  createChannelSplitter(numberOfOutputs = 6) {
    return this.node('splitter', {numberOfOutputs});
  }

  createChannelMerger(numberOfInputs = 6) {
    return this.node('merger', {numberOfInputs});
  }

  createDynamicsCompressor() {
    return this.node('compressor', {
      threshold: fakeParam(-24), knee: fakeParam(30), ratio: fakeParam(12),
      attack: fakeParam(0.003), release: fakeParam(0.25), reduction: 0,
    });
  }

  createBiquadFilter() {
    const node = this.node('biquad', {frequency: fakeParam(350), gain: fakeParam(0), Q: fakeParam(1)});
    // An enum attribute: a value it does not know is ignored, as in the browser.
    let type = 'lowpass';
    Object.defineProperty(node, 'type', {
      get: () => type,
      set: (v) => {
        if (['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass'].includes(v)) {
          type = v;
        }
      },
    });
    return node;
  }

  createConvolver() {
    // Counts what restarts the convolution: each buffer it is given.
    const node = this.node('convolver', {normalize: true, bufferSets: 0});
    let buffer = null;
    Object.defineProperty(node, 'buffer', {
      get: () => buffer,
      set: (v) => {
        node.bufferSets++;
        buffer = v;
      },
    });
    return node;
  }

  createBuffer(numberOfChannels, length, sampleRate) {
    const channels = Array.from({length: numberOfChannels}, () => new Float32Array(length));
    return {
      numberOfChannels, length, sampleRate,
      getChannelData: (i) => channels[i],
      copyToChannel: (data, i) => channels[i].set(data.subarray(0, length)),
    };
  }

  /**
   * The edges into a node.
   * @param {FakeNode} node
   * @return {Array<{from: FakeNode, to: FakeNode, output: number, input: number}>}
   */
  inputsOf(node) {
    return this.edges.filter((edge) => edge.to === node);
  }

  /**
   * The edges out of a node.
   * @param {FakeNode} node
   * @return {Array<{from: FakeNode, to: FakeNode, output: number, input: number}>}
   */
  outputsOf(node) {
    return this.edges.filter((edge) => edge.from === node);
  }

  /**
   * How long a DynamicsCompressorNode holds the sound back, as Firefox's does: its 6 ms
   * pre-delay, rounded down to whole frames.
   * @return {number} seconds
   */
  get compressorLookAhead() {
    return Math.floor(0.006 * this.sampleRate) / this.sampleRate;
  }

  /**
   * Every path from one splitter's outputs to one merger's inputs, following a channel
   * through the mergers and splitters on the way.
   * @param {FakeNode} splitter
   * @param {FakeNode} merger
   * @return {Array<{from: number, to: number, delay: number, compressors: FakeNode[]}>}
   *   sorted by channel; `delay` adds up the DelayNodes and the compressors' look-ahead.
   */
  channelPaths(splitter, merger) {
    const found = [];
    const walk = (node, channel, delay, compressors, from) => {
      for (const edge of this.outputsOf(node)) {
        // A splitter passes one channel on each output.
        if (node !== splitter && node.kind === 'splitter' && channel !== null && edge.output !== channel) continue;
        const start = node === splitter ? edge.output : from;
        if (edge.to === merger) {
          found.push({from: start, to: edge.input, delay, compressors});
          continue;
        }
        const to = edge.to;
        let next = node.kind === 'splitter' ? null : channel;
        if (to.kind === 'merger') next = edge.input;
        const added = to.kind === 'delay' ? to.delayTime.value : to.kind === 'compressor' ? this.compressorLookAhead : 0;
        walk(to, next, delay + added, to.kind === 'compressor' ? [...compressors, to] : compressors, start);
      }
    };
    walk(splitter, null, 0, [], null);
    return found.sort((a, b) => a.from - b.from || a.to - b.to);
  }
}
