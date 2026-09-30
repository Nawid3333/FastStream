import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// vad.mjs's model on a stand-in ONNX Runtime, handed to createModel: the real one is copied
// in by the build, which CI runs after the unit tests. The session keeps the model in wasm
// memory until it is released, and every video and every start of the voice detector
// loads a new one; nothing released it. A failed model download went on to parse the
// error page as a model.

const sessions = [];

const ort = {
  Tensor: class {
    constructor(type, data, dims) {
      Object.assign(this, {type, data, dims});
    }
  },
  InferenceSession: {
    create: async () => {
      const session = {
        run: vi.fn(async () => ({stateN: {}, output: {data: [0.75]}})),
        release: vi.fn(async () => {}),
      };
      sessions.push(session);
      return session;
    },
  },
};

const {VadJS} = await import('../../chrome/player/modules/vad/vad.mjs');

describe('the voice detector model', () => {
  beforeEach(() => {
    sessions.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8)})));
    vi.stubGlobal('AudioWorkletNode', class {
      constructor() {
        this.port = {postMessage: vi.fn(), onmessage: null};
      }
    });
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('releases its ONNX session when the detector is destroyed', async () => {
    const vad = await VadJS.AudioNodeVAD.new({audioWorklet: {addModule: async () => {}}}, {ort});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].release).not.toHaveBeenCalled();

    vad.destroy();
    await vi.waitFor(() => expect(sessions[0].release).toHaveBeenCalledTimes(1));
  });

  it('scores nothing on a released session, instead of throwing', async () => {
    const model = await VadJS.createModel(ort);
    expect((await model.process(new Float32Array(512))).isSpeech).toBe(0.75);
    await model.release();
    expect(await model.process(new Float32Array(512))).toEqual({notSpeech: 1, isSpeech: 0});
    expect(sessions[0].run).toHaveBeenCalledTimes(1);
  });

  it('waits for a run in progress before releasing', async () => {
    const model = await VadJS.createModel(ort);
    let finish;
    sessions[0].run.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({stateN: {}, output: {data: [0.5]}});
    }));
    const running = model.process(new Float32Array(512));
    const releasing = model.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sessions[0].release).not.toHaveBeenCalled();
    finish();
    await running;
    await releasing;
    expect(sessions[0].release).toHaveBeenCalledTimes(1);
  });

  it('fails with a clear error when the model does not download', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0)})));
    await expect(VadJS.createModel(ort)).rejects.toThrow(/model did not load \(404\)/);
    expect(sessions).toHaveLength(0);
  });
});
