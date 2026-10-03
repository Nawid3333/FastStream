const currentScript = import.meta;
let basePath = '';
if (currentScript) {
  basePath = currentScript.url
      .replace(/#.*$/, '')
      .replace(/\?.*$/, '')
      .replace(/\/[^\/]+$/, '/');
}

const assetPath = (file) => {
  return basePath + file;
};

// ONNX Runtime, loaded with the first model. The unit tests hand createModel a stand-in:
// the real file is copied in by the build, which runs after them.
let ortModule = null;
const loadOrt = () => {
  ortModule ??= import('./ort.wasm.mjs').then((module) => module.default);
  return ortModule;
};

const modelFetcher = async () => {
  const modelURL = assetPath('silero_vad_half.onnx');
  const response = await fetch(modelURL);
  if (!response.ok) {
    throw new Error(`The voice detector's model did not load (${response.status})`);
  }
  return await response.arrayBuffer();
};

const defaultFrameProcessorOptions = {
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.5 - 0.15,
  preSpeechPadFrames: 1,
  redemptionFrames: 8,
  frameSamples: 512,
  minSpeechFrames: 3,
};
const defaultRealTimeVADOptions = {
  ...defaultFrameProcessorOptions,
  onFrameProcessed: (probabilities) => { },
  onVADMisfire: () => {

  },
  onSpeechStart: () => {

  },
  onSpeechEnd: () => {

  },
  stream: undefined,
};
const Message = {
  AudioFrame: 1,
  SpeechStart: 2,
  VADMisfire: 3,
  SpeechEnd: 4,
};

// Silero v5 and v6 score each 512-sample frame against the last 64 samples of the frame
// before it, as silero-vad's own OnnxWrapper.__call__ does (ricky0123/vad aa048997, "Give
// Silero v5 its context window"). Fed the bare frame, the model saw every frame as the first
// of an utterance: it scored quiet and starting speech too low.
const CONTEXT_SAMPLES = 64;

class Silero {
  static async new(ort, modelFetcher) {
    const model = new Silero(ort, modelFetcher);
    await model.init();
    return model;
  }
  constructor(ort, modelFetcher) {
    this.ort = ort;
    this.modelFetcher = modelFetcher;
    this.context = new Float32Array(CONTEXT_SAMPLES);
    this.init = async () => {
      console.debug('initializing vad');
      const modelArrayBuffer = await this.modelFetcher();
      this._session = await ort.InferenceSession.create(modelArrayBuffer);
      this._sr = new this.ort.Tensor('int64', [16000n]);
      this.reset_state();
      console.debug('vad is initialized');
    };
    // ONNX Runtime keeps the model in wasm memory until its session is released, and
    // every video and every VAD start loads a new one. Waits for a run in progress.
    this.release = async () => {
      const session = this._session;
      this._session = null;
      if (session) {
        await this.running?.catch(() => {});
        await session.release();
      }
    };
    this.reset_state = () => {
      const zeroes = Array(2 * 1 * 128).fill(0);
      this.state = new this.ort.Tensor('float32', zeroes, [2, 1, 128]);
      this.context = new Float32Array(CONTEXT_SAMPLES);
    };
    this.process = async (audioFrame) => {
      const withContext = new Float32Array(CONTEXT_SAMPLES + audioFrame.length);
      withContext.set(this.context, 0);
      withContext.set(audioFrame, CONTEXT_SAMPLES);
      // A copy: the caller may reuse its frame.
      this.context = audioFrame.slice(-CONTEXT_SAMPLES);
      const t = new this.ort.Tensor('float32', withContext, [1, withContext.length]);
      const inputs = {
        input: t,
        state: this.state,
        //   sr: this._sr,
      };
      if (!this._session) {
        return {notSpeech: 1, isSpeech: 0};
      }
      this.running = this._session.run(inputs);
      const out = await this.running;
      this.state = out.stateN;
      const [isSpeech] = out.output.data;
      const notSpeech = 1 - isSpeech;
      return {notSpeech, isSpeech};
    };
  }
}

const concatArrays = (arrays) => {
  const sizes = arrays.reduce((out, next) => {
    out.push(out.at(-1) + next.length);
    return out;
  }, [0]);
  const outArray = new Float32Array(sizes.at(-1));
  arrays.forEach((arr, index) => {
    const place = sizes[index];
    outArray.set(arr, place);
  });
  return outArray;
};

class FrameProcessor {
  constructor(modelProcessFunc, modelResetFunc, options) {
    this.modelProcessFunc = modelProcessFunc;
    this.modelResetFunc = modelResetFunc;
    this.options = options;
    this.speaking = false;
    this.redemptionCounter = 0;
    this.active = false;
    this.reset = () => {
      this.speaking = false;
      this.audioBuffer = [];
      this.modelResetFunc();
      this.redemptionCounter = 0;
    };
    this.pause = () => {
      this.active = false;
      this.reset();
    };
    this.resume = () => {
      this.active = true;
    };
    this.endSegment = () => {
      const audioBuffer = this.audioBuffer;
      this.audioBuffer = [];
      const speaking = this.speaking;
      this.reset();
      const speechFrameCount = audioBuffer.reduce((acc, item) => {
        return acc + +item.isSpeech;
      }, 0);
      if (speaking) {
        if (speechFrameCount >= this.options.minSpeechFrames) {
          const audio = concatArrays(audioBuffer.map((item) => item.frame));
          return {msg: Message.SpeechEnd, audio};
        } else {
          return {msg: Message.VADMisfire};
        }
      }
      return {};
    };
    this.process = async (frame) => {
      if (!this.active) {
        return {};
      }
      const probs = await this.modelProcessFunc(frame);
      this.audioBuffer.push({
        frame,
        isSpeech: probs.isSpeech >= this.options.positiveSpeechThreshold,
      });
      if (probs.isSpeech >= this.options.positiveSpeechThreshold &&
                this.redemptionCounter) {
        this.redemptionCounter = 0;
      }
      if (probs.isSpeech >= this.options.positiveSpeechThreshold &&
                !this.speaking) {
        this.speaking = true;
        return {probs, msg: Message.SpeechStart};
      }
      if (probs.isSpeech < this.options.negativeSpeechThreshold &&
                this.speaking &&
                ++this.redemptionCounter >= this.options.redemptionFrames) {
        this.redemptionCounter = 0;
        this.speaking = false;
        const audioBuffer = this.audioBuffer;
        this.audioBuffer = [];
        const speechFrameCount = audioBuffer.reduce((acc, item) => {
          return acc + +item.isSpeech;
        }, 0);
        if (speechFrameCount >= this.options.minSpeechFrames) {
          const audio = concatArrays(audioBuffer.map((item) => item.frame));
          return {probs, msg: Message.SpeechEnd, audio};
        } else {
          return {probs, msg: Message.VADMisfire};
        }
      }
      if (!this.speaking) {
        while (this.audioBuffer.length > this.options.preSpeechPadFrames) {
          this.audioBuffer.shift();
        }
      }
      return {probs};
    };
    this.audioBuffer = [];
    this.reset();
  }
}
class AudioNodeVAD {
  static async new(ctx, options = {}) {
    const vad = new AudioNodeVAD(ctx, {
      ...defaultRealTimeVADOptions,
      ...options,
    });
    await vad.init();
    return vad;
  }
  constructor(ctx, options) {
    this.ctx = ctx;
    this.options = options;
  }


  async init() {
    await this.ctx.audioWorklet.addModule(assetPath('vad.worklet.mjs'));
    // The model before the node: a model that did not load (a missing file, ONNX Runtime
    // not starting) left behind a node whose processor ran for the rest of the context.
    const model = await createModel(this.options.ort);
    let vadNode;
    try {
      vadNode = new AudioWorkletNode(this.ctx, 'vad-helper-worklet', {
        processorOptions: {
          frameSamples: this.options.frameSamples,
        },
        // One channel, mixed down by Web Audio (for 5.1: 0.707 (L + R) + C + 0.5 (SL + SR)):
        // the processor reads the first channel only, which was the left one, so the
        // dialogue in a 5.1 film's centre channel went unheard.
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
    } catch (e) {
      model.release().catch(() => {});
      throw e;
    }
    this.entryNode = vadNode;
    this.model = model;
    this.frameProcessor = new FrameProcessor(model.process, model.reset_state, {
      frameSamples: this.options.frameSamples,
      positiveSpeechThreshold: this.options.positiveSpeechThreshold,
      negativeSpeechThreshold: this.options.negativeSpeechThreshold,
      redemptionFrames: this.options.redemptionFrames,
      preSpeechPadFrames: this.options.preSpeechPadFrames,
      minSpeechFrames: this.options.minSpeechFrames,
    });
    vadNode.port.onmessage = async (ev) => {
      switch (ev.data?.message) {
        case Message.AudioFrame:
          const buffer = ev.data.data;
          const frame = new Float32Array(buffer);
          await this.processFrame(frame);
          break;
        default:
          break;
      }
    };
  }

  getNode() {
    return this.entryNode;
  }

  pause() {
    this.frameProcessor.pause();
  };

  start() {
    this.frameProcessor.resume();
  };

  destroy() {
    console.debug('destroying vad');
    this.entryNode.port.postMessage('close');
    this.frameProcessor.pause();
    this.entryNode = null;
    if (this.model) {
      this.model.release().catch((e) => console.warn('The voice detector model was not released', e));
      this.model = null;
    }
  }


  async processFrame(frame) {
    const {probs, msg, audio} = await this.frameProcessor.process(frame);
    if (probs !== undefined) {
      this.options.onFrameProcessed(probs);
    }
    switch (msg) {
      case Message.SpeechStart:
        this.options.onSpeechStart();
        break;
      case Message.VADMisfire:
        this.options.onVADMisfire();
        break;
      case Message.SpeechEnd:
        // @ts-ignore
        this.options.onSpeechEnd(audio);
        break;
      default:
        break;
    }
  }
}


/**
 * Loads the model on ONNX Runtime, as AudioNodeVAD does. Also the entry point
 * tests/e2e/ext-specs/vad.e2e.mjs drives, so the test runs the shipped path.
 *
 * @param {Object} [ort] - ONNX Runtime; the bundled one when not given (tests pass a stand-in).
 * @return {Promise<Silero>} a model whose process() scores 512-sample frames
 */
async function createModel(ort) {
  return Silero.new(ort || await loadOrt(), modelFetcher);
}

export const VadJS = {
  AudioNodeVAD,
  createModel,
};
