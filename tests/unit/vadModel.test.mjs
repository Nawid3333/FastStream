import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// vad.mjs's model on a stand-in ONNX Runtime, handed to createModel: the real one is copied
// in by the build, which CI runs after the unit tests. The session keeps the model in wasm
// memory until it is released, and every video and every start of the voice detector
// loads a new one; nothing released it. A failed model download went on to parse the
// error page as a model. The model was fed each frame without the previous frame's tail
// it was trained with; the worklet node took every channel of a 5.1 source and scored
// the left one only; and a model that did not load left a worklet node running.

const sessions = [];
const workletNodes = [];

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
    workletNodes.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8)})));
    vi.stubGlobal('AudioWorkletNode', class {
      constructor(context, name, options) {
        this.options = options;
        this.port = {postMessage: vi.fn(), onmessage: null};
        workletNodes.push(this);
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
    // A turn of the event loop: every promise step release() could take without the run
    // is done by then.
    await new Promise((resolve) => setImmediate(resolve));
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

  it('leaves no worklet node running when the model does not load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0)})));
    await expect(VadJS.AudioNodeVAD.new({audioWorklet: {addModule: async () => {}}}, {ort}))
        .rejects.toThrow(/model did not load/);
    // A node's processor runs until it is told to close.
    const running = workletNodes.filter((node) => !node.port.postMessage.mock.calls.some(([message]) => message === 'close'));
    expect(running).toHaveLength(0);
  });

  it('has Web Audio mix every channel down to the one channel it scores', async () => {
    await VadJS.AudioNodeVAD.new({audioWorklet: {addModule: async () => {}}}, {ort});
    expect(workletNodes).toHaveLength(1);
    expect(workletNodes[0].options).toMatchObject({
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
  });

  it('scores each frame with the last 64 samples of the frame before it in front', async () => {
    const model = await VadJS.createModel(ort);
    const frame = (start) => Float32Array.from({length: 512}, (_, i) => start + i);
    await model.process(frame(1000));
    await model.process(frame(2000));
    model.reset_state();
    await model.process(frame(3000));

    const inputs = sessions[0].run.mock.calls.map(([feeds]) => feeds.input);
    expect(inputs.map((input) => input.dims)).toEqual([[1, 576], [1, 576], [1, 576]]);
    // The first frame and the first after a reset have silence in front of them.
    expect(Array.from(inputs[0].data.subarray(0, 64))).toEqual(new Array(64).fill(0));
    expect(Array.from(inputs[0].data.subarray(64))).toEqual(Array.from(frame(1000)));
    expect(Array.from(inputs[1].data.subarray(0, 64))).toEqual(Array.from(frame(1000).subarray(448)));
    expect(Array.from(inputs[1].data.subarray(64))).toEqual(Array.from(frame(2000)));
    expect(Array.from(inputs[2].data.subarray(0, 64))).toEqual(new Array(64).fill(0));
  });
});
