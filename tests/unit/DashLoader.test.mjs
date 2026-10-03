import {afterEach, describe, expect, it, vi} from 'vitest';
import {DASHLoaderFactory as dashLoaderFactory} from '../../chrome/player/players/dash/DashLoader.mjs';

// DashLoader hands dash.js's requests to FastStream's download manager, passing each URL
// through decodeURI (since the dash.js 5 upgrade). decodeURI throws on a `%` that is not
// followed by two hex digits, and a manifest or a page may well contain one
// (`seg_50%.m4s`, `?title=100%`): the request was then never made, and nothing told
// dash.js. (What a reload of a manifest gets: manifestReload.test.mjs.)

/**
 * Loads one manifest request through DashLoader.
 * @param {string} url - The URL dash.js asks for.
 * @return {Object} What the download manager was asked for.
 */
function loadManifest(url) {
  const getFile = vi.fn(() => ({abort() {}}));
  const player = {
    source: {headers: {}},
    loadedManifests: new Set(),
    getClient: () => ({downloadManager: {getFile, getIdentifier: (details) => details.url, forgetCompletedFile: vi.fn()}}),
  };
  dashLoaderFactory(player)().load({
    url,
    method: 'GET',
    headers: {},
    customData: {
      request: {type: 'MPD', responseType: 'text'},
      onSuccess: vi.fn(),
      onFail: vi.fn(),
      onAbort: vi.fn(),
    },
  });
  expect(getFile).toHaveBeenCalledTimes(1);
  return getFile.mock.calls[0][0];
}

// A spy a failed test left behind would silence the files' later tests.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('DashLoader URLs', () => {
  it('requests a URL with a lone % as it is', () => {
    expect(loadManifest('http://127.0.0.1/show/100%.mpd').url).toBe('http://127.0.0.1/show/100%.mpd');
    expect(loadManifest('http://127.0.0.1/a.mpd?p=5%zz').url).toBe('http://127.0.0.1/a.mpd?p=5%zz');
  });

  it('still decodes a URL decodeURI can decode, as before', () => {
    expect(loadManifest('http://127.0.0.1/my%20show.mpd').url).toBe('http://127.0.0.1/my show.mpd');
  });
});

describe('DashLoader, a segment that keeps failing', () => {
  // dash.js asks again for a segment reported as aborted, and its errors once the stream is
  // up leave the player as it is (DashPlayer). A dead segment (an expired token's 403) was
  // asked for forever, behind a spinner, with no error shown.

  /**
   * A player whose store holds every segment, with the download's callbacks recorded.
   * @return {Object}
   */
  function makeSegmentPlayer() {
    const requestFragment = vi.fn(() => ({abort() {}}));
    const player = {
      source: {headers: {}},
      activeRequests: [],
      loadedManifests: new Set(),
      emit: vi.fn(),
      client: {getFragment: () => ({}), getFragments: () => []},
      fragmentRequester: {requestFragment},
      getClient: () => ({downloadManager: {getFile: vi.fn(() => ({abort() {}}))}}),
    };
    return {player, requestFragment};
  }

  /**
   * A request dash.js makes for media segment 7 of the video representation.
   * @return {Object}
   */
  function segmentRequest() {
    return {
      url: 'http://127.0.0.1/seg7.m4s',
      method: 'GET',
      headers: {},
      customData: {
        request: {type: 'MediaSegment', index: 7, startTime: 14, responseType: 'arraybuffer',
          representation: {id: 'v1', adaptation: {type: 'video'}}},
        onSuccess: vi.fn(),
        onFail: vi.fn(),
        onAbort: vi.fn(),
      },
    };
  }

  it('reports it as an abort twice, then as an error the player shows', () => {
    const {player, requestFragment} = makeSegmentPlayer();
    const load = dashLoaderFactory(player)();
    const heard = [];
    for (let n = 0; n < 4; n++) {
      const request = segmentRequest();
      load.load(request);
      requestFragment.mock.calls[n][1].onFail({});
      heard.push(request.customData.onAbort.mock.calls.length ? 'abort' : request.customData.onFail.mock.calls.length ? 'error' : '-');
    }
    expect(heard).toEqual(['abort', 'abort', 'error', 'error']);
    expect(player.emit).toHaveBeenCalledWith('error', expect.stringContaining('video-v1:7'));
  });

  it('starts counting again once the segment has loaded', () => {
    const {player, requestFragment} = makeSegmentPlayer();
    const load = dashLoaderFactory(player)();
    const outcomes = ['fail', 'fail', 'success', 'fail', 'fail'];
    const heard = outcomes.map((outcome, n) => {
      const request = segmentRequest();
      load.load(request);
      if (outcome === 'fail') {
        requestFragment.mock.calls[n][1].onFail({});
      } else {
        requestFragment.mock.calls[n][1].onSuccess({responseURL: request.url}, new ArrayBuffer(1));
      }
      return request.customData.onAbort.mock.calls.length ? 'abort' : request.customData.onFail.mock.calls.length ? 'error' : 'success';
    });
    expect(heard).toEqual(['abort', 'abort', 'success', 'abort', 'abort']);
    expect(player.emit).not.toHaveBeenCalled();
  });

  it('ends a request whose loading threw, instead of leaving dash.js waiting for it', () => {
    const {player} = makeSegmentPlayer();
    player.client.getFragment = () => {
      throw new Error('store gone');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = segmentRequest();
    dashLoaderFactory(player)().load(request);
    expect(request.customData.onFail).toHaveBeenCalledTimes(1);
  });
});
