import {afterEach, describe, expect, it, vi} from 'vitest';

// MP4Player makes every 1 MB range of a file as soon as it knows the file's length. A length it
// was told and did not check - a Content-Range of 2^53 bytes, a sample table or a box that puts
// the file's end there - made billions of ranges in one go: the player's page, and with it every
// add-on's pages (Firefox runs them in one process), hung. These run the places that make the
// ranges on a stand-in player whose fragment store counts what is made.

const {default: MP4Player} = await import('../../chrome/player/players/mp4/MP4Player.mjs');
const {MP4Fragment} = await import('../../chrome/player/players/mp4/MP4Fragment.mjs');
const {DefaultPlayerEvents} = await import('../../chrome/player/enums/DefaultPlayerEvents.mjs');

// More than the ranges of the longest file loaded in ranges (RangeAnswers.MAX_FILE_LENGTH):
// the store refuses to grow past it, so an unbounded loop fails at once instead of hanging.
const STORE_LIMIT = 300000;
// An MP4's first bytes: a box size and 'ftyp'.
const MP4_START = [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70];

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A player before its first range is in, as runLoad reaches into it.
 * @return {Object} The player, its store, and the first range's request once runLoad made it.
 */
function firstRangePlayer() {
  const store = [];
  const made = {count: 0, request: null};
  const player = Object.create(MP4Player.prototype);
  Object.assign(player, {
    nothingToPreview: false, metaData: null, loaded: false, isPreview: false, loader: null,
    handedOver: false, running: true, fileLength: 0, pendingSeek: null,
    fedRanges: new Map(), currentFragments: [], rangeRetries: new Map(),
    videoTracks: [], audioTracks: [], currentVideoTrack: 0, currentAudioTrack: 0,
    options: {backBufferLength: 10, maxFragmentsBuffered: 30, maxBufferLength: 30},
    video: {currentTime: 0},
    source: {url: 'https://cdn.test/video.mp4'},
    mp4box: {nextParsePosition: 0, appendBuffer: vi.fn()},
    emit: vi.fn(),
    client: {
      getFragment: (level, sn) => store[sn],
      getFragments: () => store,
      makeFragment: (level, sn, frag) => {
        if (++made.count > STORE_LIMIT) throw new Error('more ranges than any file has');
        store[sn] = frag;
      },
    },
    fragmentRequester: {
      requestFragment: (frag, callbacks) => {
        made.request = {frag, callbacks};
        return {abort() {}};
      },
    },
  });
  store[0] = new MP4Fragment(player.getCurrentVideoLevelID(), 0, player.source, 0, 1000000);
  return {player, store, made};
}

/**
 * The first range's bytes: an MP4's start, then zeros.
 * @return {ArrayBuffer & {fileStart: number}}
 */
function firstRange() {
  const data = /** @type {ArrayBuffer & {fileStart: number}} */ (new ArrayBuffer(1000000));
  new Uint8Array(data).set(MP4_START);
  data.fileStart = 0;
  return data;
}

describe('MP4Player, a file longer than it loads in ranges', () => {
  it('hands a Content-Range of 2^53 bytes to Firefox\'s own player, making no ranges', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const {player, store, made} = firstRangePlayer();
    player.runLoad();
    made.request.callbacks.onSuccess({
      responseStatus: 206,
      responseHeaders: {'content-range': 'bytes 0-999999/9007199254740991'},
    }, firstRange());
    expect(store.length).toBe(1);
    expect(player.fileLength).toBe(0);
    expect(player.emit).toHaveBeenCalledWith(DefaultPlayerEvents.PLAY_DIRECTLY, expect.stringMatching(/too long/));
    expect(player.mp4box.appendBuffer).not.toHaveBeenCalled();
  });

  it('takes no length from the same answer while its first range downloads', () => {
    const {player} = firstRangePlayer();
    vi.spyOn(player, 'initializeFragments');
    const frag = player.client.getFragment(player.getCurrentVideoLevelID(), 0);
    const contentRange = 'bytes 0-999999/9007199254740991';
    player.feedPiece(frag, new Uint8Array([...MP4_START, 1, 2]), 0,
        {status: 206, contentRange, headers: {'content-range': contentRange}});
    expect(player.fileLength).toBe(0);
    expect(player.initializeFragments).not.toHaveBeenCalled();
    expect(player.mp4box.appendBuffer).not.toHaveBeenCalled();
  });

  it('hands over a file read on without a length whose next box ends past it', () => {
    // A 206 without Content-Range: the ranges are made up to where mp4box reads next, which a
    // box's size says - an mdat of 2^60 bytes before the moov.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const {player, store, made} = firstRangePlayer();
    player.mp4box.appendBuffer = vi.fn(() => {
      player.mp4box.nextParsePosition = 2 ** 60;
    });
    player.runLoad();
    made.request.callbacks.onSuccess({responseStatus: 206, responseHeaders: {}}, firstRange());
    expect(store.length).toBe(1);
    expect(player.emit).toHaveBeenCalledWith(DefaultPlayerEvents.PLAY_DIRECTLY, expect.stringMatching(/too long/));
  });

  it('takes no length from a sample table that puts a sample past it', () => {
    const player = Object.create(MP4Player.prototype);
    Object.assign(player, {
      fileLength: 0,
      metaData: {isFragmented: false, tracks: [{id: 1}]},
      mp4box: {moov: {traks: [{tkhd: {track_id: 1}, samples: [{offset: 2 ** 53, size: 100}]}]}},
      initializeFragments: vi.fn(),
    });
    player.estimateTotalSizeFromMetadats();
    expect(player.fileLength).toBe(0);
    expect(player.initializeFragments).not.toHaveBeenCalled();

    // A sample table inside the longest file loaded in ranges gives its length, as before.
    player.mp4box.moov.traks[0].samples = [{offset: 5000000, size: 100}];
    player.estimateTotalSizeFromMetadats();
    expect(player.fileLength).toBe(5000100);
    expect(player.initializeFragments).toHaveBeenCalledTimes(1);
  });
});
