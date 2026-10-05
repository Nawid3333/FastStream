import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The intro/outro finder (VideoAnalyzer) and the seek-preview frame extractor
// (PreviewFrameExtractor) each play the video again in a hidden background player. One that
// could not load (a manifest that failed to load again, a codec error) threw out of the
// caller, which nothing awaited: the intro finder stayed "running", so it never ran again,
// and the first or last five minutes it had pinned (ANALYZER) could never be freed; the
// half-built player was left as it was.

// VideoAligner needs the vendored pako, which unit tests do not have.
vi.mock('../../chrome/player/modules/analyzer/VideoAligner.mjs', async () => {
  const {EventEmitter} = await import('../../chrome/player/modules/eventemitter.mjs');
  return {
    VideoAligner: class extends EventEmitter {
      setRange() {}
      prepare() {}
      getMatch() {
        return null;
      }
    },
  };
});

const {VideoAnalyzer} = await import('../../chrome/player/modules/analyzer/VideoAnalyzer.mjs');
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

describe('VideoAnalyzer, a background player that fails to load', () => {
  it('marks the finder failed and unpins what it had pinned', async () => {
    const player = failingPlayer();
    const client = makeClient(player);
    const analyzer = new VideoAnalyzer(client);
    await analyzer.setSource(client.source);

    await expect(analyzer.update()).resolves.toBeUndefined();

    expect(analyzer.isRunning()).toBe(false);
    expect(client.fragments.every((fragment) => fragment.canFree())).toBe(true);
    expect(player.destroyed).toBe(true);
  });

  it('pins a range with holes in it, as a live stream\'s store has', async () => {
    // HLSFragmentStore forgets what a live window has left: the walk over the range threw on
    // the first hole.
    const client = makeClient(failingPlayer());
    delete client.fragments[3];
    const analyzer = new VideoAnalyzer(client);
    await analyzer.setSource(client.source);

    const reserved = analyzer.referenceFragments(0, 60);

    expect(reserved.map((fragment) => fragment.sn)).toEqual([0, 1, 2, 4, 5]);
  });

  it('pins the fragment the range ends in, which the analyzer plays into', async () => {
    // It stopped before it: 50-60 s was free to be dropped while the finder played to 55 s.
    const client = makeClient(failingPlayer());
    const analyzer = new VideoAnalyzer(client);
    await analyzer.setSource(client.source);

    const reserved = analyzer.referenceFragments(0, 55);

    expect(reserved.map((fragment) => fragment.sn)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('tries again once the quality changes, as after any failure', async () => {
    const client = makeClient(failingPlayer());
    const analyzer = new VideoAnalyzer(client);
    await analyzer.setSource(client.source);
    await analyzer.update();

    analyzer.setLevel('0:1', null);
    client.playerLoader.createPlayer.mockClear();
    await analyzer.update();
    expect(client.playerLoader.createPlayer).toHaveBeenCalled();
  });
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
