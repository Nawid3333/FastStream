import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {HLSLoaderFactory as hlsLoaderFactory} from '../../chrome/player/players/hls/HLSLoader.mjs';

// HLSLoader is the loader hls.js calls for every playlist, key and fragment. What it
// tells hls.js about a failure decides what hls.js does next, and hls.js's loaders do
// not all accept the same callbacks: its playlist loader passes onSuccess, onError and
// onTimeout, and no onAbort (hls.mjs, PlaylistLoader.load). A failed playlist reported as
// an abort reached nobody, and the player waited forever on a manifest that was not there.
// (What a reload of a playlist gets: manifestReload.test.mjs.)

/**
 * A player with just what HLSLoader reaches.
 * @param {Object} [stored] - What client.getFragment answers.
 * @return {Object} The player and its spies.
 */
function makePlayer(stored = null) {
  const getFile = vi.fn(() => ({abort() {}}));
  const requestFragment = vi.fn(() => ({abort() {}}));
  const player = {
    source: {headers: {}},
    activeRequests: [],
    loadedManifests: new Set(),
    getIdentifier: (trackID, level) => `${trackID}:${level}`,
    client: {getFragment: vi.fn(() => stored)},
    getClient: () => ({downloadManager: {getFile, getIdentifier: (details) => details.url, forgetCompletedFile: vi.fn()}}),
    fragmentRequester: {requestFragment},
  };
  return {player, getFile, requestFragment};
}

/**
 * The callbacks hls.js's playlist loader passes, and nothing more.
 * @return {Object}
 */
function playlistCallbacks() {
  return {onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn()};
}

/**
 * The callbacks hls.js's fragment loader passes.
 * @return {Object}
 */
function fragmentCallbacks() {
  return {onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onAbort: vi.fn(), onProgress: vi.fn()};
}

/**
 * A stored init segment, as HLSPlayer.trackUpdated makes one.
 * @param {Object} hlsFrag - The hls.js fragment it wraps.
 * @return {Object}
 */
function storedInit(hlsFrag) {
  return {getFrag: () => hlsFrag};
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HLSLoader, a download that failed', () => {
  it('reports a failed playlist as an error, with its HTTP status', () => {
    const {player, getFile} = makePlayer();
    const Loader = hlsLoaderFactory(player);
    const callbacks = playlistCallbacks();
    const context = {url: 'http://127.0.0.1/missing.m3u8', type: 'manifest', responseType: 'text'};
    new Loader().load(context, {}, callbacks);

    const [, downloadCallbacks] = getFile.mock.calls[0];
    downloadCallbacks.onFail({stats: {error: {code: 404, text: 'Not Found'}}});
    vi.advanceTimersByTime(1000);

    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    const [error, errorContext] = callbacks.onError.mock.calls[0];
    expect(error).toEqual({code: 404, text: 'Not Found'});
    expect(errorContext).toBe(context);
  });

  it('reports a failed playlist without an HTTP status as an error too', () => {
    const {player, getFile} = makePlayer();
    const callbacks = playlistCallbacks();
    new (hlsLoaderFactory(player))().load({url: 'http://127.0.0.1/level.m3u8', type: 'level'}, {}, callbacks);

    getFile.mock.calls[0][1].onFail({stats: {}});
    vi.advanceTimersByTime(1000);

    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(callbacks.onError.mock.calls[0][0].code).toBe(0);
  });

  /**
   * Loads one segment again and again with a new loader each time, as hls.js does, and
   * fails or completes each load as told.
   * @param {Object} player - From makePlayer.
   * @param {Function} downloadCallbacks - The download's callbacks of the n-th load.
   * @param {string[]} outcomes - 'fail' or 'success' per load.
   * @return {string[]} What hls.js heard for each load: 'abort', 'error' or 'success'.
   */
  function loadRepeatedly(player, downloadCallbacks, outcomes) {
    const Loader = hlsLoaderFactory(player);
    return outcomes.map((outcome, n) => {
      const callbacks = fragmentCallbacks();
      new Loader().load({url: 'http://127.0.0.1/seg5.ts', frag: {sn: 5, trackID: 0, level: 0}}, {}, callbacks);
      if (outcome === 'fail') {
        downloadCallbacks(n).onFail({stats: {error: {code: 403, text: 'Forbidden'}}});
      } else {
        downloadCallbacks(n).onSuccess({stats: {}, getDataFromBlob: async () => new ArrayBuffer(1)}, {}, {}, null);
      }
      vi.advanceTimersByTime(1000);
      if (callbacks.onAbort.mock.calls.length) return 'abort';
      if (callbacks.onError.mock.calls.length) return 'error ' + callbacks.onError.mock.calls[0][0].code;
      return 'success';
    });
  }

  it('reports a failing segment as an abort twice, for hls.js to ask again, then as an error', () => {
    // Asked for again forever, a dead segment (an expired token's 403) kept the player
    // spinning with no error. Not in FastStream's store: the direct download path.
    const {player, getFile} = makePlayer(null);
    expect(loadRepeatedly(player, (n) => getFile.mock.calls[n][1], ['fail', 'fail', 'fail', 'fail']))
        .toEqual(['abort', 'abort', 'error 403', 'error 403']);
  });

  it('counts a stored segment\'s failures the same way', () => {
    const {player, requestFragment} = makePlayer({getFrag: () => ({})});
    expect(loadRepeatedly(player, (n) => requestFragment.mock.calls[n][1], ['fail', 'fail', 'fail']))
        .toEqual(['abort', 'abort', 'error 403']);
  });

  it('starts counting again once the segment has loaded', () => {
    const {player, requestFragment} = makePlayer({getFrag: () => ({})});
    expect(loadRepeatedly(player, (n) => requestFragment.mock.calls[n][1], ['fail', 'fail', 'success', 'fail', 'fail']))
        .toEqual(['abort', 'abort', 'success', 'abort', 'abort']);
  });

  it('marks its stats aborted when hls.js aborts it, as hls.js\'s own loaders do', () => {
    const {player} = makePlayer(null);
    const loader = new (hlsLoaderFactory(player))();
    loader.load({url: 'http://127.0.0.1/seg5.ts', frag: {sn: 5, trackID: 0, level: 0}}, {}, fragmentCallbacks());
    expect(loader.stats.aborted).toBe(false);
    loader.abort();
    expect(loader.stats.aborted).toBe(true);
  });

  it('says nothing once hls.js has destroyed the loader', () => {
    const {player, getFile} = makePlayer();
    const callbacks = playlistCallbacks();
    const loader = new (hlsLoaderFactory(player))();
    loader.load({url: 'http://127.0.0.1/level.m3u8', type: 'level'}, {}, callbacks);

    getFile.mock.calls[0][1].onFail({stats: {}});
    loader.destroy();
    vi.advanceTimersByTime(1000);

    expect(callbacks.onError).not.toHaveBeenCalled();
  });
});

