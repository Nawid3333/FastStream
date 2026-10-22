// @ts-check
import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {DownloadStatus} from '../../enums/DownloadStatus.mjs';

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
   * @param player - The DashPlayer. Left untyped: requestFragment asks it for
   *   preProcessFragment and postProcessFragment, which no player has.
   */
  constructor(player) {
    this.player = player;
  }

  /**
   * Downloads a fragment through the download manager, keeping its status and telling the
   * player each change of it.
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

    if (fragment.status === DownloadStatus.WAITING) {
      fragment.status = DownloadStatus.DOWNLOAD_INITIATED;
      this.player.emit(DefaultPlayerEvents.FRAGMENT_UPDATE, fragment);
    }

    const loader = this.player.getClient().downloadManager.getFile({
      ...context,
      config,
      headers: {
        ...config.headers,
        ...this.player.source.headers,
      },
      /**
       * @param {DownloadEntry} entry
       * @param {Awaited<ReturnType<DownloadEntry['getRequest']>>} request - The request it makes.
       */
      preProcessor: async (entry, request) => {
        if (this.player.preProcessFragment) {
          const startTime = fragment.start;
          const isInit = fragment.sn === -1;
          return await this.player.preProcessFragment(entry, request, startTime, isInit);
        }
        return request;
      },
      /**
       * @param {DownloadEntry} entry
       * @param {{url: string, status: number, headers: Object<string, string>, data: ArrayBuffer|string}} response -
       *   FetchLoader's answer.
       */
      postProcessor: async (entry, response) => {
        if (this.player.postProcessFragment) {
          const startTime = fragment.start;
          const isInit = fragment.sn === -1;
          return await this.player.postProcessFragment(entry, response, startTime, isInit);
        }
        return response;
      },
    }, {
      /**
       * @param {DownloadEntry} entry
       * @param {null} [xhr] - FetchLoader has none; none at all for a stored copy.
       */
      onSuccess: async (entry, xhr) => {
        let data;
        try {
          if (!callbacks.skipProcess) {
            data = await entry.getDataFromBlob();
          }
          fragment.dataSize = entry.dataSize;
        } catch (e) {
          console.error(e);
          fragment.status = DownloadStatus.DOWNLOAD_FAILED;
          this.player.emit(DefaultPlayerEvents.FRAGMENT_UPDATE, fragment);
          callbacks.onFail(entry);
          return;
        }
        if (fragment.status !== DownloadStatus.DOWNLOAD_COMPLETE) {
          fragment.status = DownloadStatus.DOWNLOAD_COMPLETE;
          //    console.log(fragment)
          this.player.emit(DefaultPlayerEvents.FRAGMENT_UPDATE, fragment);
        }
        callbacks.onSuccess(entry, data);
      },
      /**
       * @param {import('../../network/FetchLoader.mjs').FetchLoader['stats']} stats
       * @param {Awaited<ReturnType<DownloadEntry['getRequest']>>} context2 - The request.
       * @param {ArrayBuffer|string} data
       * @param {null} xhr - FetchLoader has none.
       */
      onProgress: (stats, context2, data, xhr) => {
        if (callbacks.onProgress) callbacks.onProgress(stats, context, data, xhr);
      },
      /** @param {DownloadEntry} entry */
      onFail: (entry) => {
        fragment.status = DownloadStatus.DOWNLOAD_FAILED;
        this.player.emit(DefaultPlayerEvents.FRAGMENT_UPDATE, fragment);
        callbacks.onFail(entry);
      },
      /** @param {DownloadEntry} entry */
      onAbort: (entry) => {
        fragment.status = DownloadStatus.WAITING;
        this.player.emit(DefaultPlayerEvents.FRAGMENT_UPDATE, fragment);
        if (callbacks.onAbort) callbacks.onAbort(entry);
      },
    }, priority);

    return loader;
  }
}
