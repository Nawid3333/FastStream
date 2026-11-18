// @ts-check
import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {PLAYBACK_PRIORITY} from '../../network/StandardDownloader.mjs';
import {StringUtils} from '../../utils/StringUtils.mjs';
import {sourceHeadersFor} from '../../VideoSource.mjs';
import {DashTrackUtils} from './DashTrackUtils.mjs';

// Failures in a row of one segment before the player gives up on it; until then dash.js asks again.
const SEGMENT_FAILURES_BEFORE_ERROR = 3;

/** @typedef {import('../../modules/dash.mjs').FragmentRequest} FragmentRequest */
/** @typedef {import('../../network/DownloadEntry.mjs').DownloadEntry} DownloadEntry */
/** @typedef {import('../../network/FetchLoader.mjs').FetchLoader['stats']} LoadStats */

/**
 * @typedef {{url: string, method: string, headers: Object<string, string>,
 *   customData: {request: FragmentRequest, onloadend?: () => void, onabort?: () => void,
 *     abort?: () => void},
 *   _loader?: ?ReturnType<import('../../network/DownloadManager.mjs').DownloadManager['getFile']>}} DashLoaderRequest
 */

/**
 * @typedef {{url?: string, status: number, statusText?: string, data?: ArrayBuffer|string}} DashLoaderResponse
 */

/**
 * Ends a request as dash.js's own XHRLoader does: the answer in its CommonMediaResponse, then customData.onloadend.
 * @param {DashLoaderRequest} httpRequest
 * @param {DashLoaderResponse} httpResponse
 * @return {{success: (data: ArrayBuffer|string|undefined, responseURL: string) => void,
 *   fail: () => void, abort: () => void}}
 */
function endsOf(httpRequest, httpResponse) {
  const customData = httpRequest.customData;
  return {
    success(data, responseURL) {
      httpResponse.url = responseURL;
      httpResponse.status = 200;
      httpResponse.statusText = 'OK';
      httpResponse.data = data;
      // None on a request dash.js has aborted: its answer goes nowhere, as from XHRLoader.
      customData.onloadend?.();
    },
    fail() {
      // Status 0, a network error's: a 404's first failure has dash.js check its clock against a time server.
      httpResponse.status = 0;
      customData.onloadend?.();
    },
    abort() {
      customData.onabort?.();
    },
  };
}

/**
 * @param {FragmentRequest} a
 * @param {FragmentRequest} b
 * @return {boolean}
 */
function isSameRequest(a, b) {
  return a?.url === b.url && a?.range === b.range;
}


