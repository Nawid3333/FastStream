import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The seek-preview frame extractor (PreviewFrameExtractor) plays the video again in a
// hidden background player. One that could not load (a manifest that failed to load again,
// a codec error) threw out of the caller, which nothing awaited, and the half-built player
// was left as it was.

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

// glm's second look, 2026-10-13.
describe('PreviewFrameExtractor after a load that failed', () => {
  it('tries again at the next start, as the audio analyzer does', async () => {
    // A failed load was final for the video: one dropped manifest request, and the timeline
    // had no frames until the next video.
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
    // Its video had no size: it ended while its source was still being set, when the check
    // for "the running player" compared two unset values and passed, and the load's return
    // then kept the dead player as the running one, which blocked every later start.
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

describe('PreviewFrameExtractor, a stale background player', () => {
  it('leaves the running one in place when it ends', async () => {
    // A started for source A, then for B; B loaded first and runs. A, loaded last, is
    // destroyed as stale, and its end cleared B's place: nothing could stop B any more.
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

describe('AudioAnalyzer, a background player destroyed before its metadata came', () => {
  // A stop (a new video, the tool closed) or a newer start while the player loaded: its
  // audio context and volume loop were let go only once the analysis ran, which needs the
  // metadata, and ran on for the rest of the session.
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
      const video = {readyState: 0, paused: true, playbackRate: 1, currentTime: 0};
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
  // Finished, the background player was gone, and the switch changed nothing: the volumes
  // were the old track's for the rest of the video, and nothing analysed the new one (glm's
  // look at a noted edge case, 2026-10-13).
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
