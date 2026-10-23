// @ts-check
import {DownloadStatus} from '../enums/DownloadStatus.mjs';

/** @typedef {{getData: () => Promise<*>, getDataFromBlob: (type?: string) => Promise<*>}} Entry */

/**
 * A downloaded fragment's stored entry for a save, its data downloaded again once when it
 * is gone. A stored download can lose its data after it completed (DownloadEntry: its
 * onDataLost drops the entry) while the fragment still says downloaded, and a save read it
 * bare: it failed there every time, where the loaders download such a fragment again.
 * @param {() => Entry | null} entryOf - The download manager's entry of the fragment now.
 * @param {() => Promise<void>} downloadAgain - Downloads the fragment once more.
 * @return {Promise<{getData: () => Promise<*>, getDataFromBlob: (type?: string) => Promise<*>}>}
 *   Reads that download it again when the entry is gone, or went while it was read.
 */
export async function savedEntry(entryOf, downloadAgain) {
  const fresh = async () => {
    await downloadAgain();
    const entry = entryOf();
    if (!entry) throw new Error('The stored download is gone');
    return entry;
  };
  let entry = entryOf() || await fresh();
  /** @param {(entry: Entry) => Promise<*>} how */
  const read = async (how) => {
    try {
      return await how(entry);
    } catch (e) {
      // Only data the store lost: getDataFromBlob reported it and the entry was dropped.
      // Anything else would fail the same way after a new download.
      if (entryOf() === entry) throw e;
      entry = await fresh();
      return how(entry);
    }
  };
  return {
    getData: () => read((e) => e.getData()),
    getDataFromBlob: (type) => read((e) => e.getDataFromBlob(type)),
  };
}

/**
 * Downloads a save's fragments a few ahead of the one being converted.
 *
 * A save reads its fragments one after the other, and a fragment it did not have yet was
 * downloaded only when its turn came: saving a stream that was not buffered ran at the
 * speed of one connection, although the download manager runs several. This asks for the
 * next ones while the converter works on the current one, through the same download
 * manager and at the save's priority (-1, behind playback). `ahead` is the user's
 * downloader limit, so a save never has more downloads going than that. The converter
 * still takes the fragments in their order and reads the same bytes.
 *
 * The player pins the fragments (ReferenceTypes.SAVER) and unpins them as before; on a
 * cancel or a failure it calls cancel(), which stops what is still downloading.
 */
export class SaveFragmentFetcher {
  /**
   * @param {Object} requester the player's fragment requester (requestFragment)
   * @param {Object[]} fragments the save's fragments, in the order it reads them
   * @param {number} ahead how many may download at once, the one being read included
   */
  constructor(requester, fragments, ahead) {
    this.requester = requester;
    this.fragments = fragments;
    this.ahead = Math.max(1, Math.floor(ahead) || 1);
    // Downloads started and not yet read, by index: {promise, loader, reject}.
    this.downloads = new Map();
    this.cancelled = false;
  }

  /**
   * Waits until a fragment is downloaded, and starts the ones after it.
   * @param {number} index the fragment's place in the save
   * @return {Promise<void>} rejects with 'Cancelled' after cancel(), or with the download's
   *     failure
   */
  async get(index) {
    if (this.cancelled) {
      throw new Error('Cancelled');
    }
    const end = Math.min(index + this.ahead, this.fragments.length);
    for (let i = index; i < end; i++) {
      this.start(i);
    }
    const download = this.downloads.get(index);
    if (download) {
      try {
        await download.promise;
      } finally {
        this.downloads.delete(index);
      }
    }
  }

  /**
   * A fragment's entry once it is downloaded (get), its data downloaded again once when the
   * store lost it (savedEntry).
   * @param {number} index
   * @param {() => Object | null} entryOf - The download manager's entry of the fragment now.
   * @return {ReturnType<typeof savedEntry>}
   */
  async entry(index, entryOf) {
    await this.get(index);
    return savedEntry(entryOf, async () => {
      if (this.cancelled) {
        throw new Error('Cancelled');
      }
      /** @type {{promise: Promise<void> | null, loader: any, reject: ((e: Error) => void) | null}} */
      const download = {promise: null, loader: null, reject: null};
      download.promise = this.download(this.fragments[index], download);
      this.downloads.set(index, download);
      try {
        await download.promise;
      } finally {
        this.downloads.delete(index);
      }
    });
  }

  /**
   * Starts a fragment's download, unless it is there or on its way.
   * @param {number} index
   */
  start(index) {
    const fragment = this.fragments[index];
    if (!fragment || this.downloads.has(index) || fragment.status === DownloadStatus.DOWNLOAD_COMPLETE) {
      return;
    }
    /** @type {{promise: Promise<void> | null, loader: any, reject: ((e: Error) => void) | null}} */
    const download = {promise: null, loader: null, reject: null};
    download.promise = this.download(fragment, download);
    // One downloaded ahead is waited for when its turn comes, and fails the save then, as
    // it did when it was downloaded then; until that its failure is held here.
    /** @type {Promise<void>} */ (download.promise).catch(() => {});
    this.downloads.set(index, download);
  }

  /**
   * Downloads one fragment, as the players' downloadFragment(fragment, -1) does.
   * @param {Object} fragment
   * @param {Object} download where the request goes, for cancel()
   */
  async download(fragment, download) {
    for (;;) {
      if (this.cancelled) {
        throw new Error('Cancelled');
      }
      try {
        /** @type {PromiseWithResolvers<void>} */
        const {promise, resolve, reject} = Promise.withResolvers();
        download.reject = reject;
        download.loader = this.requester.requestFragment(fragment, {
          skipProcess: true,
          onSuccess: () => resolve(),
          onFail: () => reject(new Error('Failed to download fragment')),
          onAbort: () => reject(new Error('Aborted download')),
        }, null, -1);
        await promise;
        return;
      } catch (e) {
        // A download the manager gave up (a downloader taken away) is asked for again, as
        // the save always did.
        if (/** @type {Error} */ (e).message !== 'Aborted download') {
          throw e;
        }
      } finally {
        download.loader = null;
        download.reject = null;
      }
    }
  }

  /**
   * Stops: what is still downloading for the save is aborted (a download playback wants
   * too goes on for playback), and nothing more is started.
   */
  cancel() {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    for (const download of this.downloads.values()) {
      const reject = download.reject;
      download.loader?.abort();
      // The download manager says nothing to a request it only stopped watching (one
      // playback watches too), and the save must not wait for it.
      reject?.(new Error('Cancelled'));
    }
  }
}