/** @param {import('./DashPlayer.mjs').default} player */
export function DASHLoaderFactory(player) {
  // Failures in a row, per segment, for this player; a success forgets them.
  /** @type {Map<string, number>} */
  const segmentFailures = new Map();

  /** @param {Object} [cfg] */
  return (cfg) => {
    cfg = cfg || {};

    /**
     * @param {DashLoaderRequest} httpRequest
     * @param {DashLoaderResponse} httpResponse
     */
    function load(httpRequest, httpResponse) {
      const end = endsOf(httpRequest, httpResponse);
      const requestObj = httpRequest.customData.request;
      if (requestObj.type === 'InitializationSegment' ||
                requestObj.type === 'MediaSegment') {
        loadFragmentInternal(httpRequest, end);
        return;
      }

      request(httpRequest, end);
    }

    /**
     * @param {DashLoaderRequest} httpRequest
     * @param {ReturnType<typeof endsOf>} end
     */
    function loadFragmentInternal(httpRequest, end) {
      try {
        const requestObj = httpRequest.customData.request;
        const representation = requestObj.representation;
        if (!representation) {
          console.error('Representation not found', requestObj);
          request(httpRequest, end, true);
          return;
        }
        let segmentIndex = requestObj.index;

        if (requestObj.type === 'InitializationSegment') {
          segmentIndex = -1;
        }

        const level = DashTrackUtils.getLevelFromRepresentation(representation);
        let frag = /** @type {import('./DashFragment.mjs').DashFragment|null|undefined} */ (player.client.getFragment(level, segmentIndex));
        // Representation ids and segment indexes repeat across periods: a stored fragment answers only for its own bytes.
        if (frag && !isSameRequest(frag.request, requestObj)) {
          frag = null;
        }
        if (!frag) {
          console.warn('Fragment not found', requestObj, level, player.client.getFragments(level));
          request(httpRequest, end, true);
          return;
        }

        const segmentKey = level + ':' + segmentIndex;
        // Counted per bytes: the next period's segment at the same place is another one.
        const failureKey = segmentKey + ':' + requestObj.url + ':' + (requestObj.range ?? '');

        const loader = player.fragmentRequester.requestFragment(frag, /** @type {import('./DashFragmentRequester.mjs').FragmentCallbacks} */ ({
          onSuccess: (entry, data) => {
            segmentFailures.delete(failureKey);
            end.success(data, /** @type {string} */ (entry.responseURL));
          },
          onProgress: (stats, context, data, xhr) => {

          },
          onFail: (entry) => {
            const failures = (segmentFailures.get(failureKey) || 0) + 1;
            segmentFailures.set(failureKey, failures);
            if (failures < SEGMENT_FAILURES_BEFORE_ERROR) {
              end.abort();
            } else {
              end.fail();
              player.emit(DefaultPlayerEvents.ERROR, 'Segment ' + segmentKey + ' failed to load');
            }
          },
          onAbort: (entry) => {
            end.abort();
          },
        }), null, PLAYBACK_PRIORITY);

        httpRequest.customData.abort = () => {
          loader.abort();
        };

        httpRequest._loader = loader;
      } catch (e) {
        console.error(e);
        // The request has to end one way or another: dash.js waited for this one forever.
        end.fail();
      }
    }

    /**
     * Downloads what the store does not hold: a manifest, or a segment it has no place for.
     * @param {DashLoaderRequest} httpRequest
     * @param {ReturnType<typeof endsOf>} end
     * @param {boolean} [isSegment]
     */
    function request(httpRequest, end, isSegment = false) {
      const request = httpRequest.customData.request;

      /** @type {number|undefined} */
      let rangeStart = undefined;
      /** @type {number|undefined} */
      let rangeEnd = undefined;

      if (request.range) {
        const [start, end] = StringUtils.parseHTTPRange(request.range);
        if (start === undefined) {
          console.warn('Failed to parse range', request.range);
        } else {
          rangeStart = start;
          rangeEnd = Number.isNaN(end) ? undefined : end + 1;
        }
        delete httpRequest.headers.Range;
      }
      const context = {
        // As dash.js has it, as the store names a segment: decoded, a signed link's %25 became %.
        url: httpRequest.url,
        method: httpRequest.method || 'GET',
        responseType: request.responseType,
        rangeStart: rangeStart,
        rangeEnd: rangeEnd,
        // A segment gets the download manager's retries (dash.js retries nothing); a manifest fails at once.
        config: {
          maxRetry: isSegment ? 6 : 0,
          timeout: 10000,
          retryDelay: 1000,
          maxRetryDelay: 64000,
        },
        headers: {
          ...httpRequest.headers,
          // Login headers only to the source's own site (VideoSource.headersFor).
          ...sourceHeadersFor(/** @type {import('../../VideoSource.mjs').VideoSource} */ (player.source), httpRequest.url),
        },
      };

      const downloadManager = player.getClient().downloadManager;
      // dash.js's types know only segment types; the manifest's (a TextRequest) is 'MPD'.
      if (/** @type {?string} */ (request.type) === 'MPD') {
        // A first load may come from the store (archives, the seek preview); a live refresh must not.
        const key = downloadManager.getIdentifier(context);
        if (player.loadedManifests.has(key)) downloadManager.forgetCompletedFile(context);
        player.loadedManifests.add(key);
      }
      // No watcher reads its pieces: a postProcessor keeps the entry from holding a second copy.
      // At playback's priority: dash.js asks for each of these to play on.
      const loader = downloadManager.getFile({...context, postProcessor: async (entry, response) => response}, {
        /**
         * @param {DownloadEntry} entry
         * @param {null} [xhr]
         */
        onSuccess: async (entry, xhr) => {
          if (isSegment) {
            segmentFailures.delete('url:' + context.url + ':' + (rangeStart ?? '') + '-' + (rangeEnd ?? ''));
          }
          let data;
          try {
            data = await entry.getDataFromBlob();
          } catch (e) {
            // Stored and no longer readable (onDataLost drops it): a failure dash.js retries.
            console.warn('Could not read a stored download', e);
            end.fail();
            return;
          }
          end.success(data, /** @type {string} */ (entry.responseURL));
        },
        /**
         * @param {LoadStats} stats
         * @param {Awaited<ReturnType<DownloadEntry['getRequest']>>} context
         * @param {ArrayBuffer|string} data
         * @param {null} xhr
         */
        onProgress: (stats, context, data, xhr)=> {

        },
        /** @param {DownloadEntry} entry */
        onFail: (entry)=> {
          if (!isSegment) {
            end.fail();
            return;
          }
          // Counted as loadFragmentInternal counts, so one that keeps failing ends in the player's error.
          const key = 'url:' + context.url + ':' + (rangeStart ?? '') + '-' + (rangeEnd ?? '');
          const failures = (segmentFailures.get(key) || 0) + 1;
          segmentFailures.set(key, failures);
          if (failures < SEGMENT_FAILURES_BEFORE_ERROR) {
            end.abort();
          } else {
            end.fail();
            player.emit(DefaultPlayerEvents.ERROR, 'Segment ' + context.url + ' failed to load');
          }
        },
        /** @param {DownloadEntry} entry */
        onAbort: (entry) => {
          end.abort();
        },
      }, PLAYBACK_PRIORITY);

      httpRequest.customData.abort = () => {
        loader.abort();
      };

      httpRequest._loader = loader;
    }

    /** @param {DashLoaderRequest} request */
    function abort(request) {
      if (request._loader) {
        request._loader.abort();
        request._loader = null;
      }
    }

    // dash.js's HTTPLoader calls resetInitialSettings when a decode error resets the MediaSource.
    return {
      load: load,
      abort: abort,
      getXhr: () => null,
      reset: () => {
        // Reset any internal state if needed
      },
      resetInitialSettings: () => {},
    };
  };
}
