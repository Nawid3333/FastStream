// @ts-check
import {STALL_TIMEOUT_MS} from '../../network/FetchLoader.mjs';
import {sourceHeadersFor} from '../../VideoSource.mjs';
import {storeIndex} from './HLSFragmentStore.mjs';

// Failures in a row of one segment before hls.js hears an error; until then it hears an abort and asks again.
const SEGMENT_FAILURES_BEFORE_ERROR = 3;

/** @typedef {import('../../modules/hls.mjs').Fragment} HlsFragment */
/** @typedef {import('../../modules/hls.mjs').FragmentLoaderContext} FragmentLoaderContext */
/** @typedef {import('../../network/DownloadEntry.mjs').DownloadEntry} DownloadEntry */
/** @typedef {import('../../network/FetchLoader.mjs').FetchLoader['stats']} LoadStats */

/**
 * @typedef {import('../../modules/hls.mjs').LoaderContext & {frag?: HlsFragment,
 *   keyInfo?: import('../../modules/hls.mjs').KeyLoaderInfo}} HlsLoadContext
 */

/**
 * @typedef {import('../../modules/hls.mjs').LoaderCallbacks<HlsLoadContext> & {
 *   onAbort?: (stats: import('../../modules/hls.mjs').LoaderStats, context: HlsLoadContext, networkDetails: null, extra: null) => void
 * }} HlsLoaderCallbacks
 */

