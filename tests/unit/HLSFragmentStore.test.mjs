import {M3U8Parser} from 'hls.js';
import {describe, expect, it, vi} from 'vitest';
import {DownloadStatus} from '../../chrome/player/enums/DownloadStatus.mjs';
import {ReferenceTypes} from '../../chrome/player/enums/ReferenceTypes.mjs';
import {storeIndex, storeLevel} from '../../chrome/player/players/hls/HLSFragmentStore.mjs';
import {HLSLoaderFactory as hlsLoaderFactory} from '../../chrome/player/players/hls/HLSLoader.mjs';

// A live HLS stream's segments were stored at their media sequence numbers, which a server
// may start anywhere: the level's array was as long as the number, and the client's loops
// walked every hole below it each second. Nor was anything forgotten as the live window
// moved on. These parse live playlists with hls.js's own parser (the release package.json
// pins) and store them as HLSPlayer.trackUpdated does.

const FIRST = 5000000;

/**
 * A live media playlist (no EXT-X-ENDLIST) of 2 s segments.
 * @param {number} sequence - EXT-X-MEDIA-SEQUENCE.
 * @param {number} count - How many segments it lists.
 * @return {Object} hls.js's LevelDetails, as HLSPlayer gets them.
 */
function livePlaylist(sequence, count) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${sequence}`];
  for (let sn = sequence; sn < sequence + count; sn++) {
    lines.push('#EXTINF:2,', `seg${sn}.ts`);
  }
  const details = M3U8Parser.parseLevelPlaylist(lines.join('\n') + '\n', 'http://127.0.0.1/live/index.m3u8', 0, 'main', 0, null);
  details.trackID = 0;
  return details;
}

/**
 * FastStreamClient's store, as its getFragment, getFragments and makeFragment keep it.
 * @return {Object}
 */
function makeClient() {
  const fragmentsStore = {};
  return {
    fragmentsStore,
    getFragment: (level, sn) => fragmentsStore[level] ? fragmentsStore[level][sn] : null,
    getFragments: (level) => fragmentsStore[level],
    makeFragment: (level, sn, frag) => {
      if (!fragmentsStore[level]) fragmentsStore[level] = [];
      fragmentsStore[level][sn] = frag;
    },
  };
}

const identifierOf = (level) => `0:${level}`;

describe('HLSFragmentStore, a live stream numbered from five million', () => {
  it('stores the segments from the level\'s first, not at their sequence numbers', () => {
    const client = makeClient();
    storeLevel(client, livePlaylist(FIRST, 3), identifierOf);
    const store = client.getFragments('0:0');

    // It was 5,000,003 long: the client walked five million holes each second.
    expect(store.length).toBe(3);
    expect(store.map((fragment) => fragment.sn)).toEqual([0, 1, 2]);
    expect(store[2].getContext().url).toBe(`http://127.0.0.1/live/seg${FIRST + 2}.ts`);
    expect(storeIndex(store, FIRST + 2)).toBe(2);
  });

  it('keeps each segment at its place as the window moves on', () => {
    const client = makeClient();
    storeLevel(client, livePlaylist(FIRST, 5), identifierOf);
    const kept = client.getFragment('0:0', 4);
    storeLevel(client, livePlaylist(FIRST + 2, 5), identifierOf);
    storeLevel(client, livePlaylist(FIRST + 4, 5), identifierOf);
    const store = client.getFragments('0:0');

    expect(store.length).toBe(9);
    expect(store[4]).toBe(kept);
    expect(storeIndex(store, FIRST + 8)).toBe(8);
    expect(store[8].getContext().url).toBe(`http://127.0.0.1/live/seg${FIRST + 8}.ts`);
  });

  it('forgets what the window has left that holds nothing', () => {
    const client = makeClient();
    storeLevel(client, livePlaylist(FIRST, 3), identifierOf);
    storeLevel(client, livePlaylist(FIRST + 2, 3), identifierOf);
    const store = client.getFragments('0:0');

    expect(0 in store).toBe(false);
    expect(1 in store).toBe(false);
    expect([2, 3, 4].every((index) => store[index])).toBe(true);
  });

  it('keeps what is downloaded, pinned or downloading until it is released', () => {
    const client = makeClient();
    storeLevel(client, livePlaylist(FIRST, 4), identifierOf);
    const [downloaded, pinned, downloading] = client.getFragments('0:0');
    downloaded.status = DownloadStatus.DOWNLOAD_COMPLETE;
    pinned.addReference(ReferenceTypes.SAVER);
    downloading.status = DownloadStatus.DOWNLOAD_INITIATED;

    storeLevel(client, livePlaylist(FIRST + 3, 3), identifierOf);
    let store = client.getFragments('0:0');
    expect(store[0]).toBe(downloaded);
    expect(store[1]).toBe(pinned);
    expect(store[2]).toBe(downloading);

    // Freed by playback, the save done, the download aborted: the next refresh forgets them.
    downloaded.status = DownloadStatus.WAITING;
    pinned.removeReference(ReferenceTypes.SAVER);
    downloading.status = DownloadStatus.WAITING;
    storeLevel(client, livePlaylist(FIRST + 4, 3), identifierOf);
    store = client.getFragments('0:0');
    expect([0, 1, 2, 3].some((index) => index in store)).toBe(false);
  });

  it('does not store a segment numbered before the level\'s first', () => {
    // A live stream that started its numbering again: its segments are downloaded as they
    // are (HLSLoader), rather than written at negative places (-1 is the init segment).
    const client = makeClient();
    storeLevel(client, livePlaylist(FIRST, 2), identifierOf);
    storeLevel(client, livePlaylist(FIRST - 3, 3), identifierOf);
    const store = client.getFragments('0:0');
    expect(Object.keys(store).some((key) => Number(key) < 0)).toBe(false);
    expect(store[-1]).toBeUndefined();
    expect(storeIndex(store, FIRST - 1)).toBe(null);
  });

  it('forgets nothing of a playlist that is not live', () => {
    const client = makeClient();
    const details = livePlaylist(FIRST, 3);
    details.live = false;
    storeLevel(client, details, identifierOf);
    const later = livePlaylist(FIRST + 2, 3);
    later.live = false;
    storeLevel(client, later, identifierOf);
    expect([0, 1, 2, 3, 4].every((index) => client.getFragment('0:0', index))).toBe(true);
  });
});

describe('HLSLoader, a segment of a live stream', () => {
  it('serves the stored segment at its place in the level', () => {
    const client = makeClient();
    storeLevel(client, livePlaylist(FIRST, 3), identifierOf);
    const requestFragment = vi.fn(() => ({abort() {}}));
    const getFile = vi.fn(() => ({abort() {}}));
    const player = {
      source: {headers: {}},
      activeRequests: [],
      loadedManifests: new Set(),
      getIdentifier: (trackID, level) => `${trackID}:${level}`,
      client,
      getClient: () => ({downloadManager: {getFile}}),
      fragmentRequester: {requestFragment},
    };
    const frag = {sn: FIRST + 1, trackID: 0, level: 0, url: `http://127.0.0.1/live/seg${FIRST + 1}.ts`};
    new (hlsLoaderFactory(player))().load({url: frag.url, frag}, {}, {onSuccess: vi.fn(), onError: vi.fn(), onAbort: vi.fn()});

    expect(getFile).not.toHaveBeenCalled();
    expect(requestFragment).toHaveBeenCalledTimes(1);
    expect(requestFragment.mock.calls[0][0]).toBe(client.getFragment('0:0', 1));
  });
});
