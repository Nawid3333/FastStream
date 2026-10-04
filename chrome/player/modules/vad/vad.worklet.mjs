const Message = {
  AudioFrame: 1,
};

// The resampler's low-pass: a Blackman-windowed sinc reaching this many target samples to
// each side, stored for this many fractional positions between two input samples.
const FILTER_SPAN = 16;
const FILTER_PHASES = 32;
// Where the low-pass falls to half, as a share of the target's Nyquist frequency.
const FILTER_CUTOFF = 0.9;
// The input samples kept: the filter's reach and a block of 128, with plenty to spare.
const RING_SIZE = 4096;

/**
 * Brings the audio thread's 128-sample blocks to the model's 16 kHz, in frames of
 * targetFrameSize. Each output sample is the input around its position through a low-pass,
 * so what lies above 8 kHz does not fold back into the band the model listens to.
 *
 * It averaged each output's span of input samples instead (a box filter): a 12 kHz tone
 * at 48 kHz came out as a 4 kHz one at a third of its level. And it kept its input in an
 * Array it pushed every sample onto and sliced for every frame, garbage the audio thread
 * had to collect.
 */
class Resampler {
  constructor(options) {
    this.options = options;
    if (options.nativeSampleRate < 16000) {
      console.error('nativeSampleRate is too low. Should have 16000 = targetSampleRate <= nativeSampleRate');
    }
    // Input samples per output sample.
    this.ratio = options.nativeSampleRate / options.targetSampleRate;
    const step = Math.max(1, this.ratio);
    this.halfWidth = Math.ceil(FILTER_SPAN * step);
    this.kernels = Resampler.makeKernels(this.halfWidth, FILTER_CUTOFF * 0.5 / step);
    this.ring = new Float32Array(RING_SIZE);
    // Input samples written, and output samples made, since the start.
    this.written = 0;
    this.made = 0;
    this.frame = new Float32Array(options.targetFrameSize);
    this.frameFill = 0;
  }

  /**
   * @param {number} halfWidth - Input samples to each side of an output's position.
   * @param {number} cutoff - Where the low-pass falls to half, in cycles per input sample.
   * @return {Float32Array[]} For each of FILTER_PHASES fractional positions, the weights of
   *   the 2 * halfWidth input samples around it, from the farthest before to the farthest
   *   after, adding up to 1.
   */
  static makeKernels(halfWidth, cutoff) {
    const kernels = [];
    for (let phase = 0; phase < FILTER_PHASES; phase++) {
      const fraction = phase / FILTER_PHASES;
      const kernel = new Float32Array(2 * halfWidth);
      let sum = 0;
      for (let j = 0; j < kernel.length; j++) {
        // Distance from the output's position to input sample (base - halfWidth + 1 + j).
        const x = j - halfWidth + 1 - fraction;
        const sinc = x === 0 ? 1 : Math.sin(2 * Math.PI * cutoff * x) / (2 * Math.PI * cutoff * x);
        const w = (x + halfWidth) / (2 * halfWidth);
        const taper = w <= 0 || w >= 1 ? 0 :
          0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w);
        kernel[j] = sinc * taper;
        sum += kernel[j];
      }
      for (let j = 0; j < kernel.length; j++) {
        kernel[j] /= sum;
      }
      kernels.push(kernel);
    }
    return kernels;
  }

  /**
   * @param {Float32Array} audioFrame - A block of input samples.
   * @return {Float32Array[]} The frames completed by it, often none.
   */
  process(audioFrame) {
    const mask = RING_SIZE - 1;
    for (let i = 0; i < audioFrame.length; i++) {
      this.ring[(this.written + i) & mask] = audioFrame[i];
    }
    this.written += audioFrame.length;

    const outputFrames = [];
    for (;;) {
      const position = this.made * this.ratio;
      let base = Math.floor(position);
      let phase = Math.round((position - base) * FILTER_PHASES);
      if (phase === FILTER_PHASES) {
        base++;
        phase = 0;
      }
      // The filter reaches halfWidth input samples past the position.
      if (base + this.halfWidth >= this.written) {
        break;
      }
      const kernel = this.kernels[phase];
      const first = base - this.halfWidth + 1;
      let value = 0;
      for (let j = 0; j < kernel.length; j++) {
        const index = first + j;
        // Before the first sample there is silence.
        if (index >= 0) {
          value += kernel[j] * this.ring[index & mask];
        }
      }
      this.made++;
      this.frame[this.frameFill++] = value;
      if (this.frameFill === this.frame.length) {
        outputFrames.push(this.frame);
        this.frame = new Float32Array(this.options.targetFrameSize);
        this.frameFill = 0;
      }
    }
    return outputFrames;
  }
}

class Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._initialized = false;
    this._closed = false;
    this.init = async () => {
      this.resampler = new Resampler({
        nativeSampleRate: sampleRate,
        targetSampleRate: 16000,
        targetFrameSize: this.options.frameSamples,
      });
      this._initialized = true;
    };

    this.port.onmessage = (event) => {
      if (event.data === 'close') {
        this.close();
      }
    };

    this.options = options.processorOptions;
    this.init();
  }
  process(inputs, outputs, parameters) {
    if (this._closed) {
      return false;
    }
    // @ts-ignore
    const arr = inputs[0][0];
    if (this._initialized && arr instanceof Float32Array) {
      const frames = this.resampler.process(arr);
      for (const frame of frames) {
        this.port.postMessage({message: Message.AudioFrame, data: frame.buffer}, [frame.buffer]);
      }
    }
    return true;
  }

  close() {
    this._closed = true;
  }
}

registerProcessor('vad-helper-worklet', Processor);
