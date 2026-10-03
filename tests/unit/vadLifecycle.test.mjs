import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The voice detector (VAD) behind the fine-time timeline and the subtitle syncer. Its
// model takes ~100-150 ms to load, and a stop and a new start in that time (closing and
// reopening the syncer) used to leave two detectors running for good; a failed start
// stayed failed; the ONNX session was never released, so each video and each start kept
// another model in wasm memory; a failed background analyzer could never retry its
// source; the first ~20 ms of audio were written to vadBuffer[-1]; and a background
// analyzer player (8x playback, downloads, its own audio context) could be left running
// with nothing able to stop it, when a stop and a new start came while one loaded.

const newVad = vi.fn();

vi.mock('../../chrome/player/modules/vad/vad.mjs', () => ({
  VadJS: {AudioNodeVAD: {new: (...args) => newVad(...args)}},
}));

const {AudioAnalyzerNode} = await import('../../chrome/player/modules/analyzer/AudioAnalyzerNode.mjs');
const {AudioAnalyzer} = await import('../../chrome/player/modules/analyzer/AudioAnalyzer.mjs');

/**
 * A promise with its resolve and reject, to finish loads in a chosen order.
 * @return {{promise: Promise, resolve: Function, reject: Function}}
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

const vadNode = (name) => ({
  name,
  node: {name},
  getNode() {
    return this.node;
  },
  start: vi.fn(),
  destroy: vi.fn(),
});

/**
 * An analyzer node attached to a stand-in audio graph.
 * @return {{analyzer: AudioAnalyzerNode, source: Object}}
 */
function attached() {
  const analyzer = new AudioAnalyzerNode();
  const source = {connect: vi.fn(), disconnect: vi.fn()};
  analyzer.attach({playbackRate: 1}, source, {}, () => 0);
  return {analyzer, source};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AudioAnalyzerNode: starting and stopping the voice detector', () => {
  let errors;

  beforeEach(() => {
    newVad.mockReset();
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errors.mockRestore();
  });

  it('runs one detector after a stop and a new start while the first was loading', async () => {
    const {analyzer, source} = attached();
    const first = deferred();
    const second = deferred();
    const one = vadNode('one');
    const two = vadNode('two');
    newVad.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const start1 = analyzer.startRecordingVad();
    await settle();
    analyzer.stopRecordingVad();
    const start2 = analyzer.startRecordingVad();
    await settle();
    first.resolve(one);
    second.resolve(two);
    await Promise.all([start1, start2]);

    expect(newVad).toHaveBeenCalledTimes(2);
    expect(source.connect).toHaveBeenCalledTimes(1);
    expect(source.connect).toHaveBeenCalledWith(one.node);
    expect(one.start).toHaveBeenCalledTimes(1);
    expect(two.start).not.toHaveBeenCalled();
    expect(two.destroy).toHaveBeenCalledTimes(1);

    // And a stop now stops the one that runs.
    analyzer.stopRecordingVad();
    expect(one.destroy).toHaveBeenCalledTimes(1);
    expect(source.disconnect).toHaveBeenCalledWith(one.node);
    expect(analyzer.vadNode).toBeNull();
  });

  it('runs nothing when stopped before its load finished', async () => {
    const {analyzer, source} = attached();
    const load = deferred();
    const one = vadNode('one');
    newVad.mockReturnValueOnce(load.promise);

    const start = analyzer.startRecordingVad();
    await settle();
    analyzer.stopRecordingVad();
    load.resolve(one);
    await start;

    expect(source.connect).not.toHaveBeenCalled();
    expect(one.destroy).toHaveBeenCalledTimes(1);
    expect(analyzer.vadNode).toBeNull();
  });

  it('can be started again after a start that failed', async () => {
    const {analyzer, source} = attached();
    const one = vadNode('one');
    newVad.mockRejectedValueOnce(new Error('the model did not load')).mockResolvedValueOnce(one);

    await expect(analyzer.startRecordingVad()).resolves.toBeUndefined();
    expect(analyzer.vadShouldRun).toBe(false);
    expect(errors).toHaveBeenCalled();

    await analyzer.startRecordingVad();
    expect(newVad).toHaveBeenCalledTimes(2);
    expect(source.connect).toHaveBeenCalledWith(one.node);
    expect(one.start).toHaveBeenCalledTimes(1);
  });

  it('keeps a newer start when an older load fails after it', async () => {
    const {analyzer, source} = attached();
    const first = deferred();
    const two = vadNode('two');
    newVad.mockReturnValueOnce(first.promise).mockResolvedValueOnce(two);

    const start1 = analyzer.startRecordingVad();
    await settle();
    analyzer.stopRecordingVad();
    await analyzer.startRecordingVad();
    first.reject(new Error('slow and broken'));
    await start1;

    expect(analyzer.vadShouldRun).toBe(true);
    expect(analyzer.vadNode).toBe(two);
    expect(source.connect).toHaveBeenCalledWith(two.node);
  });

  it('keeps a newer start still loading when an older load fails first', async () => {
    const {analyzer, source} = attached();
    const first = deferred();
    const second = deferred();
    const two = vadNode('two');
    newVad.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const start1 = analyzer.startRecordingVad();
    await settle();
    analyzer.stopRecordingVad();
    const start2 = analyzer.startRecordingVad();
    await settle();
    first.reject(new Error('slow and broken'));
    await start1;
    second.resolve(two);
    await start2;

    expect(analyzer.vadShouldRun).toBe(true);
    expect(analyzer.vadNode).toBe(two);
    expect(source.connect).toHaveBeenCalledWith(two.node);
    expect(two.destroy).not.toHaveBeenCalled();
  });
});

