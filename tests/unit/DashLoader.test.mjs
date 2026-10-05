import fs from 'node:fs';
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
      client: {getFragment: () => ({request: {url: 'http://127.0.0.1/seg7.m4s'}}), getFragments: () => []},
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
          url: 'http://127.0.0.1/seg7.m4s', representation: {id: 'v1', adaptation: {type: 'video'}}},
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

describe('DashLoader, a manifest of several periods', () => {
  // dash.js numbers a representation's segments from 0 in each period, and a
  // representation's id need only be unique within its period, so period 2's first segment
  // has the same store key (video-1, 0) as period 1's. dash.js loads the next period while
  // the current one plays: its request found period 1's stored segment, and got period 1's
  // media at every period change.

  /**
   * A request dash.js makes for segment 0 of representation 1 of a period.
   * @param {string} url - The segment's address in that period.
   * @param {string} [range] - Its byte range, for a SegmentBase representation.
   * @return {Object}
   */
  function firstSegment(url, range) {
    return {
      url,
      method: 'GET',
      headers: {},
      customData: {
        request: {type: 'MediaSegment', index: 0, startTime: 600, responseType: 'arraybuffer',
          url, range, representation: {id: '1', adaptation: {type: 'video'}}},
        onSuccess: vi.fn(),
        onFail: vi.fn(),
        onAbort: vi.fn(),
      },
    };
  }

  /**
   * A player whose store holds period 1's segment 0 of representation 1.
   * @param {Object} stored - The stored fragment's request.
   * @return {Object}
   */
  function makePlayer(stored) {
    const requestFragment = vi.fn(() => ({abort() {}}));
    const getFile = vi.fn(() => ({abort() {}}));
    const getFragment = vi.fn(() => ({request: stored}));
    const player = {
      source: {headers: {}},
      activeRequests: [],
      loadedManifests: new Set(),
      emit: vi.fn(),
      client: {getFragment, getFragments: () => []},
      fragmentRequester: {requestFragment},
      getClient: () => ({downloadManager: {getFile}}),
    };
    return {player, requestFragment, getFile, getFragment};
  }

  it('downloads the next period\'s segment, not the stored one of this period', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const {player, requestFragment, getFile, getFragment} = makePlayer({url: 'http://127.0.0.1/p1/v1-0.m4s'});
    dashLoaderFactory(player)().load(firstSegment('http://127.0.0.1/p2/v1-0.m4s'));
    warn.mockRestore();

    expect(getFragment).toHaveBeenCalledWith('video-1', 0);
    expect(requestFragment).not.toHaveBeenCalled();
    expect(getFile).toHaveBeenCalledTimes(1);
    expect(getFile.mock.calls[0][0].url).toBe('http://127.0.0.1/p2/v1-0.m4s');
  });

  it('tells segments of one file apart by their byte range', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const {player, requestFragment, getFile} = makePlayer({url: 'http://127.0.0.1/v1.mp4', range: '900-1899'});
    dashLoaderFactory(player)().load(firstSegment('http://127.0.0.1/v1.mp4', '52000-60999'));
    warn.mockRestore();

    expect(requestFragment).not.toHaveBeenCalled();
    expect(getFile.mock.calls[0][0].rangeStart).toBe(52000);
  });

  it('serves the stored segment for a request for its own bytes', () => {
    const {player, requestFragment, getFile} = makePlayer({url: 'http://127.0.0.1/v1.mp4', range: '900-1899'});
    dashLoaderFactory(player)().load(firstSegment('http://127.0.0.1/v1.mp4', '900-1899'));

    expect(requestFragment).toHaveBeenCalledTimes(1);
    expect(getFile).not.toHaveBeenCalled();
  });
});

describe('DashLoader, what dash.js calls on it', () => {
  // dash.js's HTTPLoader calls resetInitialSettings when a decode error resets the
  // MediaSource. DashLoader had no such method: the reset threw ("xhrLoader.
  // resetInitialSettings is not a function") and a live DASH stream stopped for good (the
  // real-streams check on Windows, 2026-10-05). It has every method of dash.js's own
  // XHRLoader, whose list is read from dash.js, so an update that adds one shows here.
  // The npm file, not chrome/player/modules/dash.mjs: the build copies that one from it
  // (tools/sync-vendor.mjs), and CI runs the unit tests before the build.
  const dash = fs.readFileSync(new URL('../../node_modules/dashjs/dist/modern/esm/dash.all.debug.js', import.meta.url), 'utf8');
  const opening = dash.indexOf('instance = {', dash.indexOf('function XHRLoader() {'));
  const methods = dash.slice(opening + 'instance = {'.length, dash.indexOf('};', opening))
      .split(',').map((name) => name.trim()).filter(Boolean);

  it('knows the methods of dash.js\'s XHRLoader', () => {
    expect(methods).toEqual(['load', 'abort', 'getXhr', 'reset', 'resetInitialSettings']);
  });

  it('has each of them', () => {
    const loader = dashLoaderFactory({})();
    for (const name of methods) {
      expect(typeof loader[name], name).toBe('function');
    }
  });

  it('lets dash.js reset it after a decode error', () => {
    const loader = dashLoaderFactory({})();
    expect(() => loader.resetInitialSettings()).not.toThrow();
    expect(() => loader.reset()).not.toThrow();
    expect(loader.getXhr()).toBeNull();
  });
});
