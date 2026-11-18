// @ts-check
import {DefaultPlayerEvents} from '../enums/DefaultPlayerEvents.mjs';
import {DownloadStatus} from '../enums/DownloadStatus.mjs';
import {describeLoadError} from '../utils/PlayerErrorUtils.mjs';

/** @typedef {import('../network/DownloadEntry.mjs').DownloadEntry} DownloadEntry */
/** @typedef {import('./Fragment.mjs').Fragment} Fragment */
/** @typedef {{emit: (event: string, ...args: any[]) => any}} FragmentPlayer */

/**
 * @param {FragmentPlayer} player
 * @param {Fragment} fragment
 * @param {number} status
 */
function setStatus(player, fragment, status) {
  fragment.status = status;
  player.emit(DefaultPlayerEvents.FRAGMENT_UPDATE, fragment);
}

/**
 * @param {FragmentPlayer} player
 * @param {Fragment} fragment
 */
export function markRequested(player, fragment) {
  if (fragment.status === DownloadStatus.WAITING) {
    setStatus(player, fragment, DownloadStatus.DOWNLOAD_INITIATED);
  }
}

/**
 * A read that fails counts as a failed download; an aborted one leaves the fragment waiting.
 * @param {FragmentPlayer} player
 * @param {Fragment} fragment
 * @param {{skipProcess?: boolean, onFail: (entry: DownloadEntry) => void,
 *   onAbort?: (entry: DownloadEntry) => void}} callbacks
 * @param {(entry: DownloadEntry, data: Awaited<ReturnType<DownloadEntry['getDataFromBlob']>>|undefined) => void} succeed
 * @return {{onSuccess: (entry: DownloadEntry) => Promise<void>, onFail: (entry: DownloadEntry) => void,
 *   onAbort: (entry: DownloadEntry) => void}}
 */
export function fragmentDownloadCallbacks(player, fragment, callbacks, succeed) {
  return {
    onSuccess: async (entry) => {
      let data;
      try {
        if (!callbacks.skipProcess) {
          data = await entry.getDataFromBlob();
        }
        fragment.dataSize = entry.dataSize;
      } catch (e) {
        console.error(e);
        fragment.failure = /** @type {Error} */ (e)?.message || 'stored data unreadable';
        setStatus(player, fragment, DownloadStatus.DOWNLOAD_FAILED);
        callbacks.onFail(entry);
        return;
      }
      if (fragment.status !== DownloadStatus.DOWNLOAD_COMPLETE) {
        setStatus(player, fragment, DownloadStatus.DOWNLOAD_COMPLETE);
      }
      succeed(entry, data);
    },
    onFail: (entry) => {
      fragment.failure = describeLoadError(entry.stats?.error);
      setStatus(player, fragment, DownloadStatus.DOWNLOAD_FAILED);
      callbacks.onFail(entry);
    },
    onAbort: (entry) => {
      setStatus(player, fragment, DownloadStatus.WAITING);
      callbacks.onAbort?.(entry);
    },
  };
}
