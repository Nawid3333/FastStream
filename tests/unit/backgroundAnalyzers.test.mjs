import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// PreviewFrameExtractor plays the video again in a hidden player: one that cannot load is cleaned
// up, not thrown.

const {PreviewFrameExtractor} = await import('../../chrome/player/modules/analyzer/PreviewFrameExtractor.mjs');
const {Fragment} = await import('../../chrome/player/players/Fragment.mjs');
const {DownloadStatus} = await import('../../chrome/player/enums/DownloadStatus.mjs');

/**
 * A background player whose source fails to load.
 * @return {Object}
 */
function failingPlayer() {
  const player = {
    destroyed: false,
    setup: vi.fn(async () => {}),
    setSource: vi.fn(async () => {
      throw new Error('manifest failed to load');
    }),
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(() => {
      player.destroyed = true;
    }),
  };
  return player;
}

/**
 * A ten-minute video, downloaded, playing in the main player.
 * @param {Object} player - What the player loader makes for the background.
 * @return {Object}
 */
function makeClient(player) {
  const fragments = [];
  for (let i = 0; i < 60; i++) {
    const fragment = new Fragment('0:0', i);
    fragment.start = i * 10;
    fragment.end = (i + 1) * 10;
    fragment.status = DownloadStatus.DOWNLOAD_COMPLETE;
    fragments.push(fragment);
  }
  const source = {mode: 'accelerated_hls', identifier: 'http://127.0.0.1/a.m3u8'};
  return {
    duration: 600,
    currentTime: 0,
    fragments,
    options: {downloadAll: false},
    player: {getVideo: () => ({videoWidth: 640, videoHeight: 360}), getSource: () => source},
    source,
    getCurrentVideoLevelID: () => '0:0',
    getCurrentAudioLevelID: () => null,
    playerLoader: {createPlayer: vi.fn(async () => player)},
    interfaceController: {updateMarkers: vi.fn()},
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('document', {createElement: () => ({getContext: () => ({})})});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


describe('PreviewFrameExtractor, a background player that fails to load', () => {
  it('fails quietly, with the half-built player destroyed', async () => {
    const player = failingPlayer();
    const client = makeClient(player);
    const extractor = new PreviewFrameExtractor(client);

    await expect(extractor.startBackgroundAnalyzer()).resolves.toBeUndefined();

    expect(player.destroyed).toBe(true);
    expect(extractor.backgroundAnalyzerPlayer).toBeFalsy();
    expect(extractor.getMarkerPosition()).toBe(null);
  });
});

// the retry after a failed load
describe('PreviewFrameExtractor after a load that failed', () => {
  it('tries again at the next start, as the audio analyzer does', async () => {
    // a failed load is retried, not final for the video
    const client = makeClient(failingPlayer());
    const extractor = new PreviewFrameExtractor(client);
    await extractor.startBackgroundAnalyzer();

    const running = {destroy: vi.fn()};
    extractor.loadPlayer = vi.fn(async () => running);
    await extractor.startBackgroundAnalyzer();
    expect(extractor.loadPlayer).toHaveBeenCalled();
    expect(extractor.backgroundAnalyzerPlayer).toBe(running);
  });

  it('keeps no player that ended before its load returned', async () => {
    // A player ended while its source was set is not kept as the running one.
    const client = makeClient(null);
    const extractor = new PreviewFrameExtractor(client);
    const dead = {destroy: vi.fn()};
    extractor.loadPlayer = vi.fn(async (source, ranges, onDone) => {
      onDone(false);
      return dead;
    });
    await extractor.startBackgroundAnalyzer();
    expect(extractor.backgroundAnalyzerPlayer).toBeFalsy();
    expect(extractor.backgroundAnalyzerStatus).not.toBe('running');
  });
});

describe('PreviewFrameExtractor, the tool closed and opened again while its player loads', () => {
  it('keeps only the second start\'s player, and destroys the first', async () => {
    // Both loads passed the source check, and the first player
    // went on seeking and downloading with the tool closed.
    const client = makeClient(null);
    const extractor = new PreviewFrameExtractor(client);
    const loads = [];
    extractor.loadPlayer = vi.fn((source, ranges, onDone) => new Promise((resolve) => loads.push({resolve, onDone})));

    const first = extractor.startBackgroundAnalyzer();
    extractor.stopBackgroundAnalyzer();
    const second = extractor.startBackgroundAnalyzer();
    const playerOne = {destroy: vi.fn()};
    const playerTwo = {destroy: vi.fn()};
    loads[1].resolve(playerTwo);
    await second;
    loads[0].resolve(playerOne);
    await first;

    expect(playerOne.destroy).toHaveBeenCalled();
    expect(playerTwo.destroy).not.toHaveBeenCalled();
    expect(extractor.backgroundAnalyzerPlayer).toBe(playerTwo);
  });
});

describe('a background analysis that failed', () => {
  it('runs again when its tool opens again, in both analyzers', async () => {
    const {AudioAnalyzer} = await import('../../chrome/player/modules/analyzer/AudioAnalyzer.mjs');
    for (const make of [(client) => new PreviewFrameExtractor(client), (client) => {
      const analyzer = Object.create(AudioAnalyzer.prototype);
      Object.assign(analyzer, {client, backgroundAnalyzerStatus: 'idle', backgroundAnalyzerSource: null,
        backgroundAnalyzerPlayer: null, backgroundStarts: 0, backgroundDoneRanges: []});
      return analyzer;
    }]) {
      const client = makeClient(null);
      const analyzer = make(client);
      let onDone;
      const player = {destroy: vi.fn()};
      analyzer.loadPlayer = vi.fn(async (source, ranges, done) => {
        onDone = done;
        return player;
      });
      await analyzer.startBackgroundAnalyzer();
      onDone(false);
      expect(analyzer.backgroundAnalyzerStatus).toBe('failed');
      analyzer.stopBackgroundAnalyzer();
      await analyzer.startBackgroundAnalyzer();
      expect(analyzer.loadPlayer).toHaveBeenCalledTimes(2);
    }
  });
});

describe('PreviewFrameExtractor, a stale background player', () => {
  it('leaves the running one in place when it ends', async () => {
    // A stale start destroyed after the newer one runs does not clear the newer one's place.
    const client = makeClient(null);
    let current = {mode: 'accelerated_hls', identifier: 'a'};
    client.player.getSource = () => current;
    const extractor = new PreviewFrameExtractor(client);
    const loads = [];
    extractor.loadPlayer = vi.fn((source, ranges, onDone) => new Promise((resolve) => loads.push({resolve, onDone})));
    const made = (load) => ({destroy: vi.fn(() => load.onDone(false))});

    const startA = extractor.startBackgroundAnalyzer();
    current = {mode: 'accelerated_hls', identifier: 'b'};
    const startB = extractor.startBackgroundAnalyzer();
    const playerB = made(loads[1]);
    loads[1].resolve(playerB);
    await startB;
    expect(extractor.backgroundAnalyzerPlayer).toBe(playerB);

    const playerA = made(loads[0]);
    loads[0].resolve(playerA);
    await startA;

    expect(playerA.destroy).toHaveBeenCalled();
    expect(extractor.backgroundAnalyzerPlayer).toBe(playerB);
  });
});

describe('PreviewFrameExtractor, taking the frames', () => {
  /**
   * The extractor's loop on a stand-in player whose seeks end when the test says: the video
   * shows the old place's picture until then, as a real one does.
   * @return {Object}
   */
  function harness() {
    const frames = [];
    const encodes = [];
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({drawImage: (source) => frames.push(source.picture)}),
      toBlob: (done) => encodes.push(done),
    };
    vi.stubGlobal('document', {createElement: () => canvas});
    vi.stubGlobal('URL', {createObjectURL: (blob) => 'blob:' + blob.picture, revokeObjectURL: () => {}});
    const loop = [];
    vi.stubGlobal('requestAnimationFrame', (callback) => loop.push(callback));
    const video = {videoWidth: 640, videoHeight: 360, seeking: false, picture: 0};
    let time = 0;
    const player = {
      get currentTime() {
        return time;
      },
      set currentTime(value) {
        time = value;
        video.seeking = true;
      },
      readyState: 4,
      duration: 600,
      getVideo: () => video,
      createContext: () => ({on: vi.fn(), destroy: vi.fn()}),
      destroy: vi.fn(),
    };
    const client = makeClient(player);
    client.isRegionBuffered = () => false;
    const extractor = new PreviewFrameExtractor(client);
    extractor.runAnalyzerInBackground(player, [], () => {});
    return {
      extractor,
      frames,
      encodes,
      nextFrame: () => loop.shift()(),
      seeked: () => {
        video.seeking = false;
        video.picture = time;
      },
      encode: () => encodes.shift()(Object.assign(new Blob(['png']), {picture: frames[0]})),
    };
  }

  it('takes a frame only once its seek has ended, never the picture before it', () => {
    // The next place is asked for once the seek ended, so the old picture is not kept as the new
    // one's.
    const run = harness();
    run.seeked();
    run.nextFrame();
    expect(run.frames).toEqual([0]);
    run.nextFrame(); // the seek to 2 s is still on its way
    expect(run.frames).toEqual([0]);
    run.seeked();
    run.nextFrame();
    expect(run.frames).toEqual([0, 2]);
  });

  it('keeps a frame once encoded, and none for a video reset meanwhile', () => {
    const run = harness();
    run.seeked();
    run.nextFrame();
    run.encode();
    expect(run.extractor.frameBuffer[0].url).toBe('blob:0');

    run.seeked();
    run.nextFrame();
    run.extractor.reset();
    run.encode();
    expect(run.extractor.frameBuffer).toEqual([]);
  });
});

describe('AudioAnalyzer, a background player destroyed before its metadata came', () => {
  // A stop or newer start while loading lets go of the audio context and volume loop at once.
  it('closes its audio context and stops its volume loop', async () => {
    const {AudioAnalyzer} = await import('../../chrome/player/modules/analyzer/AudioAnalyzer.mjs');
    const {DefaultPlayerEvents} = await import('../../chrome/player/enums/DefaultPlayerEvents.mjs');
    const {EventEmitter} = await import('../../chrome/player/modules/eventemitter.mjs');
    const contexts = [];
    vi.stubGlobal('AudioContext', class {
      constructor() {
        this.close = vi.fn(async () => {});
        contexts.push(this);
      }
      createMediaElementSource() {
        return {connect: vi.fn(), disconnect: vi.fn()};
      }
      createAnalyser() {
        return {};
      }
    });
    vi.useFakeTimers();
    try {
      const video = Object.assign(new EventTarget(), {readyState: 0, paused: true, playbackRate: 1, currentTime: 0});
      const player = Object.assign(new EventEmitter(), {
        setup: vi.fn(async () => {}),
        setSource: vi.fn(async () => {}),
        getVideo: () => video,
        destroy() {
          this.emit(DefaultPlayerEvents.DESTROYED);
        },
      });
      const client = makeClient(player);
      const analyzer = new AudioAnalyzer(client);
      await analyzer.setupPlayer(player, client.source, [], vi.fn());
      expect(vi.getTimerCount()).toBe(1);

      player.destroy();
      vi.advanceTimersByTime(1000);
      expect(contexts[0].close).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AudioAnalyzer, an audio track switched after the analysis finished', () => {
  // a track switch after the end analyses the new track
  it('drops the old track\'s volumes and analyses the new one', async () => {
    const {AudioAnalyzer} = await import('../../chrome/player/modules/analyzer/AudioAnalyzer.mjs');
    const client = makeClient(null);
    let audio = 'a1';
    client.getCurrentAudioLevelID = () => audio;
    const analyzer = new AudioAnalyzer(client);
    const loads = [];
    analyzer.loadPlayer = vi.fn(async (source, ranges, onDone) => {
      const player = {destroy: vi.fn()};
      loads.push({player, onDone});
      return player;
    });

    await analyzer.startBackgroundAnalyzer();
    loads[0].onDone(true);
    expect(analyzer.backgroundAnalyzerStatus).toBe('finished');
    analyzer.volumeBuffer[3] = -20;

    audio = 'a2';
    analyzer.setLevel('0:0', 'a2');
    expect(analyzer.volumeBuffer).toEqual([]);
    await analyzer.startBackgroundAnalyzer();
    expect(analyzer.loadPlayer).toHaveBeenCalledTimes(2);
  });

  // The switch keeps the main player's volume node (only a video's start makes it).
  it('keeps the main player\'s volume node', async () => {
    const {AudioAnalyzer} = await import('../../chrome/player/modules/analyzer/AudioAnalyzer.mjs');
    const client = makeClient(null);
    client.getCurrentAudioLevelID = () => 'a1';
    const analyzer = new AudioAnalyzer(client);
    const loads = [];
    analyzer.loadPlayer = vi.fn(async (source, ranges, onDone) => {
      loads.push({onDone});
      return {destroy: vi.fn()};
    });
    const main = {destroy: vi.fn(), configure: vi.fn()};
    analyzer.analyzerNodes.set('main', main);
    await analyzer.startBackgroundAnalyzer();
    loads[0].onDone(true);

    analyzer.setLevel('0:0', 'a2');
    expect(main.destroy).not.toHaveBeenCalled();
    expect(analyzer.analyzerNodes.get('main')).toBe(main);
    expect(analyzer.backgroundAnalyzerStatus).toBe('idle');
    analyzer.addVolumeDependent({});
    expect(main.configure).toHaveBeenCalledWith({volume: true});
  });

  it('keeps the volumes when only the video changed and the audio is its own track', async () => {
    const {AudioAnalyzer} = await import('../../chrome/player/modules/analyzer/AudioAnalyzer.mjs');
    const client = makeClient(null);
    client.getCurrentAudioLevelID = () => 'a1';
    const analyzer = new AudioAnalyzer(client);
    const loads = [];
    analyzer.loadPlayer = vi.fn(async (source, ranges, onDone) => {
      loads.push({onDone});
      return {destroy: vi.fn()};
    });
    await analyzer.startBackgroundAnalyzer();
    loads[0].onDone(true);
    analyzer.volumeBuffer[3] = -20;

    analyzer.setLevel('1:0', 'a1');
    expect(analyzer.volumeBuffer[3]).toBe(-20);
    expect(analyzer.backgroundAnalyzerStatus).toBe('finished');
  });
});

// The volume loop does not run while the sound is paused (the background analysis waits paused most
// of the time).
describe('AudioAnalyzerNode, its volume loop while the sound is paused', () => {
  it('wakes the page a few times a second while paused, and measures again at once on play', async () => {
    const {AudioAnalyzerNode} = await import('../../chrome/player/modules/analyzer/AudioAnalyzerNode.mjs');
    const {AudioUtils} = await import('../../chrome/player/utils/AudioUtils.mjs');
    vi.spyOn(AudioUtils, 'getVolume').mockReturnValue(-20);
    vi.useFakeTimers();
    try {
      const element = Object.assign(new EventTarget(), {paused: true, playbackRate: 8, readyState: 4, currentTime: 10});
      const node = new AudioAnalyzerNode();
      const volumes = [];
      node.on('volume', (time, volume) => volumes.push(volume));
      node.attach(element, {connect: vi.fn(), disconnect: vi.fn()}, {createAnalyser: () => ({})});
      const rounds = vi.spyOn(node, 'recordVolume');
      node.configure({volume: true});
      rounds.mockClear();

      vi.advanceTimersByTime(1000);
      expect(rounds.mock.calls.length).toBeLessThanOrEqual(4);
      expect(volumes).toEqual([]);

      element.paused = false;
      element.dispatchEvent(new Event('play'));
      expect(volumes).toEqual([-20]);
      vi.advanceTimersByTime(100);
      // Every 8 ms at 8x, as before.
      expect(volumes.length).toBeGreaterThanOrEqual(12);
      expect(vi.getTimerCount()).toBe(1);

      node.destroy();
      expect(vi.getTimerCount()).toBe(0);
      element.dispatchEvent(new Event('play'));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs one loop however often the measuring is switched off and on, or play comes', async () => {
    const {AudioAnalyzerNode} = await import('../../chrome/player/modules/analyzer/AudioAnalyzerNode.mjs');
    const {AudioUtils} = await import('../../chrome/player/utils/AudioUtils.mjs');
    vi.spyOn(AudioUtils, 'getVolume').mockReturnValue(-20);
    vi.useFakeTimers();
    try {
      const element = Object.assign(new EventTarget(), {paused: false, playbackRate: 1, readyState: 4, currentTime: 10});
      const node = new AudioAnalyzerNode();
      node.attach(element, {connect: vi.fn(), disconnect: vi.fn()}, {createAnalyser: () => ({})});
      node.configure({volume: true});
      node.configure({volume: false});
      node.configure({volume: true});
      element.dispatchEvent(new Event('play'));
      element.dispatchEvent(new Event('play'));
      expect(vi.getTimerCount()).toBe(1);
      const rounds = vi.spyOn(node, 'recordVolume');
      vi.advanceTimersByTime(640);
      expect(rounds.mock.calls.length).toBe(10);

      node.configure({volume: false});
      expect(vi.getTimerCount()).toBe(0);
      element.dispatchEvent(new Event('play'));
      expect(vi.getTimerCount()).toBe(0);
      node.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

// A video of 5 s or less counted as analysed at its first frame, and
// an analysis player's error left the analysis "running" for good.
describe('the background analyses: when one is done', () => {
  it('takes a short video as done only once nearly all of it is, a long one as before', async () => {
    const {coversVideo} = await import('../../chrome/player/modules/analyzer/BackgroundAnalysis.mjs');
    // At its first frame: nothing covered.
    expect(coversVideo({start: 0, end: 0}, 4)).toBe(false);
    expect(coversVideo({start: 0, end: 2}, 4)).toBe(false);
    expect(coversVideo({start: 0, end: 4}, 4)).toBe(true);
    // A long video: all but its last 5 s, as before.
    expect(coversVideo({start: 0, end: 594}, 600)).toBe(false);
    expect(coversVideo({start: 0, end: 595}, 600)).toBe(true);
    // A length not known yet is never covered.
    expect(coversVideo({start: 0, end: 100}, NaN)).toBe(false);
  });

  it('does not end a short video\'s frame extraction at its first frame', () => {
    const loop = [];
    vi.stubGlobal('requestAnimationFrame', (callback) => loop.push(callback));
    vi.stubGlobal('document', {createElement: () => ({getContext: () => ({drawImage: () => {}}), toBlob: () => {}})});
    const video = {videoWidth: 640, videoHeight: 360, seeking: false};
    const player = {currentTime: 0, readyState: 4, duration: 4, getVideo: () => video,
      createContext: () => ({on: vi.fn(), destroy: vi.fn()}), destroy: vi.fn()};
    const client = makeClient(player);
    client.isRegionBuffered = () => false;
    const extractor = new PreviewFrameExtractor(client);
    extractor.runAnalyzerInBackground(player, [], () => {});
    // frames at 0 and 2 s: not done yet
    loop.shift()();
    expect(player.currentTime).toBe(2);
    loop.shift()();
    expect(player.destroy).not.toHaveBeenCalled();
    // The frame at 4 s, the end, is counted at the next one (the loop checks before it
    // records where it is): done then.
    expect(player.currentTime).toBe(4);
    loop.shift()();
    expect(player.destroy).not.toHaveBeenCalled();
    loop.shift()();
    expect(player.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('the background analyses: a player that fails', () => {
  /**
   * A background player whose source loads, and which reports what the test makes it.
   * @return {Promise<Object>}
   */
  async function emittingPlayer() {
    const {EventEmitter} = await import('../../chrome/player/modules/eventemitter.mjs');
    const {DefaultPlayerEvents} = await import('../../chrome/player/enums/DefaultPlayerEvents.mjs');
    const video = Object.assign(new EventTarget(), {readyState: 0, paused: true, playbackRate: 1, currentTime: 0,
      videoWidth: 640, videoHeight: 360});
    const player = Object.assign(new EventEmitter(), {
      setup: vi.fn(async () => {}),
      setSource: vi.fn(async () => {}),
      getVideo: () => video,
      // What the analysis loop reads and does, once the metadata came.
      currentTime: 0,
      duration: 600,
      readyState: 0,
      paused: true,
      play() {},
      pause() {},
      // A context hears its player's events, as a real one does.
      createContext() {
        return {on: (event, listener) => player.on(event, listener), destroy() {}};
      },
      destroyed: 0,
      destroy() {
        this.destroyed++;
        this.emit(DefaultPlayerEvents.DESTROYED);
      },
    });
    return {player, ERROR: DefaultPlayerEvents.ERROR, LOADEDMETADATA: DefaultPlayerEvents.LOADEDMETADATA};
  }

  /** @return {Promise<Array<function(Object): Object>>} Makers of both analyzers. */
  async function analyzers() {
    const {AudioAnalyzer} = await import('../../chrome/player/modules/analyzer/AudioAnalyzer.mjs');
    vi.stubGlobal('AudioContext', class {
      constructor() {
        this.close = vi.fn(async () => {});
      }
      createMediaElementSource() {
        return {connect: vi.fn(), disconnect: vi.fn()};
      }
      createAnalyser() {
        return {};
      }
    });
    return [(client) => new PreviewFrameExtractor(client), (client) => new AudioAnalyzer(client)];
  }

  it('ends the analysis as failed on an error before its metadata, and tries again at the next start', async () => {
    vi.useFakeTimers();
    try {
      for (const make of await analyzers()) {
        const {player, ERROR} = await emittingPlayer();
        const client = makeClient(player);
        const analyzer = make(client);
        await analyzer.startBackgroundAnalyzer();
        expect(analyzer.backgroundAnalyzerStatus).toBe('running');

        player.emit(ERROR, new Error('the link expired'));
        expect(analyzer.backgroundAnalyzerStatus).toBe('failed');
        expect(analyzer.backgroundAnalyzerPlayer).toBeNull();
        expect(player.destroyed).toBe(1);

        analyzer.stopBackgroundAnalyzer();
        await analyzer.startBackgroundAnalyzer();
        expect(client.playerLoader.createPlayer).toHaveBeenCalledTimes(2);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps no player that failed while it loaded', async () => {
    vi.useFakeTimers();
    try {
      for (const make of await analyzers()) {
        const {player, ERROR} = await emittingPlayer();
        player.setSource = vi.fn(async () => player.emit(ERROR, new Error('manifest failed')));
        const analyzer = make(makeClient(player));
        await analyzer.startBackgroundAnalyzer();
        expect(analyzer.backgroundAnalyzerStatus).toBe('failed');
        expect(analyzer.backgroundAnalyzerPlayer).toBeNull();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// An error once the analysis runs, one during a load that also fails,
// and one after a stop. Each player is destroyed once (HLSPlayer's second destroy() throws).
describe('the background analyses: a player that fails at another time', () => {
  /**
   * A background player for the error cases (the helper above, again: describe blocks do not
   * share their functions).
   * @return {Promise<Object>}
   */
  async function emitting() {
    const {EventEmitter} = await import('../../chrome/player/modules/eventemitter.mjs');
    const {DefaultPlayerEvents} = await import('../../chrome/player/enums/DefaultPlayerEvents.mjs');
    const video = Object.assign(new EventTarget(), {readyState: 0, paused: true, playbackRate: 1, currentTime: 0,
      videoWidth: 640, videoHeight: 360});
    const player = Object.assign(new EventEmitter(), {
      setup: vi.fn(async () => {}),
      setSource: vi.fn(async () => {}),
      getVideo: () => video,
      currentTime: 0, duration: 600, readyState: 0, paused: true,
      play() {}, pause() {},
      createContext() {
        return {on: (event, listener) => player.on(event, listener), destroy() {}};
      },
      destroyed: 0,
      destroy() {
        this.destroyed++;
        this.emit(DefaultPlayerEvents.DESTROYED);
      },
    });
    return {player, events: DefaultPlayerEvents};
  }

  /** @return {Promise<Array<function(Object): Object>>} Makers of both analyzers. */
  async function both() {
    const {AudioAnalyzer} = await import('../../chrome/player/modules/analyzer/AudioAnalyzer.mjs');
    vi.stubGlobal('AudioContext', class {
      constructor() {
        this.close = vi.fn(async () => {});
      }
      createMediaElementSource() {
        return {connect: vi.fn(), disconnect: vi.fn()};
      }
      createAnalyser() {
        return {};
      }
    });
    vi.stubGlobal('requestAnimationFrame', () => {});
    return [(client) => new PreviewFrameExtractor(client), (client) => new AudioAnalyzer(client)];
  }

  it('ends a running analysis as failed on an error, its player destroyed once', async () => {
    vi.useFakeTimers();
    try {
      for (const make of await both()) {
        const {player, events} = await emitting();
        const client = makeClient(player);
        client.isRegionBuffered = () => false;
        const analyzer = make(client);
        await analyzer.startBackgroundAnalyzer();
        player.emit(events.LOADEDMETADATA);
        expect(analyzer.backgroundAnalyzerStatus).toBe('running');

        player.emit(events.ERROR, new Error('a segment expired'));
        player.emit(events.ERROR, new Error('and another'));
        expect(analyzer.backgroundAnalyzerStatus).toBe('failed');
        expect(analyzer.backgroundAnalyzerPlayer).toBeNull();
        expect(player.destroyed).toBe(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys a player once whose load reported an error and failed', async () => {
    vi.useFakeTimers();
    try {
      for (const make of await both()) {
        const {player, events} = await emitting();
        player.setSource = vi.fn(async () => {
          player.emit(events.ERROR, new Error('manifest failed'));
          throw new Error('manifest failed');
        });
        const analyzer = make(makeClient(player));
        await analyzer.startBackgroundAnalyzer();
        expect(player.destroyed).toBe(1);
        expect(analyzer.backgroundAnalyzerPlayer).toBeNull();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing more for an error after the analysis was stopped', async () => {
    vi.useFakeTimers();
    try {
      for (const make of await both()) {
        const {player, events} = await emitting();
        const analyzer = make(makeClient(player));
        await analyzer.startBackgroundAnalyzer();
        analyzer.stopBackgroundAnalyzer();
        expect(player.destroyed).toBe(1);
        player.emit(events.ERROR, new Error('late'));
        expect(player.destroyed).toBe(1);
        expect(analyzer.backgroundAnalyzerStatus).toBe('idle');
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
