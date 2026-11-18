// @ts-check
import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {isDecryptable} from '../../utils/Decryptable.mjs';
import {sourceHeadersFor} from '../../VideoSource.mjs';
import {fragmentDownloadCallbacks, markRequested} from '../FragmentStatus.mjs';
import {HLSDecrypter} from './HLSDecrypter.mjs';

/** @typedef {import('../../modules/hls.mjs').Fragment} HlsFragment */
/** @typedef {import('../../network/DownloadEntry.mjs').DownloadEntry} DownloadEntry */
/** @typedef {import('../../network/FetchLoader.mjs').LoaderStats} LoaderStats */
/** @typedef {import('../../network/FetchLoader.mjs').LoaderResponse} LoaderResponse */
/** @typedef {ReturnType<import('./HLSFragment.mjs').HLSFragment['getContext']>} SegmentContext */

/**
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
   * Takes over decrypting a playlist's segments, and the first's init segment (EXT-X-KEY before EXT-X-MAP).
   * @param {HlsFragment[]} fragments
   * @return {boolean} False when some are encrypted in a way this cannot decrypt.
   */
  static takeOverDecryption(fragments) {
    let decryptable = true;
    /** @param {HlsFragment|null|undefined} frag */
    const takeOver = (frag) => {
      if (!frag?.encrypted) return;
      const decryptdata = frag.decryptdata;
      // The rule the background's read of the playlist goes by too (StreamLength.hlsProtected).
      if (decryptdata && isDecryptable(decryptdata.method, decryptdata.keyFormat)) {
        frag.fs_oldcryptdata = decryptdata;
        frag.fs_oldlevelKeys = frag.levelkeys;
      } else {
        decryptable = false;
      }
      // hls.js reads both as no key; its types have no null for levelkeys and keep _decryptdata private.
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
   * The postProcessor that decrypts a taken-over segment; HLSLoader's own download of one needs it too.
   * @param {HlsFragment} frag
   * @param {Object<string, string>} headers - For the key's download too.
   * @return {?((entry: DownloadEntry, response: LoaderResponse) => Promise<LoaderResponse>)}
   */
  decryptionFor(frag, headers) {
    const decryptdata = frag?.fs_oldcryptdata;
    if (!decryptdata) {
      return null;
    }
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
          // From an archive a Uint8Array view, which the key import takes as well.
          resolve(/** @type {ArrayBuffer} */ (await entry.getData()));
        },
        /** @param {DownloadEntry} err */
        onFail: (err) => {
          console.log('failed to get key', err);
          reject(err);
        },
        /** @param {DownloadEntry} err */
        onAbort: (err) => {
          console.log('key aborted', err);
          reject(err);
        },
      });
    });
    // Handled where it is awaited: a segment aborted or answered from the store never awaits it.
    keyPromise.catch(() => {});
    return async (entry, response) => {
      const key = await keyPromise;
      if (!decryptdata.iv || !key) {
        console.error('missing decryptdata', decryptdata, key);
        this.player.emit(DefaultPlayerEvents.NEED_KEY);
        // Failed, not complete: else the encrypted data is stored as the segment.
        throw new Error('Segment key or IV missing');
      }
      response.data = await this.decrypter.decryptAES(/** @type {ArrayBuffer} */ (response.data), decryptdata.iv.buffer, key);
      return response;
    };
  }

  /**
   * @param {import('./HLSFragment.mjs').HLSFragment} fragment
   * @param {FragmentCallbacks} callbacks
   * @param {?(Partial<import('../../modules/hls.mjs').LoaderConfiguration> & {headers?: Object<string, string>})} config - hls.js's loader config, or null; its headers go under the source's.
   * @param {number} priority - Higher first.
   * @return {ReturnType<import('../../network/DownloadManager.mjs').DownloadManager['getFile']>}
   */
  requestFragment(fragment, callbacks, config, priority) {
    const context = fragment.getContext();
    config = config || {};

    const frag = fragment.getFrag();

    // Before the fragment is marked as downloading, or it stays marked for good.
    if (frag.decryptdata) {
      throw new Error('unexpected decryptdata');
    }

    markRequested(this.player, fragment);

    const source = /** @type {import('../../VideoSource.mjs').VideoSource} */ (this.player.source);
    const headers = {
      ...config.headers,
      // Login headers only to the source's own site (VideoSource.headersFor), for segment and key.
      ...sourceHeadersFor(source, context.url),
    };
    const decrypt = this.decryptionFor(frag, {...config.headers, ...sourceHeadersFor(source, frag?.fs_oldcryptdata?.uri ?? '')});

    return this.player.getClient().downloadManager.getFile({
      ...context,
      config,
      headers,
      postProcessor: decrypt || (async (entry, response) => response),
    }, {
      ...fragmentDownloadCallbacks(this.player, fragment, callbacks, (entry, data) => {
        /** @type {(response: {url: string, data: ArrayBuffer|undefined}, stats: LoaderStats, context: SegmentContext, xhr: null) => void} */ (callbacks.onSuccess)({
          url: entry.url,
          data: /** @type {ArrayBuffer|undefined} */ (data),
        }, /** @type {LoaderStats} */ (entry.stats), context, null);
      }),
      /**
       * @param {LoaderStats} stats
       * @param {import('../../network/DownloadEntry.mjs').DownloadRequest} context2
       * @param {ArrayBuffer|string} data
       * @param {null} xhr
       */
      onProgress: (stats, context2, data, xhr) => {
        if (callbacks.onProgress) callbacks.onProgress(stats, context, /** @type {ArrayBuffer} */ (data), xhr);
      },
    }, priority);
  }
}
