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

/** A Worker the test answers for: what decrypter-worker.js posts back, or an error event. */
class AnsweringWorker {
  constructor() {
    this.listeners = {};
    this.posted = [];
    this.terminated = false;
    AnsweringWorker.made.push(this);
  }
  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }
  postMessage(message) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  /**
   * Sends an event to the decrypter.
   * @param {string} type - 'message', 'error' or 'messageerror'.
   * @param {Object} event
   */
  fire(type, event) {
    (this.listeners[type] || []).forEach((listener) => listener(event));
  }
}
AnsweringWorker.made = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  AnsweringWorker.made = [];
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

  it('fails a decrypt the worker could not do, rather than giving its empty answer as the segment', async () => {
    // decrypter-worker.js answers a failure (a wrong key, a bad IV, a cut-off download)
    // with 0 bytes and an error, and the 0 bytes were stored as the segment, complete.
    vi.stubGlobal('Worker', AnsweringWorker);
    const decrypter = new HLSDecrypter();
    const decrypting = decrypter.decryptAES(new ArrayBuffer(32), new ArrayBuffer(16), new ArrayBuffer(16));
    const [worker] = AnsweringWorker.made;
    worker.fire('message', {data: {decrypted: new ArrayBuffer(0), id: worker.posted[0].id, error: 'The operation failed for an operation-specific reason'}});
    await expect(decrypting).rejects.toThrow(/operation-specific/);
  });

  it('fails a decrypt that gave no data even without an error', async () => {
    vi.stubGlobal('Worker', AnsweringWorker);
    const decrypter = new HLSDecrypter();
    const decrypting = decrypter.decryptAES(new ArrayBuffer(16), new ArrayBuffer(16), new ArrayBuffer(16));
    const [worker] = AnsweringWorker.made;
    worker.fire('message', {data: {decrypted: new ArrayBuffer(0), id: worker.posted[0].id}});
    await expect(decrypting).rejects.toThrow(/not decrypted/);
  });

  it('still gives a decrypted segment as it is', async () => {
    vi.stubGlobal('Worker', AnsweringWorker);
    const decrypter = new HLSDecrypter();
    const decrypting = decrypter.decryptAES(new ArrayBuffer(16), new ArrayBuffer(16), new ArrayBuffer(16));
    const [worker] = AnsweringWorker.made;
    const decrypted = new Uint8Array([1, 2, 3]).buffer;
    worker.fire('message', {data: {decrypted, id: worker.posted[0].id}});
    await expect(decrypting).resolves.toBe(decrypted);
  });

  it('fails what was waiting on a worker that crashed, and starts a new one for the next', async () => {
    // A worker that fails to load or throws answers nothing: the segment waited forever,
    // and so did a save holding it.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('Worker', AnsweringWorker);
    const decrypter = new HLSDecrypter();
    const first = decrypter.decryptAES(new ArrayBuffer(16), new ArrayBuffer(16), new ArrayBuffer(16));
    const second = decrypter.decryptAES(new ArrayBuffer(16), new ArrayBuffer(16), new ArrayBuffer(16));
    const [crashed] = AnsweringWorker.made;
    crashed.fire('error', {message: 'NetworkError: failed to load worker script'});
    await expect(first).rejects.toThrow(/failed to load worker script/);
    await expect(second).rejects.toThrow(/failed to load worker script/);
    expect(crashed.terminated).toBe(true);

    const third = decrypter.decryptAES(new ArrayBuffer(16), new ArrayBuffer(16), new ArrayBuffer(16));
    expect(AnsweringWorker.made).toHaveLength(2);
    const [, fresh] = AnsweringWorker.made;
    const decrypted = new Uint8Array([4]).buffer;
    fresh.fire('message', {data: {decrypted, id: fresh.posted[0].id}});
    await expect(third).resolves.toBe(decrypted);
  });

  it('fails what was waiting when an answer could not be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('Worker', AnsweringWorker);
    const decrypter = new HLSDecrypter();
    const decrypting = decrypter.decryptAES(new ArrayBuffer(16), new ArrayBuffer(16), new ArrayBuffer(16));
    AnsweringWorker.made[0].fire('messageerror', {});
    await expect(decrypting).rejects.toThrow(/not decrypted/);
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
