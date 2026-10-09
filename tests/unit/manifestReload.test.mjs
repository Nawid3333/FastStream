import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// A live stream's playlist (HLS) or manifest (DASH) is loaded again and again, each time
// with what is new. The download manager answers a URL it has already downloaded from its
// store, so every reload got the first answer back, and a live stream stopped where its
// first window ended (tests/e2e/specs/hls-live.e2e.mjs shows it in the browser for HLS).
// These run the real loaders, download manager, downloader and fetch() loader, with only
// fetch() and the blob storage stood in for (a unit test has no FileReader or OPFS).

vi.mock('../../chrome/player/utils/BlobManager.mjs', () => ({
  BlobManager: {
    createBlob: (parts) => parts[0],
    getDataFromBlob: async (data) => data,
  },
}));

vi.mock('../../chrome/player/modules/FSBlob.mjs', () => ({
  FSBlob: class {
    constructor() {
      this.blobs = new Map();
    }
    async saveBlobAsync(blob, key) {
      this.blobs.set(key, blob);
    }
    getBlob(key) {
      return this.blobs.get(key);
    }
    deleteBlob(key) {
      this.blobs.delete(key);
    }
    close() {}
  },
}));

const {DownloadManager} = await import('../../chrome/player/network/DownloadManager.mjs');
const {HLSLoaderFactory: hlsLoaderFactory} = await import('../../chrome/player/players/hls/HLSLoader.mjs');
const {DASHLoaderFactory: dashLoaderFactory} = await import('../../chrome/player/players/dash/DashLoader.mjs');

let requests;

beforeEach(() => {
  globalThis.self = globalThis;
  requests = [];
  // Every answer is new, as a live playlist's is.
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    requests.push(url);
    return new Response(`answer ${requests.length}`, {status: 200});
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A download manager with one downloader.
 * @return {DownloadManager}
 */
function makeDownloadManager() {
  const client = {predownloadFragments() {}, resetFailed() {}, options: {maximumDownloaders: 1}};
  const downloadManager = new DownloadManager(client);
  downloadManager.addDownloader();
  return downloadManager;
}

/**
 * A player around a download manager: its own, or one it shares, as the seek preview
 * shares the main player's.
 * @param {DownloadManager} [downloadManager]
 * @return {Object} The player.
 */
function makePlayer(downloadManager = makeDownloadManager()) {
  return {
    source: {headers: {}},
    activeRequests: [],
    loadedManifests: new Set(),
    getIdentifier: (trackID, level) => `${trackID}:${level}`,
    client: {getFragment: () => null},
    getClient: () => ({downloadManager}),
  };
}

/**
 * The URLs the player's download manager holds, finished.
 * @param {Object} player
 * @return {string[]}
 */
function stored(player) {
  return player.getClient().downloadManager.getCompletedEntries().map((entry) => entry.url);
}

/**
 * Loads one URL through HLSLoader, as hls.js does.
 * @param {Object} player
 * @param {Object} context - hls.js's loader context.
 * @return {Promise<string>} What the loader answered.
 */
function loadHls(player, context) {
  return new Promise((resolve, reject) => {
    new (hlsLoaderFactory(player))().load({responseType: 'text', ...context}, {}, {
      onSuccess: (response) => resolve(response.data),
      onError: (error) => reject(new Error(`onError ${error.code}`)),
      onTimeout: () => reject(new Error('onTimeout')),
      onAbort: () => reject(new Error('onAbort')),
    });
  });
}

/**
 * Loads one URL through DashLoader, as dash.js does.
 * @param {Object} player
 * @param {string} url
 * @param {string} type - dash.js's request type.
 * @return {Promise<string>} What the loader answered.
 */
function loadDash(player, url, type) {
  return new Promise((resolve, reject) => {
    dashLoaderFactory(player)().load({
      url, method: 'GET', headers: {},
      customData: {
        request: {type, responseType: 'text'},
        onSuccess: (data) => resolve(data),
        onFail: () => reject(new Error('onFail')),
        onAbort: () => reject(new Error('onAbort')),
      },
    });
  });
}

describe('reloading a live stream\'s playlist or manifest', () => {
  it('downloads an HLS playlist again each time hls.js loads it', async () => {
    const player = makePlayer();
    const context = {url: 'http://127.0.0.1/live.m3u8', type: 'level'};
    expect(await loadHls(player, context)).toBe('answer 1');
    expect(await loadHls(player, context)).toBe('answer 2');
    expect(requests).toHaveLength(2);
  });

  it('downloads a DASH manifest again each time dash.js loads it', async () => {
    const player = makePlayer();
    expect(await loadDash(player, 'http://127.0.0.1/live.mpd', 'MPD')).toBe('answer 1');
    expect(await loadDash(player, 'http://127.0.0.1/live.mpd', 'MPD')).toBe('answer 2');
    expect(requests).toHaveLength(2);
  });

  it('still downloads an HLS key only once', async () => {
    const player = makePlayer();
    const context = {url: 'http://127.0.0.1/key.bin', frag: {sn: 3}, keyInfo: {}};
    expect(await loadHls(player, context)).toBe('answer 1');
    expect(await loadHls(player, context)).toBe('answer 1');
    expect(requests).toHaveLength(1);
  });

  it('still downloads a DASH index segment only once', async () => {
    const player = makePlayer();
    expect(await loadDash(player, 'http://127.0.0.1/video.mp4', 'IndexSegment')).toBe('answer 1');
    expect(await loadDash(player, 'http://127.0.0.1/video.mp4', 'IndexSegment')).toBe('answer 1');
    expect(requests).toHaveLength(1);
  });
});

// A stored copy that can no longer be read (an OPFS file gone, a Cache API entry gone):
// the read's rejection reached no callback, and the library waited for an answer for ever.
// Now it is a failure the library retries, and the next request downloads it again.
describe('a stored copy that can no longer be read', () => {
  /**
   * Makes the stored copy of a URL unreadable, as a file deleted under its File.
   * @param {Object} player
   * @param {string} url
   */
  function loseStoredCopy(player, url) {
    const manager = player.getClient().downloadManager;
    const entry = manager.getCompletedEntries().find((completed) => completed.url === url);
    manager.blobStore.blobs.delete(manager.getIdentifier(entry));
  }

  it('fails the DASH request, and the next one downloads it again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const player = makePlayer();
    const url = 'http://127.0.0.1/index.mp4';
    expect(await loadDash(player, url, 'IndexSegment')).toBe('answer 1');
    loseStoredCopy(player, url);
    await expect(loadDash(player, url, 'IndexSegment')).rejects.toThrow('onFail');
    expect(await loadDash(player, url, 'IndexSegment')).toBe('answer 2');
    vi.restoreAllMocks();
  });

  it('fails the HLS key request, and the next one downloads it again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const player = makePlayer();
    const context = {url: 'http://127.0.0.1/key.bin', frag: {sn: 3}, keyInfo: {}};
    expect(await loadHls(player, context)).toBe('answer 1');
    loseStoredCopy(player, context.url);
    await expect(loadHls(player, context)).rejects.toThrow('onAbort');
    expect(await loadHls(player, context)).toBe('answer 2');
    vi.restoreAllMocks();
  });
});

