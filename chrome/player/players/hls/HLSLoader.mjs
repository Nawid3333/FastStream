// @ts-check
import {storeIndex} from './HLSFragmentStore.mjs';

// How many times in a row one segment may fail before hls.js hears an error. Until then a
// failure is reported as an abort, and hls.js asks for the segment again: FastStream's way
// of riding out a failure that passes, on top of FetchLoader's own retries. For good, it hid
// a dead segment (a 403 from an expired token) behind a spinner: hls.js asked for it
// forever, and the player never showed an error.
const SEGMENT_FAILURES_BEFORE_ERROR = 3;

/** @typedef {import('../../modules/hls.mjs').Fragment} HlsFragment */
/** @typedef {import('../../modules/hls.mjs').FragmentLoaderContext} FragmentLoaderContext */
/** @typedef {import('../../network/DownloadEntry.mjs').DownloadEntry} DownloadEntry */
/** @typedef {import('../../network/FetchLoader.mjs').FetchLoader['stats']} LoadStats */

/**
 * What hls.js asks a loader to load (load): a playlist (no frag), a media segment (its
 * frag) or a key (its frag and keyInfo).
 * @typedef {import('../../modules/hls.mjs').LoaderContext & {frag?: HlsFragment,
 *   keyInfo?: import('../../modules/hls.mjs').KeyLoaderInfo}} HlsLoadContext
 */

/**
 * Whether two hls.js fragments name the same bytes.
 * @param {HlsFragment} a - An hls.js fragment.
 * @param {HlsFragment} b - Another.
 * @return {boolean}
 */
function isSameSegment(a, b) {
  return a.url === b.url && a.byteRangeStartOffset === b.byteRangeStartOffset &&
    a.byteRangeEndOffset === b.byteRangeEndOffset;
}

// How far a segment's start and duration may lie from a stored copy's for the same place.
const PLACE_TOLERANCE_S = 1;

/**
 * A URL without its query and fragment: where a live stream's rotating token sits.
 * @param {string} url
 * @return {string}
 */
