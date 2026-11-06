import fs from 'node:fs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {DASHLoaderFactory as dashLoaderFactory} from '../../chrome/player/players/dash/DashLoader.mjs';
import {DashFragment} from '../../chrome/player/players/dash/DashFragment.mjs';

// DashLoader hands dash.js's requests to FastStream's download manager, passing each URL
// through decodeURI (since the dash.js 5 upgrade). decodeURI throws on a `%` that is not
// followed by two hex digits, and a manifest or a page may well contain one
// (`seg_50%.m4s`, `?title=100%`): the request was then never made, and nothing told
// dash.js. (What a reload of a manifest gets: manifestReload.test.mjs.)

/**
 * HTTPLoader's own ends of a request, as dash.js puts them in its customData for the loader:
 * onloadend once the answer is in the response, onabort.
 * @return {{onloadend: Function, onabort: Function}}
 */
const ends = () => ({onloadend: vi.fn(), onabort: vi.fn()});

/**
 * How dash.js heard a request end, as its HTTPLoader would take it: an abort, the answer (its
 * CommonMediaResponse a 2xx), an error (anything else), or not yet.
 * @param {Object} request - What dash.js handed the loader.
 * @param {Object} response - The CommonMediaResponse it handed with it.
 * @return {'abort'|'success'|'error'|'-'}
 */
function heardOf(request, response) {
  if (request.customData.onabort.mock.calls.length) return 'abort';
  if (!request.customData.onloadend.mock.calls.length) return '-';
  return response.status >= 200 && response.status <= 299 ? 'success' : 'error';
}

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
      ...ends(),
    },
  }, {status: 0});
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

describe('DashLoader and DashFragment, one segment through both paths', () => {
  // dash.js can ask for a segment before the store has it: the "Fragment not found"
  // fallback downloads it, keyed by the URL it decoded, while every later request for it
  // goes through the store (DashFragment.getContext, the URL as dash.js has it). A manifest
  // that writes seg%20one.m4s had the same bytes downloaded and stored twice.
  const SEGMENT_URL = 'http://127.0.0.1/seg%20one.m4s';

  /**
   * A request dash.js makes for segment 7 of the video representation.
   * @param {string} url - The segment's address, as the manifest writes it.
   * @return {Object}
   */
  function dashRequest(url) {
    return {
      url,
      method: 'GET',
      headers: {},
      customData: {
        request: {type: 'MediaSegment', index: 7, startTime: 14, responseType: 'arraybuffer',
          url, representation: {id: 'v1', adaptation: {type: 'video'}}},
        ...ends(),
      },
    };
  }

  it('names the segment as the store does, so its bytes are not downloaded twice', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getFile = vi.fn(() => ({abort() {}}));
    const player = {
      source: {headers: {}},
      // The store does not have the segment yet: the race the fallback is for.
      client: {getFragment: () => null, getFragments: () => []},
      getClient: () => ({downloadManager: {getFile}}),
    };
    dashLoaderFactory(player)().load(dashRequest(SEGMENT_URL));
    const stored = new DashFragment({...dashRequest(SEGMENT_URL).customData.request, level: 'video-v1', duration: 4});
    expect(getFile.mock.calls[0][0].url).toBe(stored.getContext().url);
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
        ...ends(),
      },
    };
  }

  it('reports it as an abort twice, then as an error the player shows', () => {
    const {player, requestFragment} = makeSegmentPlayer();
    const load = dashLoaderFactory(player)();
    const heard = [];
    for (let n = 0; n < 4; n++) {
      const request = segmentRequest();
      const response = {status: 0};
      load.load(request, response);
      requestFragment.mock.calls[n][1].onFail({});
      heard.push(heardOf(request, response));
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
      const response = {status: 0};
      load.load(request, response);
      if (outcome === 'fail') {
        requestFragment.mock.calls[n][1].onFail({});
      } else {
        requestFragment.mock.calls[n][1].onSuccess({responseURL: request.url}, new ArrayBuffer(1));
      }
      return heardOf(request, response);
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
    const response = {status: 0};
    dashLoaderFactory(player)().load(request, response);
    expect(request.customData.onloadend).toHaveBeenCalledTimes(1);
    expect(heardOf(request, response)).toBe('error');
  });
});

