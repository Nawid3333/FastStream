// @ts-check
import {fragmentDownloadCallbacks, markRequested} from '../FragmentStatus.mjs';

/** @typedef {import('../../network/DownloadEntry.mjs').DownloadEntry} DownloadEntry */

/**
 * What a fragment's request tells (requestFragment): the download's entry once it is
 * stored, with its data unless skipProcess asked for none; FetchLoader's progress, with the
 * fragment's context; the entry of a failed or an aborted one.
 * @typedef {{skipProcess?: boolean,
 *   onSuccess: (entry: DownloadEntry, data: ArrayBuffer|string|undefined) => void,
 *   onProgress?: (stats: import('../../network/FetchLoader.mjs').FetchLoader['stats'],
 *     context: ReturnType<import('./DashFragment.mjs').DashFragment['getContext']>,
 *     data: ArrayBuffer|string, xhr: null) => void,
 *   onFail: (entry: DownloadEntry) => void, onAbort?: (entry: DownloadEntry) => void}} FragmentCallbacks
 */

export class DashFragmentRequester {
  /**
   * @param {import('./DashPlayer.mjs').default} player
   */
  constructor(player) {
    this.player = player;
  }

  /**
   * Downloads a fragment through the download manager, keeping its status and telling the
   * player each change of it (FragmentStatus.mjs).
   * @param {import('./DashFragment.mjs').DashFragment} fragment
   * @param {FragmentCallbacks} callbacks
   * @param {?{headers?: Object<string, string>}} config - The download's config (null for
   *   the default), its headers under the source's.
   * @param {number} priority - In the download manager's queue, higher first.
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
        // Set: fragments are asked for only once the player has its source.
        ...(/** @type {import('../../VideoSource.mjs').VideoSource} */ (this.player.source)).headers,
      },
    }, {
      ...fragmentDownloadCallbacks(this.player, fragment, callbacks, (entry, data) => callbacks.onSuccess(entry, data)),
      /**
       * @param {import('../../network/FetchLoader.mjs').FetchLoader['stats']} stats
       * @param {Awaited<ReturnType<DownloadEntry['getRequest']>>} context2 - The request.
       * @param {ArrayBuffer|string} data
       * @param {null} xhr - FetchLoader has none.
       */
      onProgress: (stats, context2, data, xhr) => {
        if (callbacks.onProgress) callbacks.onProgress(stats, context, data, xhr);
      },
    }, priority);
  }
}
