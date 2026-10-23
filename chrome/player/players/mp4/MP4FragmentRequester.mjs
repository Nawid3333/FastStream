// @ts-check
import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {DownloadStatus} from '../../enums/DownloadStatus.mjs';

/** @typedef {import('../../network/DownloadEntry.mjs').DownloadEntry} DownloadEntry */
/** @typedef {import('../../modules/mp4box/mp4box.all.mjs').MP4BoxBuffer} MP4BoxBuffer */
/** @typedef {import('./MP4Fragment.mjs').MP4Fragment} MP4Fragment */

/**
 * What a range's request tells (requestFragment): the entry once it is stored, with the
 * range's bytes at their place in the file (fileStart) unless skipProcess asked for none;
 * FetchLoader's progress, with the range's request and its body (an ArrayBuffer: a range is
 * asked for as one); the entry of a failed or an aborted one.
 * @typedef {{onProgress?: (stats: import('../../network/FetchLoader.mjs').LoaderStats,
 *     context: ReturnType<MP4Fragment['getContext']>, data: ArrayBuffer, xhr: null) => void,
 *   onFail: (entry: DownloadEntry) => void, onAbort?: (entry: DownloadEntry) => void} & (
 *   {skipProcess?: false, onSuccess: (entry: DownloadEntry, data: MP4BoxBuffer) => void} |
 *   {skipProcess: true, onSuccess: (entry: DownloadEntry, data: undefined) => void})} FragmentCallbacks
 */

export class MP4FragmentRequester {
  /** @param {import('./MP4Player.mjs').default} player */
  constructor(player) {
    this.player = player;
  }

  /**
   * Downloads a range through the download manager, keeping its status and telling the
   * player each change of it.
   * @param {MP4Fragment} fragment
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
        // Set: the player's ranges are made from its source (setSource).
        .../** @type {import('../../VideoSource.mjs').VideoSource} */(this.player.source).headers,
      },
    }, {
      /**
       * @param {DownloadEntry} entry
       * @param {null} [xhr] - FetchLoader has none; none at all for a stored copy.
       */
      onSuccess: async (entry, xhr) => {
        /** @type {MP4BoxBuffer|undefined} */
        let data;
        try {
          if (!callbacks.skipProcess) {
            // An ArrayBuffer (a range is asked for as one), an MP4BoxBuffer once its
            // fileStart is set below.
            data = /** @type {MP4BoxBuffer} */ (await entry.getDataFromBlob());
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
          this.player.emit(DefaultPlayerEvents.FRAGMENT_UPDATE, fragment);
        }
        // A range's entry has its start (MP4Fragment.getContext).
        if (data) data.fileStart = /** @type {number} */ (entry.rangeStart);
        // The data is there exactly when skipProcess did not ask for none (FragmentCallbacks).
        /** @type {(entry: DownloadEntry, data: MP4BoxBuffer|undefined) => void} */ (callbacks.onSuccess)(entry, data);
      },
      /**
       * @param {import('../../network/FetchLoader.mjs').LoaderStats} stats
       * @param {import('../../network/DownloadEntry.mjs').DownloadRequest} context2 - The request.
       * @param {ArrayBuffer|string} data
       * @param {null} xhr - FetchLoader has none.
       */
      onProgress: (stats, context2, data, xhr) => {
        // An ArrayBuffer: a range is asked for as one.
        if (callbacks.onProgress) callbacks.onProgress(stats, context, /** @type {ArrayBuffer} */ (data), xhr);
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