function withoutQuery(url) {
  return String(url || '').replace(/[?#].*$/, '');
}

/**
 * Whether a stored media segment is still the one a request names, after a live stream
 * may have started its numbering again: the store finds a segment by its number only, and
 * the one taking a stored one's number was served that one's bytes, with no error. Not by
 * its URL: a live stream rotates a token in the query on every playlist refresh. Another
 * only when both differ - its address without the query, and its place in the stream
 * (start, duration): hls.js moves a live segment's start once it read its timestamps, so
 * the place alone would take every kept segment for another.
 * @param {HlsFragment} stored - The stored fragment's hls.js fragment.
 * @param {HlsFragment} frag - The request's.
 * @return {boolean}
 */
function isSamePlace(stored, frag) {
  if (!stored?.url || !frag?.url || withoutQuery(stored.url) === withoutQuery(frag.url)) {
    return true;
  }
  if (!Number.isFinite(stored.start) || !Number.isFinite(frag.start)) {
    return true;
  }
  return Math.abs(stored.start - frag.start) <= PLACE_TOLERANCE_S &&
    Math.abs((stored.duration || 0) - (frag.duration || 0)) <= PLACE_TOLERANCE_S;
}

/**
     * Calling load() will start retrieving content located at given URL (HTTP GET).
     *
     * @param {object} context - loader context
     * @param {string} context.url - target URL
     * @param {string} context.responseType - loader response type (arraybuffer or default response type for playlist)
     * @param {number} [context.rangeStart] - start byte range offset
     * @param {number} [context.rangeEnd] - end byte range offset
     * @param {Boolean} [context.progressData] - true if onProgress should report partial chunk of loaded content
     * @param {object} config - loader config params
     * @param {number} config.maxRetry - Max number of load retries
     * @param {number} config.timeout - Timeout after which `onTimeOut` callback will be triggered (if loading is still not finished after that delay)
     * @param {number} config.retryDelay - Delay between an I/O error and following connection retry (ms). This to avoid spamming the server
     * @param {number} config.maxRetryDelay - max connection retry delay (ms)
     * @param {object} callbacks - loader callbacks
     * @param {onSuccessCallback} callbacks.onSuccess - Callback triggered upon successful loading of URL.
     * @param {onProgressCallback} callbacks.onProgress - Callback triggered while loading is in progress.
     * @param {onErrorCallback} callbacks.onError - Callback triggered if any I/O error is met while loading fragment.
     * @param {onTimeoutCallback} callbacks.onTimeout - Callback triggered if loading is still not finished after a certain duration.

      @callback onSuccessCallback
      @param response {object} - response data
      @param response.url {string} - response URL (which might have been redirected)
      @param response.data {string|ArrayBuffer|SharedArrayBuffer} - response data (reponse type should be as per context.responseType)
      @param stats {object} - loading stats (hls.js's LoadStats)
      @param stats.aborted {boolean} - must be set to true once the request has been aborted
      @param stats.loaded {number} - nb of loaded bytes
      @param stats.total {number} - total nb of bytes
      @param stats.retry {number} - number of retries performed
      @param stats.chunkCount {number} - number of chunk progress events
      @param stats.bwEstimate {number} - download bandwidth in bits/s
      @param stats.loading {{start: number, first: number, end: number}}
      @param stats.parsing {{start: number, end: number}}
      @param stats.buffering {{start: number, first: number, end: number}}
      @param context {object} - loader context
      @param networkDetails {object} - loader network details (the xhr for default loaders)

      @callback onProgressCallback
      @param stats {object} - loading stats (hls.js's LoadStats)
      @param context {object} - loader context
      @param data {string|ArrayBuffer|SharedArrayBuffer} - onProgress data (should be defined only if context.progressData === true)
      @param networkDetails {object} - loader network details (the xhr for default loaders)

      @callback onErrorCallback
      @param error {object} - error data
      @param error.code {number} - error status code
      @param error.text {string} - error description
      @param context {object} - loader context
      @param networkDetails {object} - loader network details (the xhr for default loaders)

      @callback onTimeoutCallback
      @param stats {object} - loading stats (hls.js's LoadStats)
      @param context {object} - loader context

   */
/**
 * @param {import('./HLSPlayer.mjs').default} player - The player whose loads it serves.
 */
export function HLSLoaderFactory(player) {
  // Failures in a row, per segment, for this player; a success forgets them.
  /** @type {Map<string, number>} */
  const segmentFailures = new Map();

  return class HLSLoader {
    constructor() {
      // The shape of hls.js's LoadStats, since hls.js reads it before any download has
      // reported: a seek during a fragment load asks stats.loading.first, which threw on
      // {} and cut hls.js's seek handling short. copyStats brings a download's in, with
      // FetchLoader's error when it failed.
      /** @type {import('../../modules/hls.mjs').LoaderStats & {error?: {code: number, text: string}}} */
      this.stats = {
        aborted: false,
        loaded: 0,
        total: 0,
        retry: 0,
        chunkCount: 0,
        bwEstimate: 0,
        loading: {start: 0, first: 0, end: 0},
        parsing: {start: 0, end: 0},
        buffering: {start: 0, first: 0, end: 0},
      };
    }

    /**
     * Tells hls.js a segment or key failed to download: an abort the first times the same
     * one fails (hls.js asks for it again), an error from then on (hls.js retries it by its
     * own policy, and fails the player once it gives up).
     * @param {string} key - Which segment or key.
     */
    reportFailure(key) {
      const failures = (segmentFailures.get(key) || 0) + 1;
      segmentFailures.set(key, failures);
      if (!this.callbacks) return;
      if (failures < SEGMENT_FAILURES_BEFORE_ERROR) {
        this.stats.aborted = true;
        this.callbacks.onAbort?.(this.stats, this.context, null, null);
        return;
      }
      const error = this.stats.error || {code: 0, text: 'Download failed'};
      this.callbacks.onError?.(error, this.context, null, this.stats);
    }

    /**
     * @param {LoadStats} stats - A download's (FetchLoader's, kept on its DownloadEntry; an
     *   archive keeps a copy).
     */
    copyStats(stats) {
      for (const key in stats) {
        if (Object.hasOwn(stats, key)) {
          // Each of its own fields, whatever it is.
          /** @type {Object<string, *>} */ (this.stats)[key] = /** @type {Object<string, *>} */ (stats)[key];
        }
      }
    }

    /**
     * hls.js's Loader.load.
     * @param {HlsLoadContext} context
     * @param {import('../../modules/hls.mjs').LoaderConfiguration} config
     * @param callbacks - hls.js's LoaderCallbacks; left untyped, as onAbort is called with a
     *   fourth argument (null) that hls.js's type of it does not take.
     */
    load(context, config, callbacks) {
      const isFragment = context.frag !== undefined && context.keyInfo === undefined;

      this.callbacks = callbacks;
      // Set here, before the loading below reads them; null once destroyed. hls.js's Loader
      // has its context as T | null.
      /** @type {?import('../../modules/hls.mjs').LoaderConfiguration} */
      this.config = config;
      /** @type {?HlsLoadContext} */
      this.context = context;

      if (isFragment) {
        this.loadFragmentInternal();
      } else {
        this.loadNonFragmentInternal();
      }
    }

    loadFragmentInternal() {
      // A media segment's load (load's isFragment): the context load set has its frag.
      try {
        let sn = /** @type {FragmentLoaderContext} */ (this.context).frag.sn;
        if (/** @type {FragmentLoaderContext} */ (this.context).frag.sn === 'initSegment') {
          sn = -1;
        }
        const identifier = player.getIdentifier(/** @type {FragmentLoaderContext} */ (this.context).frag.trackID, /** @type {FragmentLoaderContext} */ (this.context).frag.level);
        // A segment is stored at its place in the level, not at its sequence number
        // (HLSFragmentStore). A number by here: 'initSegment' is -1.
        const index = sn === -1 ? -1 : storeIndex(player.client.getFragments(identifier), /** @type {number} */ (sn));
        let frag = index === null ? null : player.client.getFragment(identifier, index);
        // One init segment is kept per level, but a playlist can change its EXT-X-MAP:
        // the kept one is only this request's if it is the same segment.
        if (frag && sn === -1 && !isSameSegment(frag.getFrag(), /** @type {FragmentLoaderContext} */ (this.context).frag)) {
          frag = null;
        }
        // A kept media segment only for its own place (isSamePlace).
        if (frag && sn !== -1 && !isSamePlace(frag.getFrag(), /** @type {FragmentLoaderContext} */ (this.context).frag)) {
          frag = null;
        }
        if (!frag) {
          console.error('Fragment not found', identifier, /** @type {FragmentLoaderContext} */ (this.context).frag);
          this.loadNonFragmentInternal();
          return;
        }

        const activeRequests = player.activeRequests;
        const segmentKey = identifier + ':' + sn;

        const loader = player.fragmentRequester.requestFragment(frag, {
          /**
           * @param {{url: string, data: ArrayBuffer|string}} response
           * @param {LoadStats} stats
           * @param {ReturnType<import('./HLSFragment.mjs').HLSFragment['getContext']>} context
           * @param {null} xhr - FetchLoader has none.
           */
          onSuccess: (response, stats, context, xhr) => {
            segmentFailures.delete(segmentKey);
            this.copyStats(stats);
            if (this.callbacks) {
              this.callbacks.onSuccess(response, this.stats, this.context, xhr);
            }
            const index = activeRequests.indexOf(loader);
            if (index > -1) {
              activeRequests.splice(index, 1);
            }
          },
          /**
           * @param {LoadStats} stats
           * @param {ReturnType<import('./HLSFragment.mjs').HLSFragment['getContext']>} context
           * @param {ArrayBuffer|string} data
           * @param {null} xhr - FetchLoader has none.
           */
          onProgress: (stats, context, data, xhr) => {
            this.copyStats(stats);
            if (this.callbacks?.onProgress) this.callbacks.onProgress(stats, this.context, data, xhr);
          },
          /** @param {DownloadEntry} entry */
          onFail: (entry) => {
            setTimeout(() => {
              this.copyStats(entry.stats);
              this.reportFailure(segmentKey);
            }, 1000);

            const index = activeRequests.indexOf(loader);
            if (index > -1) {
              activeRequests.splice(index, 1);
            }
          },
          /** @param {DownloadEntry} entry */
          onAbort: (entry) => {
            this.copyStats(entry.stats);
            this.stats.aborted = true;
            if (this.callbacks?.onAbort) this.callbacks.onAbort(this.stats, this.context, null, null);

            const index = activeRequests.indexOf(loader);
            if (index > -1) {
              activeRequests.splice(index, 1);
            }
          },

        }, this.config, 1000);

        this.loader = loader;

        if (sn !== -1) {
          activeRequests.push(loader);
        }
      } catch (e) {
        console.error(e);
        // The load has to end one way or another: hls.js waited for this one forever.
        this.callbacks?.onError?.({code: 0, text: String(/** @type {Error|undefined} */ (e)?.message || e)}, this.context, null, this.stats);
      }
    }

    loadNonFragmentInternal() {
      // A playlist, not a key or a fragment. hls.js loads one again to see what is new.
      // The context load set.
      const isPlaylist = /** @type {HlsLoadContext} */ (this.context).frag === undefined;
      const downloadManager = player.getClient().downloadManager;
      /**
       * The download: hls.js's context and config, the source's headers over the context's,
       * and what decrypts a segment FastStream decrypts (below).
       * @type {HlsLoadContext & {config: ?import('../../modules/hls.mjs').LoaderConfiguration,
       *   headers: Object<string, string>, postProcessor?: Function}}
       */
      const details = {
        .../** @type {HlsLoadContext} */(this.context),
        config: this.config,
        headers: {
          .../** @type {HlsLoadContext} */(this.context).headers,
          ...player.source.headers,
        },
      };
      // A segment FastStream decrypts itself (HLSFragmentRequester.takeOverDecryption) that
      // the store has no place for - numbered before the level's first (a live stream that
      // started its numbering again), or the init segment of a changed EXT-X-MAP - comes
      // here still encrypted, and hls.js decrypts none of it: its own decryption was taken
      // over as well. It went to hls.js as it was, and the stream broke off from there.
      // Not a playlist: a key's context or a media segment's, each with its frag.
      const decrypt = isPlaylist ? null : player.fragmentRequester?.decryptionFor(/** @type {import('../../modules/hls.mjs').KeyLoaderContext|FragmentLoaderContext} */ (this.context).frag, details.headers);
      if (decrypt) {
        details.postProcessor = decrypt;
      }
      if (isPlaylist) {
        // A player's first load of a playlist may be answered from the store, and the copy
        // has to stay there: "dump buffer" writes the store into the archive, and a player
        // opened from an archive, or the seek preview beside the main player, finds it
        // there. hls.js loads a playlist again only to see what is new (a live stream):
        // then the stored copy is the old window, and answering with it would stop the
        // stream where that window ends.
        const key = downloadManager.getIdentifier(details);
        if (player.loadedManifests.has(key)) downloadManager.forgetCompletedFile(details);
        player.loadedManifests.add(key);
      }
      const failureKey = details.url + ':' + (details.rangeStart ?? '') + '-' + (details.rangeEnd ?? '');
      this.loader = downloadManager.getFile(details, {
        /**
         * @param {DownloadEntry} entry
         * @param {null} [xhr] - FetchLoader has none; none at all for a stored copy.
         */
        onSuccess: async (entry, xhr) => {
          segmentFailures.delete(failureKey);
          this.copyStats(entry.stats);
          let data;
          try {
            data = await entry.getDataFromBlob();
          } catch (e) {
            // Stored, and no longer there to read (DownloadEntry.onDataLost drops it, so the
            // next request downloads it again): a failure, as the download's own (onFail
            // below). The rejection went nowhere, and hls.js waited for the answer for ever.
            console.warn('Could not read a stored download', e);
            if (!this.callbacks) return;
            if (isPlaylist) {
              this.callbacks.onError?.({code: 0, text: 'Stored copy unreadable'}, this.context, null, this.stats);
            } else {
              this.reportFailure(failureKey);
            }
            return;
          }

          if (this.callbacks) {
            this.callbacks.onSuccess({
              url: entry.url,
              data: data,
            }, this.stats, this.context, null);
          }
        },
        /**
         * @param {LoadStats} stats
         * @param {Awaited<ReturnType<DownloadEntry['getRequest']>>} context2 - The request.
         * @param {ArrayBuffer|string} data
         * @param {null} xhr - FetchLoader has none.
         */
        onProgress: (stats, context2, data, xhr) => {
          this.copyStats(stats);
          if (this.callbacks?.onProgress) this.callbacks.onProgress(stats, this.context, data, xhr);
        },
        /** @param {DownloadEntry} entry */
        onFail: (entry) => {
          setTimeout(() => {
            this.copyStats(entry.stats);
            if (!this.callbacks) return;
            if (isPlaylist) {
              // hls.js's playlist loader passes no onAbort, so a failure reported as one
              // reached nobody, and the player waited forever. As an error, hls.js retries
              // the playlist, and fails the player once it gives up.
              const error = this.stats.error || {code: 0, text: 'Download failed'};
              this.callbacks.onError?.(error, this.context, null, this.stats);
            } else {
              this.reportFailure(failureKey);
            }
          }, 1000);
        },
        /** @param {DownloadEntry} entry */
        onAbort: (entry) => {
          this.copyStats(entry.stats);
          this.stats.aborted = true;
          if (this.callbacks?.onAbort) this.callbacks.onAbort(this.stats, this.context, null, null);
        },
      });
    }

    /** Abort any loading in progress. */
    abort() {
      // As hls.js's own loaders do: it reads this to tell an aborted load from a failed one.
      this.stats.aborted = true;
      if (this.loader) {
        this.loader.abort();
      }
    };

    /** Destroy loading context. */
    destroy() {
      this.callbacks = null;
      this.config = null;
      this.context = null;
      this.loader = null;
    }
  };
}