/**
 * @param {HlsFragment} a
 * @param {HlsFragment} b
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
 * Whether a stored segment is still the one a request names, after a live stream renumbered.
 * Another only when its address without the query and its place (start, duration) both differ.
 * @param {HlsFragment} stored
 * @param {HlsFragment} frag
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

/** @param {import('./HLSPlayer.mjs').default} player */
export function HLSLoaderFactory(player) {
  // Failures in a row, per segment, for this player; a success forgets them.
  /** @type {Map<string, number>} */
  const segmentFailures = new Map();

  return class HLSLoader {
    constructor() {
      // hls.js's LoadStats shape: hls.js reads it before any download has reported.
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
     * An abort the first times the same one fails (hls.js asks again), an error from then on.
     * @param {string} key
     */
    reportFailure(key) {
      const failures = (segmentFailures.get(key) || 0) + 1;
      segmentFailures.set(key, failures);
      if (!this.callbacks) return;
      if (failures < SEGMENT_FAILURES_BEFORE_ERROR) {
        this.stats.aborted = true;
        this.callbacks.onAbort?.(this.stats, /** @type {HlsLoadContext} */ (this.context), null, null);
        return;
      }
      const error = this.stats.error || {code: 0, text: 'Download failed'};
      this.callbacks.onError?.(error, /** @type {HlsLoadContext} */ (this.context), null, this.stats);
    }

    /** @param {LoadStats|undefined} stats - A download's; none copies nothing. */
    copyStats(stats) {
      for (const key in stats) {
        if (Object.hasOwn(stats, key)) {
          /** @type {Object<string, *>} */ (this.stats)[key] = /** @type {Object<string, *>} */ (stats)[key];
        }
      }
    }

    /**
     * @param {HlsLoadContext} context
     * @param {import('../../modules/hls.mjs').LoaderConfiguration} config
     * @param {HlsLoaderCallbacks} callbacks
     */
    load(context, config, callbacks) {
      const isFragment = context.frag !== undefined && context.keyInfo === undefined;

      this.callbacks = callbacks;
      // Set before the loading below reads them; null once destroyed.
      // hls.js's timeout caps a whole load, FetchLoader's the time nothing comes: capped at STALL_TIMEOUT_MS.
      /** @type {?import('../../modules/hls.mjs').LoaderConfiguration} */
      this.config = config ? {...config, timeout: Math.min(config.timeout ?? STALL_TIMEOUT_MS, STALL_TIMEOUT_MS)} : config;
      /** @type {?HlsLoadContext} */
      this.context = context;

      if (isFragment) {
        this.loadFragmentInternal();
      } else {
        this.loadNonFragmentInternal();
      }
    }

    loadFragmentInternal() {
      try {
        let sn = /** @type {FragmentLoaderContext} */ (this.context).frag.sn;
        if (/** @type {FragmentLoaderContext} */ (this.context).frag.sn === 'initSegment') {
          sn = -1;
        }
        const identifier = player.getIdentifier(/** @type {FragmentLoaderContext} */ (this.context).frag.trackID, /** @type {FragmentLoaderContext} */ (this.context).frag.level);
        // Stored at its place in the level (HLSFragmentStore), not its sequence number; 'initSegment' is -1.
        const index = sn === -1 ? -1 : storeIndex(/** @type {import('./HLSFragmentStore.mjs').FragmentStore|undefined} */ (player.client.getFragments(identifier)), /** @type {number} */ (sn));
        let frag = index === null ? null : /** @type {import('./HLSFragment.mjs').HLSFragment|null|undefined} */ (player.client.getFragment(identifier, index));
        // One init segment is kept per level, but a playlist can change its EXT-X-MAP.
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
           * @param {null} xhr
           */
          onSuccess: (response, stats, context, xhr) => {
            segmentFailures.delete(segmentKey);
            this.copyStats(stats);
            if (this.callbacks) {
              this.callbacks.onSuccess(response, this.stats, /** @type {HlsLoadContext} */ (this.context), xhr);
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
           * @param {null} xhr
           */
          onProgress: (stats, context, data, xhr) => {
            this.copyStats(stats);
            if (this.callbacks?.onProgress) this.callbacks.onProgress(stats, /** @type {HlsLoadContext} */ (this.context), data, xhr);
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
            if (this.callbacks?.onAbort) this.callbacks.onAbort(this.stats, /** @type {HlsLoadContext} */ (this.context), null, null);

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
        this.callbacks?.onError?.({code: 0, text: String(/** @type {Error|undefined} */ (e)?.message || e)}, /** @type {HlsLoadContext} */ (this.context), null, this.stats);
      }
    }

    loadNonFragmentInternal() {
      // A playlist, not a key or a fragment: hls.js loads one again to see what is new.
      const isPlaylist = /** @type {HlsLoadContext} */ (this.context).frag === undefined;
      const downloadManager = player.getClient().downloadManager;
      /**
       * @type {HlsLoadContext & {config: ?import('../../modules/hls.mjs').LoaderConfiguration,
       *   headers: Object<string, string>, postProcessor?: (entry: DownloadEntry, response: import('../../network/FetchLoader.mjs').LoaderResponse) => Promise<import('../../network/FetchLoader.mjs').LoaderResponse>}}
       */
      const details = {
        .../** @type {HlsLoadContext} */(this.context),
        config: this.config,
        headers: {
          .../** @type {HlsLoadContext} */(this.context).headers,
          // Login headers only to the source's own site (VideoSource.headersFor).
          ...sourceHeadersFor(/** @type {import('../../VideoSource.mjs').VideoSource} */ (player.source), /** @type {HlsLoadContext} */ (this.context).url),
        },
      };
      // A taken-over segment the store has no place for is decrypted here: hls.js decrypts none.
      const decrypt = isPlaylist ? null : player.fragmentRequester?.decryptionFor(/** @type {import('../../modules/hls.mjs').KeyLoaderContext|FragmentLoaderContext} */ (this.context).frag, details.headers);
      if (decrypt) {
        details.postProcessor = decrypt;
      }
      if (isPlaylist) {
        // A first load may come from the store (archives, the seek preview); a live refresh must not.
        const key = downloadManager.getIdentifier(details);
        if (player.loadedManifests.has(key)) downloadManager.forgetCompletedFile(details);
        player.loadedManifests.add(key);
      }
      const failureKey = details.url + ':' + (details.rangeStart ?? '') + '-' + (details.rangeEnd ?? '');
      this.loader = downloadManager.getFile(details, {
        /**
         * @param {DownloadEntry} entry
         * @param {null} [xhr]
         */
        onSuccess: async (entry, xhr) => {
          segmentFailures.delete(failureKey);
          this.copyStats(entry.stats);
          let data;
          try {
            data = await entry.getDataFromBlob();
          } catch (e) {
            // Stored and no longer readable (onDataLost drops it): a failure, as the download's own.
            console.warn('Could not read a stored download', e);
            if (!this.callbacks) return;
            if (isPlaylist) {
              this.callbacks.onError?.({code: 0, text: 'Stored copy unreadable'}, /** @type {HlsLoadContext} */ (this.context), null, this.stats);
            } else {
              this.reportFailure(failureKey);
            }
            return;
          }

          if (this.callbacks) {
            this.callbacks.onSuccess({
              url: entry.url,
              data: data,
            }, this.stats, /** @type {HlsLoadContext} */ (this.context), null);
          }
        },
        /**
         * @param {LoadStats} stats
         * @param {Awaited<ReturnType<DownloadEntry['getRequest']>>} context2
         * @param {ArrayBuffer|string} data
         * @param {null} xhr
         */
        onProgress: (stats, context2, data, xhr) => {
          this.copyStats(stats);
          if (this.callbacks?.onProgress) this.callbacks.onProgress(stats, /** @type {HlsLoadContext} */ (this.context), data, xhr);
        },
        /** @param {DownloadEntry} entry */
        onFail: (entry) => {
          setTimeout(() => {
            this.copyStats(entry.stats);
            if (!this.callbacks) return;
            if (isPlaylist) {
              // hls.js's playlist loader passes no onAbort: a failure goes as an error, which hls.js retries.
              const error = this.stats.error || {code: 0, text: 'Download failed'};
              this.callbacks.onError?.(error, /** @type {HlsLoadContext} */ (this.context), null, this.stats);
            } else {
              this.reportFailure(failureKey);
            }
          }, 1000);
        },
        /** @param {DownloadEntry} entry */
        onAbort: (entry) => {
          this.copyStats(entry.stats);
          this.stats.aborted = true;
          if (this.callbacks?.onAbort) this.callbacks.onAbort(this.stats, /** @type {HlsLoadContext} */ (this.context), null, null);
        },
      });
    }

    abort() {
      // As hls.js's own loaders do: it reads this to tell an aborted load from a failed one.
      this.stats.aborted = true;
      if (this.loader) {
        // Out of the player's loading list: the download tells only its last watcher of an abort.
        const index = player.activeRequests.indexOf(this.loader);
        if (index > -1) {
          player.activeRequests.splice(index, 1);
        }
        this.loader.abort();
      }
    };

    destroy() {
      this.callbacks = null;
      this.config = null;
      this.context = null;
      this.loader = null;
    }
  };
}
