import {describe, expect, it, vi} from 'vitest';
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
    getClient: () => ({downloadManager: {getFile, removeFile: vi.fn()}}),
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

describe('DashLoader URLs', () => {
  it('requests a URL with a lone % as it is', () => {
    expect(loadManifest('http://127.0.0.1/show/100%.mpd').url).toBe('http://127.0.0.1/show/100%.mpd');
    expect(loadManifest('http://127.0.0.1/a.mpd?p=5%zz').url).toBe('http://127.0.0.1/a.mpd?p=5%zz');
  });

  it('still decodes a URL decodeURI can decode, as before', () => {
    expect(loadManifest('http://127.0.0.1/my%20show.mpd').url).toBe('http://127.0.0.1/my show.mpd');
  });
});
