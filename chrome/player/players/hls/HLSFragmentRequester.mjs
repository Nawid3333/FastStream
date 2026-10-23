// @ts-check
import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {DownloadStatus} from '../../enums/DownloadStatus.mjs';
import {HLSDecrypter} from './HLSDecrypter.mjs';

// The encryption FastStream decrypts itself (decrypter-worker.js: AES-CBC, the key's own
// bytes): whole segments under an AES-128 or AES-256 key the playlist names. hls.js also
// hands out decryptdata for SAMPLE-AES, where only the samples are encrypted, for
// AES-256-CTR, and for the DRM key formats (Widevine, PlayReady, FairPlay); decrypting
// those as whole AES-CBC segments gave garbage or nothing, and a generic load error
// instead of the DRM message.
const DECRYPTABLE_METHODS = ['AES-128', 'AES-256'];

/** @typedef {import('../../modules/hls.mjs').Fragment} HlsFragment */
/** @typedef {import('../../network/DownloadEntry.mjs').DownloadEntry} DownloadEntry */
/** @typedef {import('../../network/FetchLoader.mjs').LoaderStats} LoaderStats */
/** @typedef {import('../../network/FetchLoader.mjs').LoaderResponse} LoaderResponse */
/** @typedef {ReturnType<import('./HLSFragment.mjs').HLSFragment['getContext']>} SegmentContext */

/**
 * What a segment's request tells (requestFragment), as hls.js's loader callbacks are told
 * (HLSLoader): the segment's URL and bytes (an ArrayBuffer: a segment is asked for as one)
 * unless skipProcess asked for none, the download's stats and the segment's request;
 * FetchLoader's progress; the entry of a failed or an aborted one.
 * @typedef {{onProgress?: (stats: LoaderStats, context: SegmentContext, data: ArrayBuffer, xhr: null) => void,
 *   onFail: (entry: DownloadEntry) => void, onAbort?: (entry: DownloadEntry) => void} & ({skipProcess?: false,
 *     onSuccess: (response: {url: string, data: ArrayBuffer}, stats: LoaderStats, context: SegmentContext, xhr: null) => void} |
 *   {skipProcess: true,
 *     onSuccess: (response: {url: string, data: undefined}, stats: LoaderStats, context: SegmentContext, xhr: null) => void})} FragmentCallbacks
 */

export class HLSFragmentRequester {
  /** @param {import('./HLSPlayer.mjs').default} player */
  constructor(player) {
    this.player = player;
    this.decrypter = new HLSDecrypter();
  }

  /**
   * Takes the decryption of a playlist's encrypted segments over from hls.js: each one's
   * key is kept as fs_oldcryptdata for requestFragment, and hls.js's own is removed, so
   * hls.js neither loads the key nor decrypts what requestFragment hands it. The same for
   * the first segment's init segment, which HLSPlayer stores as the level's fragment -1: an
   * EXT-X-KEY before the EXT-X-MAP encrypts it too (RFC 8216, 4.3.2.5), and requestFragment
   * refused it, so hls.js waited for it forever. Other init segments are not stored; HLSLoader
   * downloads them as they are, and hls.js decrypts them itself.
   * @param {HlsFragment[]} fragments - The playlist's hls.js fragments.
   * @return {boolean} False when some of them are encrypted in a way this cannot decrypt.
   */
  static takeOverDecryption(fragments) {
    let decryptable = true;
    /** @param {HlsFragment|null|undefined} frag - A fragment, or the first one's init segment. */
    const takeOver = (frag) => {
      if (!frag?.encrypted) return;
      const decryptdata = frag.decryptdata;
      if (decryptdata?.keyFormat === 'identity' && DECRYPTABLE_METHODS.includes(decryptdata.method)) {
        frag.fs_oldcryptdata = decryptdata;
        frag.fs_oldlevelKeys = frag.levelkeys;
      } else {
        decryptable = false;
      }
      // hls.js reads both as no key (Fragment.decryptdata). Its types have no null for
      // levelkeys, and keep _decryptdata private.
      /** @type {{levelkeys?: HlsFragment['levelkeys']|null}} */ (frag).levelkeys = null;
      /** @type {any} */ (frag)._decryptdata = null;
    };
    takeOver(fragments[0]?.initSegment);
    fragments.forEach(takeOver);
    return decryptable;
  }

  destroy() {
    this.decrypter.destroy();
  }

