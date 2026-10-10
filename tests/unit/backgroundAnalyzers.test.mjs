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