describe('DashLoader, how a request ends for dash.js', () => {
  // dash.js's stock HTTPLoader gives its loader the request's ends: the answer goes into the
  // CommonMediaResponse, then customData.onloadend (a 2xx with a body is the answer, anything
  // else an error), an abort is customData.onabort. FastStream's patch used to add its own
  // three callbacks to HTTPLoader for this, and cut HTTPLoader's ending out; the cut conflicted
  // with dash.js's updates.

  /**
   * A player whose store holds segment 7, and a request for it.
   * @return {Object}
   */
  function segment() {
    const requestFragment = vi.fn(() => ({abort() {}}));
    const player = {
      source: {headers: {}}, activeRequests: [], emit: vi.fn(),
      client: {getFragment: () => ({request: {url: 'http://127.0.0.1/seg7.m4s'}}), getFragments: () => []},
      fragmentRequester: {requestFragment},
    };
    const request = {
      url: 'http://127.0.0.1/seg7.m4s', method: 'GET', headers: {},
      customData: {
        request: {type: 'MediaSegment', index: 7, startTime: 14, responseType: 'arraybuffer',
          url: 'http://127.0.0.1/seg7.m4s', representation: {id: 'v1', adaptation: {type: 'video'}}},
        ...ends(),
      },
    };
    const response = {status: 0};
    dashLoaderFactory(player)().load(request, response);
    return {callbacks: requestFragment.mock.calls[0][1], request, response};
  }

  it('puts the answer in dash.js\'s response before onloadend', () => {
    const {callbacks, request, response} = segment();
    const data = new ArrayBuffer(4);
    request.customData.onloadend.mockImplementation(() => {
      // What HTTPLoader reads in its onloadend.
      expect(response).toMatchObject({status: 200, data, url: 'http://127.0.0.1/moved/seg7.m4s'});
    });
    callbacks.onSuccess({responseURL: 'http://127.0.0.1/moved/seg7.m4s'}, data);
    expect(request.customData.onloadend).toHaveBeenCalledTimes(1);
    expect(request.customData.onabort).not.toHaveBeenCalled();
  });

  it('tells an abort through onabort, and nothing else', () => {
    const {callbacks, request} = segment();
    callbacks.onAbort({});
    expect(request.customData.onabort).toHaveBeenCalledTimes(1);
    expect(request.customData.onloadend).not.toHaveBeenCalled();
  });

  it('tells nothing of a request dash.js has aborted itself (its abort takes onloadend away)', () => {
    const {callbacks, request} = segment();
    request.customData.onloadend = undefined;
    expect(() => callbacks.onSuccess({responseURL: request.url}, new ArrayBuffer(1))).not.toThrow();
  });
});

describe('dash.js\'s HTTPLoader, what DashLoader relies on', () => {
  // DashLoader ends requests through dash.js's own, unpatched HTTPLoader (endsOf). An update of
  // dash.js that changes how HTTPLoader takes a loader's answer fails here, in its own PR.
  const dash = fs.readFileSync(new URL('../../node_modules/dashjs/dist/modern/esm/dash.all.debug.js', import.meta.url), 'utf8');
  const start = dash.indexOf('"./src/streaming/net/HTTPLoader.js":');
  // Its code only: not its comments (a patch that cut code out could leave it there as comments).
  const httpLoader = dash.slice(start, dash.indexOf('\n/***/ "./', start + 1))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s+/g, ' ');

  it('hands the loader the request and its response', () => {
    expect(start).toBeGreaterThan(0);
    expect(httpLoader).toContain('loader.load(httpRequest, httpResponse);');
  });

  it('puts its own ends of the request in customData', () => {
    expect(httpLoader).toContain('httpRequest.customData.onloadend = _onloadend;');
    expect(httpLoader).toContain('httpRequest.customData.onabort = _onabort;');
  });

  it('takes a 2xx with a body as the answer, and passes its data and URL on', () => {
    expect(httpLoader).toContain('commonMediaResponse.status >= 200 && commonMediaResponse.status <= 299');
    expect(httpLoader).toContain('config.success(commonMediaResponse.data, commonMediaResponse.statusText, commonMediaResponse.url);');
  });

  it('retries as many times as its settings say (DashPlayer sets 0)', () => {
    expect(httpLoader).toMatch(/getRetryAttemptsForType\(config\.request\.type\)/);
    expect(httpLoader).toContain('if (remainingAttempts > 0) {');
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
        ...ends(),
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