  /**
   * What decrypts a segment whose decryption this took over (fs_oldcryptdata): the key's
   * download starts now, and the postProcessor decrypts the segment's bytes with it.
   * requestFragment needs it, and so does HLSLoader's own download of such a segment, one
   * the store has no place for.
   * @param {HlsFragment} frag - The hls.js fragment.
   * @param {Object<string, string>} headers - The request headers, for the key's download too.
   * @return {?((entry: DownloadEntry, response: LoaderResponse) => Promise<LoaderResponse>)}
   *   The postProcessor for downloadManager.getFile; null for a segment this did not take over.
   */
  decryptionFor(frag, headers) {
    const decryptdata = frag?.fs_oldcryptdata;
    if (!decryptdata) {
      return null;
    }
    // The key's bytes: a raw arraybuffer download's data (storeRaw).
    /** @type {Promise<ArrayBuffer>} */
    const keyPromise = new Promise((resolve, reject) => {
      this.player.getClient().downloadManager.getFile({
        url: decryptdata.uri,
        rangeStart: 0,
        rangeEnd: 0,
        responseType: 'arraybuffer',
        storeRaw: true,
        headers,
      }, {
        /** @param {DownloadEntry} entry */
        onSuccess: async (entry) => {
          // Raw arraybuffer: the key's bytes (from an archive a Uint8Array view, which the key
          // import takes as well).
          resolve(/** @type {ArrayBuffer} */ (await entry.getData()));
        },
        /** @param {DownloadEntry} err - The key's entry. */
        onFail: (err) => {
          console.log('failed to get key', err);
          reject(err);
        },
        /** @param {DownloadEntry} err - The key's entry. */
        onAbort: (err) => {
          console.log('key aborted', err);
          reject(err);
        },
      });
    });
    return async (entry, response) => {
      const key = await keyPromise;
      if (!decryptdata.iv || !key) {
        console.error('missing decryptdata', decryptdata, key);
        this.player.emit(DefaultPlayerEvents.NEED_KEY);
        // Failed, not complete: the still-encrypted data was stored as the segment, and
        // played or saved as it was.
        throw new Error('Segment key or IV missing');
      }
      // An ArrayBuffer: a segment is asked for as one.
      response.data = await this.decrypter.decryptAES(/** @type {ArrayBuffer} */ (response.data), decryptdata.iv.buffer, key);
      return response;
    };
  }

  /**
   * Downloads a segment through the download manager, decrypting it if its decryption was
   * taken over, keeping its status and telling the player each change of it.
   * @param {import('./HLSFragment.mjs').HLSFragment} fragment
   * @param {FragmentCallbacks} callbacks
   * @param {?(Partial<import('../../modules/hls.mjs').LoaderConfiguration> & {headers?: Object<string, string>})} config -
   *   hls.js's loader config (HLSLoader), or null for the default; any headers in it go under
   *   the source's.
   * @param {number} priority - In the download manager's queue, higher first.
   * @return {ReturnType<import('../../network/DownloadManager.mjs').DownloadManager['getFile']>}
   */
  requestFragment(fragment, callbacks, config, priority) {
    const context = fragment.getContext();
    config = config || {};

    const frag = fragment.getFrag();

    // Before the fragment is marked as downloading: it stayed marked for good, and was
    // never asked for again.
    if (frag.decryptdata) {
      throw new Error('unexpected decryptdata');
    }

    if (fragment.status === DownloadStatus.WAITING) {
      fragment.status = DownloadStatus.DOWNLOAD_INITIATED;
      this.player.emit(DefaultPlayerEvents.FRAGMENT_UPDATE, fragment);
    }

    const headers = {
      ...config.headers,
      // Set: fragments are asked for once the player has its source.
      ...(/** @type {import('../../VideoSource.mjs').VideoSource} */ (this.player.source)).headers,
    };
    const decrypt = this.decryptionFor(frag, headers);

    const loader = this.player.getClient().downloadManager.getFile({
      ...context,
      config,
      headers,
      postProcessor: decrypt || (async (entry, response) => response),
    }, {
      /**
       * @param {DownloadEntry} entry
       * @param {null} [xhr] - FetchLoader has none; none at all for a stored copy.
       */
      onSuccess: async (entry, xhr) => {
        /** @type {ArrayBuffer|undefined} */
        let data;
        try {
          if (!callbacks.skipProcess) {
            // An ArrayBuffer: a segment is asked for as one (HLSFragment.getContext).
            data = /** @type {ArrayBuffer} */ (await entry.getDataFromBlob());
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
        // The data is there exactly when skipProcess did not ask for none (FragmentCallbacks).
        /** @type {(response: {url: string, data: ArrayBuffer|undefined}, stats: LoaderStats, context: SegmentContext, xhr: null) => void} */ (callbacks.onSuccess)({
          url: entry.url,
          data: data,
        }, /** @type {LoaderStats} */ (entry.stats), context, null); // set on success
      },
      /**
       * @param {LoaderStats} stats
       * @param {import('../../network/DownloadEntry.mjs').DownloadRequest} context2 - The request.
       * @param {ArrayBuffer|string} data
       * @param {null} xhr - FetchLoader has none.
       */
      onProgress: (stats, context2, data, xhr) => {
        // An ArrayBuffer: a segment is asked for as one.
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