describe('HLSLoader, init segments', () => {
  const INIT = {sn: 'initSegment', url: 'http://127.0.0.1/init-a.mp4', byteRangeStartOffset: undefined, byteRangeEndOffset: undefined, trackID: 0, level: 0};

  it('serves the stored init segment for a request for it', () => {
    const {player, getFile, requestFragment} = makePlayer(storedInit(INIT));
    new (hlsLoaderFactory(player))().load({url: INIT.url, frag: {...INIT}}, {}, fragmentCallbacks());

    expect(requestFragment).toHaveBeenCalledTimes(1);
    expect(getFile).not.toHaveBeenCalled();
  });

  it('downloads an init segment the stored one is not, rather than serving the stored one', () => {
    // The playlist's EXT-X-MAP moved to another address after the level's init was stored.
    const {player, getFile, requestFragment} = makePlayer(storedInit(INIT));
    const other = {...INIT, url: 'http://127.0.0.1/init-b.mp4'};
    new (hlsLoaderFactory(player))().load({url: other.url, frag: other}, {}, fragmentCallbacks());

    expect(requestFragment).not.toHaveBeenCalled();
    expect(getFile).toHaveBeenCalledTimes(1);
    expect(getFile.mock.calls[0][0].url).toBe(other.url);
  });

  it('fails a load it could not start, rather than leaving hls.js waiting for it', () => {
    // requestFragment refused an init segment still under hls.js's key (HLSEncryptedPlaylists
    // test): the throw was logged, hls.js heard nothing, and the stream span forever.
    const {player, requestFragment} = makePlayer(storedInit(INIT));
    requestFragment.mockImplementation(() => {
      throw new Error('unexpected decryptdata');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const callbacks = fragmentCallbacks();
    const context = {url: INIT.url, frag: {...INIT}};
    new (hlsLoaderFactory(player))().load(context, {}, callbacks);
    error.mockRestore();

    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(callbacks.onError.mock.calls[0][0].text).toMatch(/unexpected decryptdata/);
    expect(callbacks.onError.mock.calls[0][1]).toBe(context);
  });

  it('tells init segments in one file apart by their byte range', () => {
    const inFile = {...INIT, byteRangeStartOffset: 0, byteRangeEndOffset: 720};
    const {player, getFile, requestFragment} = makePlayer(storedInit(inFile));
    const next = {...inFile, byteRangeStartOffset: 720, byteRangeEndOffset: 1440};
    new (hlsLoaderFactory(player))().load({url: next.url, frag: next}, {}, fragmentCallbacks());

    expect(requestFragment).not.toHaveBeenCalled();
    expect(getFile).toHaveBeenCalledTimes(1);
  });
});

describe('HLSLoader, before a download has reported', () => {
  it('has the load stats hls.js reads while a load is on its way', () => {
    // A seek during a fragment load asks the loader's stats.loading.first
    // (isFragmentNearlyDownloaded), and a loader that started from {} threw there.
    const {player} = makePlayer();
    const loader = new (hlsLoaderFactory(player))();
    loader.load({url: 'http://127.0.0.1/seg5.ts', frag: {sn: 5, trackID: 0, level: 0}}, {}, fragmentCallbacks());
    const stats = loader.stats;
    expect(stats.loading).toEqual({start: 0, first: 0, end: 0});
    expect(stats.parsing).toEqual({start: 0, end: 0});
    expect(stats.buffering).toEqual({start: 0, first: 0, end: 0});
    expect(stats.total - stats.loaded).toBe(0);
    expect(stats.aborted).toBe(false);
  });
});
