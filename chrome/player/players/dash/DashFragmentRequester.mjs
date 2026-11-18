// @ts-check
import {sourceHeadersFor} from '../../VideoSource.mjs';
import {fragmentDownloadCallbacks, markRequested} from '../FragmentStatus.mjs';

/** @typedef {import('../../network/DownloadEntry.mjs').DownloadEntry} DownloadEntry */

/**
 * @typedef {{skipProcess?: boolean,
 *   onSuccess: (entry: DownloadEntry, data: ArrayBuffer|string|undefined) => void,
 *   onProgress?: (stats: import('../../network/FetchLoader.mjs').FetchLoader['stats'],
 *     context: ReturnType<import('./DashFragment.mjs').DashFragment['getContext']>,
 *     data: ArrayBuffer|string, xhr: null) => void,
 *   onFail: (entry: DownloadEntry) => void, onAbort?: (entry: DownloadEntry) => void}} FragmentCallbacks
 */

export class DashFragmentRequester {
  /** @param {import('./DashPlayer.mjs').default} player */
  constructor(player) {
    this.player = player;
  }

  /**
   * @param {import('./DashFragment.mjs').DashFragment} fragment
   * @param {FragmentCallbacks} callbacks
   * @param {?{headers?: Object<string, string>}} config - Null for the default.
   * @param {number} priority - Higher first.
   * @return {ReturnType<import('../../network/DownloadManager.mjs').DownloadManager['getFile']>}
   */
  requestFragment(fragment, callbacks, config, priority) {
    const context = fragment.getContext();
    config = config || {};

    markRequested(this.player, fragment);

    return this.player.getClient().downloadManager.getFile({
      ...context,
      config,
      headers: {
        ...config.headers,
        // Login headers only to the source's own site (VideoSource.headersFor).
        ...sourceHeadersFor(/** @type {import('../../VideoSource.mjs').VideoSource} */ (this.player.source), context.url),
      },
    }, {
      ...fragmentDownloadCallbacks(this.player, fragment, callbacks, (entry, data) => callbacks.onSuccess(entry, data)),
      /**
       * @param {import('../../network/FetchLoader.mjs').FetchLoader['stats']} stats
       * @param {Awaited<ReturnType<DownloadEntry['getRequest']>>} context2
       * @param {ArrayBuffer|string} data
       * @param {null} xhr
       */
      onProgress: (stats, context2, data, xhr) => {
        if (callbacks.onProgress) callbacks.onProgress(stats, context, data, xhr);
      },
    }, priority);
  }
}
