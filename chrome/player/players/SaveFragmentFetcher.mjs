// @ts-check
import {DownloadStatus} from '../enums/DownloadStatus.mjs';

/** @typedef {{getData: () => Promise<*>, getDataFromBlob: (type?: string) => Promise<*>}} Entry */

/**
 * @typedef {{requestFragment(fragment: import('./Fragment.mjs').Fragment, callbacks: {skipProcess?: boolean,
 *   onSuccess: () => void, onFail: () => void, onAbort: () => void}, config: null, priority: number): ReturnType<import('../network/DownloadManager.mjs').DownloadManager['getFile']>}} FragmentRequester
 */

/**
 * @typedef {{promise: Promise<void> | null, loader: ReturnType<import('../network/DownloadManager.mjs').DownloadManager['getFile']> | null, reject: ((e: Error) => void) | null}} SaveDownload
 */

/**
 * Its data downloaded again once when the store lost it after the download completed.
 * @param {() => Entry | null} entryOf
 * @param {() => Promise<void>} downloadAgain
 * @return {Promise<{getData: () => Promise<*>, getDataFromBlob: (type?: string) => Promise<*>}>}
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
      // Only data the store lost: anything else would fail the same way after a new download.
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

/** Downloads a save's fragments a few ahead of the one being converted, at the save's priority (-1). */
export class SaveFragmentFetcher {
  /**
   * @param {FragmentRequester} requester
   * @param {Array<import('./Fragment.mjs').Fragment>} fragments
   * @param {number} ahead - How many may download at once, the one being read included.
   */
  constructor(requester, fragments, ahead) {
    this.requester = requester;
    this.fragments = fragments;
    this.ahead = Math.max(1, Math.floor(ahead) || 1);
    /** @type {Map<number, SaveDownload>} */
    this.downloads = new Map();
    this.cancelled = false;
  }

  /**
   * @param {number} index
   * @return {Promise<void>} Rejects with 'Cancelled' after cancel(), or with the download's failure.
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
   * @param {number} index
   * @param {() => Entry | null} entryOf
   * @return {ReturnType<typeof savedEntry>}
   */
  async entry(index, entryOf) {
    await this.get(index);
    return savedEntry(entryOf, async () => {
      if (this.cancelled) {
        throw new Error('Cancelled');
      }
      /** @type {SaveDownload} */
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

  /** @param {number} index */
  start(index) {
    const fragment = this.fragments[index];
    if (!fragment || this.downloads.has(index) || fragment.status === DownloadStatus.DOWNLOAD_COMPLETE) {
      return;
    }
    /** @type {SaveDownload} */
    const download = {promise: null, loader: null, reject: null};
    download.promise = this.download(fragment, download);
    // Its failure is held here until its turn comes.
    /** @type {Promise<void>} */ (download.promise).catch(() => {});
    this.downloads.set(index, download);
  }

  /**
   * @param {import('./Fragment.mjs').Fragment} fragment
   * @param {SaveDownload} download
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
        // A download the manager gave up (a downloader taken away) is asked for again.
        if (/** @type {Error} */ (e).message !== 'Aborted download') {
          throw e;
        }
      } finally {
        download.loader = null;
        download.reject = null;
      }
    }
  }

  /** A download playback wants too goes on for playback. */
  cancel() {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    for (const download of this.downloads.values()) {
      const reject = download.reject;
      download.loader?.abort();
      // The manager says nothing to a request it only stopped watching.
      reject?.(new Error('Cancelled'));
    }
  }
}
