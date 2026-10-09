import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {StringUtils} from '../../utils/StringUtils.mjs';
import {DashTrackUtils} from './DashTrackUtils.mjs';

// How many times in a row one segment may fail before the player gives up on it. Until
// then a failure is an abort, and dash.js asks for the segment again. For good, a dead
// segment (a 403 from an expired token) was asked for forever behind a spinner: dash.js's
// errors once the stream is up leave it playing (DashPlayer), so no error ever showed.
const SEGMENT_FAILURES_BEFORE_ERROR = 3;

/**
 * decodeURI, but a URL it cannot decode (a `%` not followed by two hex digits, which a
 * manifest or a page may well contain) is used as it is instead of throwing.
 * @param {string} url
 * @return {string}
 */
function decodeUrl(url) {
  try {
    return decodeURI(url);
  } catch (e) {
    return url;
  }
}

/**
 * Whether two of dash.js's requests name the same bytes.
 * @param {Object} a - A FragmentRequest.
 * @param {Object} b - Another.
 * @return {boolean}
 */
function isSameRequest(a, b) {
  return a?.url === b.url && a?.range === b.range;
}


export function DASHLoaderFactory(player) {
  // Failures in a row, per segment, for this player; a success forgets them.
  const segmentFailures = new Map();

  return (cfg) => {
    cfg = cfg || {};

    function load(httpRequest) {
      const requestObj = httpRequest.customData.request;
      if (requestObj.type === 'InitializationSegment' ||
                requestObj.type === 'MediaSegment') {
        loadFragmentInternal(httpRequest);
        return;
      }

      request(httpRequest);
    }

    function loadFragmentInternal(httpRequest) {
      // console.log(httpRequest);
      try {
        const requestObj = httpRequest.customData.request;
        const representation = requestObj.representation;
        if (!representation) {
          console.error('Representation not found', requestObj);
          request(httpRequest, true, requestObj.startTime || 0, true);
          return;
        }
        let segmentIndex = requestObj.index;

        if (requestObj.type === 'InitializationSegment') {
          segmentIndex = -1;
        }

        const level = DashTrackUtils.getLevelFromRepresentation(representation);
        let frag = player.client.getFragment(level, segmentIndex);
        // The store is keyed by representation id and segment index, and in a manifest of
        // several periods neither is unique: ids need only differ within a period, and the
        // indexes start again in each. The next period's segment 0 got the stored one of
        // this period, and played its media. A stored fragment answers only for its own bytes.
        if (frag && !isSameRequest(frag.request, requestObj)) {
          frag = null;
        }
        if (!frag) {
          console.warn('Fragment not found', requestObj, level, player.client.getFragments(level));
          // throw new Error("Fragment not found");
          request(httpRequest, true, requestObj.startTime || 0, requestObj.type === 'InitializationSegment' || isNaN(segmentIndex));
          return;
        }

        const activeRequests = player.activeRequests;
        const segmentKey = level + ':' + segmentIndex;

        const loader = player.fragmentRequester.requestFragment(frag, {
          onSuccess: (entry, data) => {
            segmentFailures.delete(segmentKey);
            httpRequest.customData.onSuccess(data, entry.responseURL);
            const index = activeRequests.indexOf(loader);
            if (index > -1) {
              activeRequests.splice(index, 1);
            }
          },
          onProgress: (stats, context, data, xhr) => {

          },
          onFail: (entry) => {
            const failures = (segmentFailures.get(segmentKey) || 0) + 1;
            segmentFailures.set(segmentKey, failures);
            if (failures < SEGMENT_FAILURES_BEFORE_ERROR) {
              httpRequest.customData.onAbort(entry);
            } else {
              httpRequest.customData.onFail(entry);
              player.emit(DefaultPlayerEvents.ERROR, 'Segment ' + segmentKey + ' failed to load');
            }
            const index = activeRequests.indexOf(loader);
            if (index > -1) {
              activeRequests.splice(index, 1);
            }
          },
          onAbort: (entry) => {
            httpRequest.customData.onAbort(entry);
            const index = activeRequests.indexOf(loader);
            if (index > -1) {
              activeRequests.splice(index, 1);
            }
          },
        }, null, 1000);

        httpRequest.customData.abort = () => {
          loader.abort();
        };

        httpRequest._loader = loader;

        if (segmentIndex !== -1) {
          activeRequests.push(loader);
        }
      } catch (e) {
        console.error(e);
        // The request has to end one way or another: dash.js waited for this one forever.
        httpRequest.customData.onFail?.(e);
      }
    }

    function request(httpRequest, isSegment = false, startTime = 0, isInit = false) {
      // Variables will be used in the callback functions
      const request = httpRequest.customData.request;

      let rangeStart = undefined;
      let rangeEnd = undefined;

      if (request.range) {
        const [start, end] = StringUtils.parseHTTPRange(request.range);
        if (start === undefined) {
          console.warn('Failed to parse range', request.range);
        } else {
          rangeStart = start;
          rangeEnd = end + 1;
        }
        delete httpRequest.headers.Range;
      }
      const context = {
        url: decodeUrl(httpRequest.url),
        method: httpRequest.method || 'GET',
        responseType: request.responseType,
        rangeStart: rangeStart,
        rangeEnd: rangeEnd,
        config: {
          maxRetry: 0,
          timeout: 10000,
          retryDelay: 1000,
          maxRetryDelay: 64000,
        },
        headers: {
          ...httpRequest.headers,
          ...player.source.headers,
        },
      };

      const downloadManager = player.getClient().downloadManager;
      if (request.type === 'MPD') {
        // A player's first load of the manifest may be answered from the store, and the copy
        // has to stay there for "dump buffer" archives, a player opened from one, and the
        // seek preview. dash.js loads a live manifest again to learn of new segments: then
        // the stored copy is the old one, and the stream would stop where it ends.
        const key = downloadManager.getIdentifier(context);
        if (player.loadedManifests.has(key)) downloadManager.forgetCompletedFile(context);
        player.loadedManifests.add(key);
      }
      const loader = downloadManager.getFile({
        ...context,
        preProcessor: async (entry, request) => {
          if (isSegment && player.preProcessFragment) {
            return await player.preProcessFragment(entry, request, startTime, isInit);
          }
          return request;
        },
        postProcessor: async (entry, response) => {
          if (isSegment && player.postProcessFragment) {
            return await player.postProcessFragment(entry, response, startTime, isInit);
          }
          return response;
        },
      }, {
        onSuccess: async (entry, xhr) => {
          if (isSegment) {
            segmentFailures.delete('url:' + context.url + ':' + (rangeStart ?? '') + '-' + (rangeEnd ?? ''));
          }
          let data;
          try {
            data = await entry.getDataFromBlob();
          } catch (e) {
            // Stored, and no longer there to read (DownloadEntry.onDataLost drops it, so the
            // next request downloads it again): a failure dash.js retries. The rejection went
            // nowhere, and dash.js waited for the answer for ever.
            console.warn('Could not read a stored download', e);
            httpRequest.customData.onFail(entry);
            return;
          }
          httpRequest.customData.onSuccess(data, entry.responseURL);
        },
        onProgress: (stats, context, data, xhr)=> {

        },
        onFail: (entry)=> {
          if (!isSegment) {
            httpRequest.customData.onFail(entry);
            return;
          }
          // A segment the fragment store did not have (loadFragmentInternal's fallback):
          // counted as loadFragmentInternal counts, so that one which keeps failing ends in the
          // player's error. dash.js's own errors once the stream is up leave it playing
          // (DashPlayer), and it was asked for forever behind a spinner.
          const key = 'url:' + context.url + ':' + (rangeStart ?? '') + '-' + (rangeEnd ?? '');
          const failures = (segmentFailures.get(key) || 0) + 1;
          segmentFailures.set(key, failures);
          if (failures < SEGMENT_FAILURES_BEFORE_ERROR) {
            httpRequest.customData.onAbort(entry);
          } else {
            httpRequest.customData.onFail(entry);
            player.emit(DefaultPlayerEvents.ERROR, 'Segment ' + context.url + ' failed to load');
          }
        },
        onAbort: (entry) => {
          httpRequest.customData.onAbort(entry);
        },
      });

      httpRequest.customData.abort = () => {
        loader.abort();
      };

      httpRequest._loader = loader;
    }

    function abort(request) {
      if (request._loader) {
        request._loader.abort();
        request._loader = null;
      }
    }

    // dash.js's own XHRLoader has all five; its HTTPLoader calls resetInitialSettings when
    // a decode error resets the MediaSource. Without it the reset threw ("xhrLoader.
    // resetInitialSettings is not a function", real-streams check, 2026-10-05) and the
    // stream never recovered. Nothing is left to abort by then: HTTPLoader's abort() has
    // ended every request in flight through its customData.abort, set above. There is no
    // single XHR here for getXhr.
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
