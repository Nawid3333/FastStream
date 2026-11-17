// @ts-check
import {DefaultPlayerEvents} from '../enums/DefaultPlayerEvents.mjs';
import {DownloadStatus} from '../enums/DownloadStatus.mjs';

/** @typedef {import('../network/DownloadEntry.mjs').DownloadEntry} DownloadEntry */
/** @typedef {import('./Fragment.mjs').Fragment} Fragment */
/** @typedef {{emit: (event: string, ...args: any[]) => any}} FragmentPlayer */

// A fragment's download status, kept and told to its player at each change: what the DASH,
// HLS and MP4 fragment requesters share.

/**
 * Sets a fragment's status and tells its player.
 * @param {FragmentPlayer} player
 * @param {Fragment} fragment
 * @param {number} status - A DownloadStatus.
 */
function setStatus(player, fragment, status) {
  fragment.status = status;
  player.emit(DefaultPlayerEvents.FRAGMENT_UPDATE, fragment);
}

/**
 * A waiting fragment is downloading now; one in any other state is left as it is.
 * @param {FragmentPlayer} player
 * @param {Fragment} fragment
 */
export function markRequested(player, fragment) {
  if (fragment.status === DownloadStatus.WAITING) {
    setStatus(player, fragment, DownloadStatus.DOWNLOAD_INITIATED);
  }
}

/**
 * The download's onSuccess, onFail and onAbort for a fragment: the stored data read back
 * (unless skipProcess asks for none) and the fragment complete, then `succeed`; a read that
 * fails counts as a failed download. A failed download leaves the fragment failed, an aborted
 * one waiting (it is asked for again).
 * @param {FragmentPlayer} player
 * @param {Fragment} fragment
 * @param {{skipProcess?: boolean, onFail: (entry: DownloadEntry) => void,
 *   onAbort?: (entry: DownloadEntry) => void}} callbacks - The requester's caller's.
 * @param {(entry: DownloadEntry, data: Awaited<ReturnType<DownloadEntry['getDataFromBlob']>>|undefined) => void} succeed -
 *   Told once the data is read: the requester hands it on in its player's form.
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
      setStatus(player, fragment, DownloadStatus.DOWNLOAD_FAILED);
      callbacks.onFail(entry);
    },
    onAbort: (entry) => {
      setStatus(player, fragment, DownloadStatus.WAITING);
      callbacks.onAbort?.(entry);
    },
  };
}