// A segment dash.js asks for that the fragment store does not have goes to the server
// directly (DashLoader's fallback). Its failures were not counted: dash.js's own errors once
// the stream is up leave it playing, and a dead segment spun forever behind a spinner.
describe('a DASH segment the fragment store does not have', () => {
  it('fails in the player after three tries, as a stored one does', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', {status: 404})));
    const player = {...makePlayer(), emit: vi.fn()};
    player.client = {getFragment: () => null, getFragments: () => []};
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // One factory per player, as DashPlayer gives dash.js (dash.extend): the count is its.
    const factory = dashLoaderFactory(player);
    const load = () => new Promise((resolve) => {
      factory().load({
        url: 'http://127.0.0.1/seg-5.m4s', method: 'GET', headers: {},
        customData: {
          request: {type: 'MediaSegment', representation: {id: 'v1', adaptation: {type: 'video'}},
            index: 5, startTime: 10, responseType: 'arraybuffer'},
          onSuccess: () => resolve('success'),
          onFail: () => resolve('fail'),
          onAbort: () => resolve('abort'),
        },
      });
    });
    expect(await load()).toBe('abort');
    expect(await load()).toBe('abort');
    expect(player.emit).not.toHaveBeenCalled();
    expect(await load()).toBe('fail');
    expect(player.emit).toHaveBeenCalledWith('error', 'Segment http://127.0.0.1/seg-5.m4s failed to load');
    vi.restoreAllMocks();
  });
});

// But the copy a player downloaded stays in the store. "Dump buffer" writes the store into
// an .fsa archive, and a player opened from that archive finds its manifest there - with
// the manifest dropped after every load, an archive could not be opened without the
// network. The seek preview shares the main player's download manager, and finds the copy
// there too instead of downloading it a second time. Only the same player loading it again
// is a reload (tests/e2e/specs/archive-roundtrip.e2e.mjs shows the archive in the browser).
describe('a playlist or manifest a player has loaded', () => {
  it('stays in the store, and another player gets it from there: HLS', async () => {
    const main = makePlayer();
    const context = {url: 'http://127.0.0.1/index.m3u8', type: 'level'};
    expect(await loadHls(main, context)).toBe('answer 1');
    expect(stored(main)).toContain('http://127.0.0.1/index.m3u8');

    const other = makePlayer(main.getClient().downloadManager);
    expect(await loadHls(other, context)).toBe('answer 1');
    expect(requests).toHaveLength(1);
  });

  it('stays in the store, and another player gets it from there: DASH', async () => {
    const main = makePlayer();
    expect(await loadDash(main, 'http://127.0.0.1/stream.mpd', 'MPD')).toBe('answer 1');
    expect(stored(main)).toContain('http://127.0.0.1/stream.mpd');

    const other = makePlayer(main.getClient().downloadManager);
    expect(await loadDash(other, 'http://127.0.0.1/stream.mpd', 'MPD')).toBe('answer 1');
    expect(requests).toHaveLength(1);
  });

  it('is replaced in the store by what a reload downloads', async () => {
    const player = makePlayer();
    const context = {url: 'http://127.0.0.1/live.m3u8', type: 'level'};
    await loadHls(player, context);
    await loadHls(player, context);
    const entries = player.getClient().downloadManager.getCompletedEntries();
    expect(entries.map((entry) => entry.url)).toEqual(['http://127.0.0.1/live.m3u8']);
    expect(await entries[0].getDataFromBlob()).toBe('answer 2');
  });
});
