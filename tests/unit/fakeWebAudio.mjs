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
}
