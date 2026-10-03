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

export class HLSFragmentRequester {
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
   * @param {Object[]} fragments - The playlist's hls.js fragments.
   * @return {boolean} False when some of them are encrypted in a way this cannot decrypt.
   */
  static takeOverDecryption(fragments) {
    let decryptable = true;
    const takeOver = (frag) => {
      if (!frag?.encrypted) return;
      const decryptdata = frag.decryptdata;
      if (decryptdata?.keyFormat === 'identity' && DECRYPTABLE_METHODS.includes(decryptdata.method)) {
        frag.fs_oldcryptdata = decryptdata;
        frag.fs_oldlevelKeys = frag.levelkeys;
      } else {
        decryptable = false;
      }
      frag.levelkeys = null;
      frag._decryptdata = null;
    };
    takeOver(fragments[0]?.initSegment);
    fragments.forEach(takeOver);
    return decryptable;
  }

  destroy() {
    this.decrypter.destroy();
  }

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

    let keyPromise;

    if (frag.fs_oldcryptdata) {
      const toGet = {
        url: frag.fs_oldcryptdata.uri,
        rangeStart: 0,
        rangeEnd: 0,
        responseType: 'arraybuffer',
        storeRaw: true,
        headers: {
          ...config.headers,
          ...this.player.source.headers,
        },
      };
      keyPromise = new Promise((resolve, reject) => {
        this.player.getClient().downloadManager.getFile(toGet, {
          onSuccess: async (entry) => {
            resolve(await entry.getData());
          },
          onFail: (err) => {
            console.log('failed to get key', err);
            reject(err);
          },
          onAbort: (err) => {
            console.log('key aborted', err);
            reject(err);
          },
        });
      });
    }

    const loader = this.player.getClient().downloadManager.getFile({
      ...context,
      config,
      headers: {
        ...config.headers,
        ...this.player.source.headers,
      },
      postProcessor: async (entry, response) => {
        if (!frag.fs_oldcryptdata) {
          return response;
        }

        const key = await keyPromise;
        const decryptdata = frag.fs_oldcryptdata;

        if (!decryptdata.iv || !key) {
          console.error('missing decryptdata', decryptdata, key);
          this.player.emit(DefaultPlayerEvents.NEED_KEY);
          // Failed, not complete: the still-encrypted data was stored as the segment, and
          // played or saved as it was.
          throw new Error('Segment key or IV missing');
        }

        response.data = await this.decrypter.decryptAES(response.data, decryptdata.iv.buffer, key);

        return response;
      },
    }, {
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
          this.player.emit(DefaultPlayerEvents.FRAGMENT_UPDATE, fragment);
        }
        callbacks.onSuccess({
          url: entry.url,
          data: data,
        }, entry.stats, context, null);
      },
      onProgress: (stats, context2, data, xhr) => {
        if (callbacks.onProgress) callbacks.onProgress(stats, context, data, xhr);
      },
      onFail: (entry) => {
        fragment.status = DownloadStatus.DOWNLOAD_FAILED;
        this.player.emit(DefaultPlayerEvents.FRAGMENT_UPDATE, fragment);
        callbacks.onFail(entry);
      },
      onAbort: (entry) => {
        fragment.status = DownloadStatus.WAITING;
        this.player.emit(DefaultPlayerEvents.FRAGMENT_UPDATE, fragment);
        if (callbacks.onAbort) callbacks.onAbort(entry);
      },
    }, priority);

    return loader;
  }
}
