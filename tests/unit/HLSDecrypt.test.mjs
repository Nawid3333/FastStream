import {afterEach, describe, expect, it, vi} from 'vitest';
import {DefaultPlayerEvents} from '../../chrome/player/enums/DefaultPlayerEvents.mjs';
import {DownloadStatus} from '../../chrome/player/enums/DownloadStatus.mjs';
import {HLSDecrypter} from '../../chrome/player/players/hls/HLSDecrypter.mjs';
import {HLSFragmentRequester} from '../../chrome/player/players/hls/HLSFragmentRequester.mjs';

// An AES-128 HLS segment is downloaded, then decrypted in a worker (HLSDecrypter) from the
// download's postProcessor, and whatever the postProcessor returns is stored as the
// segment, complete. A throw there fails the download instead (DownloadEntry.onSuccess).
// Two ways gave something that was no decrypted segment and stored it all the same.

/** A Worker that answers nothing, as a terminated one does. */
class SilentWorker {
  addEventListener() {}
  postMessage() {}
  terminate() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HLSDecrypter', () => {
  it('refuses to decrypt once destroyed', async () => {
    // It answered undefined, and the segment was stored as "undefined".
    vi.stubGlobal('Worker', SilentWorker);
    const decrypter = new HLSDecrypter();
    decrypter.destroy();
    await expect(decrypter.decryptAES(new ArrayBuffer(16), new ArrayBuffer(16), new ArrayBuffer(16))).rejects.toThrow(/destroyed/);
  });

  it('fails a decrypt still running when it is destroyed', async () => {
    // Settled with null, which was stored as the segment.
    vi.stubGlobal('Worker', SilentWorker);
    const decrypter = new HLSDecrypter();
    const decrypting = decrypter.decryptAES(new ArrayBuffer(16), new ArrayBuffer(16), new ArrayBuffer(16));
    decrypter.destroy();
    await expect(decrypting).rejects.toThrow(/destroyed/);
  });
});

describe('HLSFragmentRequester, an encrypted segment', () => {
  /**
   * Requests an encrypted segment and answers its key's download.
   * @param {?ArrayBuffer} key - The key's bytes, or null for none.
   * @param {Object} [cryptdata] - The segment's key info.
   * @return {Promise<Object>} The segment's postProcessor and the player.
   */
  async function requestEncrypted(key, cryptdata = {uri: 'http://127.0.0.1/key', iv: new Uint8Array(16)}) {
    const getFile = vi.fn(() => ({abort() {}}));
    const player = {emit: vi.fn(), source: {headers: {}}, getClient: () => ({downloadManager: {getFile}})};
    const requester = new HLSFragmentRequester(player);
    const fragment = {
      status: DownloadStatus.WAITING,
      getFrag: () => ({fs_oldcryptdata: cryptdata}),
      getContext: () => ({url: 'http://127.0.0.1/seg0.ts', responseType: 'arraybuffer'}),
    };
    requester.requestFragment(fragment, {onSuccess: vi.fn(), onFail: vi.fn(), onAbort: vi.fn()});
    // The key's download is the first request, the segment's the second.
    await getFile.mock.calls[0][1].onSuccess({getData: async () => key});
    return {postProcessor: getFile.mock.calls[1][0].postProcessor, player, requester};
  }

  it('fails the segment when its key or IV is missing, not stores it still encrypted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const {postProcessor, player} = await requestEncrypted(null);
    await expect(postProcessor({}, {data: new ArrayBuffer(16)})).rejects.toThrow(/key or IV/);
    // The player still hears that a key is needed.
    expect(player.emit).toHaveBeenCalledWith(DefaultPlayerEvents.NEED_KEY);
  });

  it('fails the segment when its player was destroyed before it was decrypted', async () => {
    vi.stubGlobal('Worker', SilentWorker);
    const {postProcessor, requester} = await requestEncrypted(new ArrayBuffer(16));
    requester.destroy();
    await expect(postProcessor({}, {data: new ArrayBuffer(16)})).rejects.toThrow(/destroyed/);
  });
});
