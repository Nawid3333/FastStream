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

  it('keeps reporting a failed fragment as an abort, for hls.js to request it again', () => {
    // Not in FastStream's store, so it takes the direct download path.
    const {player, getFile} = makePlayer(null);
    const callbacks = fragmentCallbacks();
    new (hlsLoaderFactory(player))().load({url: 'http://127.0.0.1/seg5.ts', frag: {sn: 5, trackID: 0, level: 0}}, {}, callbacks);

    getFile.mock.calls[0][1].onFail({stats: {error: {code: 500, text: 'Server Error'}}});
    vi.advanceTimersByTime(1000);

    expect(callbacks.onAbort).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
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