describe('AudioAnalyzer', () => {
  const client = () => ({
    player: {getSource: () => 'source-1'},
    interfaceController: {updateMarkers: vi.fn()},
    playerLoader: {createPlayer: vi.fn()},
  });

  it('writes no voice-detector frame before 0', () => {
    const analyzer = new AudioAnalyzer(client());
    const seen = [];
    analyzer.on('vad', (time, prob) => seen.push([time, prob]));

    analyzer.onVadFrameProcessed(-0.02, 200);
    analyzer.onVadFrameProcessed(0.25, 100);

    expect(Object.keys(analyzer.getVadData())).toEqual(['2']);
    expect(analyzer.getVadData()[2]).toBe(100);
    // The event still goes out for both.
    expect(seen).toEqual([[-0.02, 200], [0.25, 100]]);
  });

  /**
   * An analyzer whose background players load when the test says so. Each player's
   * destroy() reports its end, as a running analyzer player does.
   * @param {Object} c - The client.
   * @return {{analyzer: AudioAnalyzer, loads: Array}}
   */
  function withLoads(c) {
    const analyzer = new AudioAnalyzer(c);
    const loads = [];
    analyzer.loadPlayer = (source, doneRanges, onDone) => {
      const load = deferred();
      const player = {
        source,
        destroy: vi.fn(() => onDone(false)),
      };
      loads.push({player, finish: () => load.resolve(player), fail: (e) => load.reject(e)});
      return load.promise;
    };
    return {analyzer, loads};
  }

  it('keeps one background player when it is stopped and started again for the same video while loading', async () => {
    const c = client();
    const {analyzer, loads} = withLoads(c);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const startA = analyzer.startBackgroundAnalyzer();
      analyzer.stopBackgroundAnalyzer();
      const startB = analyzer.startBackgroundAnalyzer();
      expect(loads).toHaveLength(2);
      loads[0].finish();
      loads[1].finish();
      await Promise.all([startA, startB]);

      const [a, b] = loads.map((load) => load.player);
      expect(a.destroy).toHaveBeenCalledTimes(1);
      expect(analyzer.backgroundAnalyzerPlayer).toBe(b);
      expect(b.destroy).not.toHaveBeenCalled();

      // And a stop stops the one that runs.
      analyzer.stopBackgroundAnalyzer();
      expect(b.destroy).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps the new video\'s background player when the old video\'s finishes loading after it', async () => {
    const c = client();
    const {analyzer, loads} = withLoads(c);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const startA = analyzer.startBackgroundAnalyzer();
      analyzer.reset();
      c.player.getSource = () => 'source-2';
      const startB = analyzer.startBackgroundAnalyzer();
      loads[1].finish();
      await startB;
      loads[0].finish();
      await startA;

      const [a, b] = loads.map((load) => load.player);
      expect(a.destroy).toHaveBeenCalledTimes(1);
      // The old player's end did not clear the new one's place.
      expect(analyzer.backgroundAnalyzerPlayer).toBe(b);
      analyzer.stopBackgroundAnalyzer();
      expect(b.destroy).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps a newer start for the same video when an older load fails after it', async () => {
    const c = client();
    const {analyzer, loads} = withLoads(c);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const startA = analyzer.startBackgroundAnalyzer();
      analyzer.stopBackgroundAnalyzer();
      const startB = analyzer.startBackgroundAnalyzer();
      loads[0].fail(new Error('no audio'));
      await startA;
      loads[1].finish();
      await startB;

      const b = loads[1].player;
      expect(b.destroy).not.toHaveBeenCalled();
      expect(analyzer.backgroundAnalyzerPlayer).toBe(b);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('tries the background analyzer again after a failed start, and destroys the failed player', async () => {
    const c = client();
    const analyzer = new AudioAnalyzer(c);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const broken = {setup: vi.fn(async () => {
      throw new Error('no audio');
    }), destroy: vi.fn()};
    c.playerLoader.createPlayer.mockResolvedValueOnce(broken).mockResolvedValueOnce(broken);
    try {
      await expect(analyzer.startBackgroundAnalyzer()).resolves.toBeUndefined();
      expect(broken.destroy).toHaveBeenCalledTimes(1);
      await analyzer.startBackgroundAnalyzer();
      expect(c.playerLoader.createPlayer).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
