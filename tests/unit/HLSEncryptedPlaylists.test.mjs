import {createCipheriv, randomBytes} from 'node:crypto';
import vm from 'node:vm';
import {M3U8Parser} from 'hls.js';
// The worker's text, which vitest includes when it loads this file (?raw): read at run time,
// the code run below was "user-provided" to CodeQL (js/code-injection).
import workerSource from '../../chrome/player/modules/decrypter-worker.js?raw';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {DownloadStatus} from '../../chrome/player/enums/DownloadStatus.mjs';
import {HLSFragment} from '../../chrome/player/players/hls/HLSFragment.mjs';
import {HLSFragmentRequester} from '../../chrome/player/players/hls/HLSFragmentRequester.mjs';
import {StreamLength} from '../../chrome/player/utils/StreamLength.mjs';

// HLSPlayer.trackUpdated hands each playlist to HLSFragmentRequester.takeOverDecryption,
// which takes the decryption of its AES-128 segments over from hls.js; HLSFragmentRequester
// then decrypts them in decrypter-worker.js. These run hls.js's own playlist parser (the
// release package.json pins) and the real worker script, with Node's WebCrypto.
//
// - An init segment under an EXT-X-KEY (the key before the EXT-X-MAP) kept hls.js's key:
//   hls.js loaded the key, then asked for the init segment, requestFragment threw on its
//   decryptdata, and nothing ever answered hls.js. The stream span forever.
// - SAMPLE-AES, AES-256-CTR and the DRM key formats come with decryptdata too, and were
//   decrypted as whole AES-CBC segments: garbage or nothing, and a generic load error
//   instead of the DRM message.

/** decrypter-worker.js, run in a context of its own, as a Worker runs it. */
class ScriptWorker {
  constructor() {
    this.listeners = {};
    const scope = {
      crypto: globalThis.crypto,
      Uint8Array, ArrayBuffer, Error, String,
      postMessage: (data) => queueMicrotask(() => this.dispatch('message', {data})),
    };
    vm.runInNewContext(workerSource, scope);
    this.scope = scope;
  }
  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }
  dispatch(type, event) {
    (this.listeners[type] || []).forEach((listener) => listener(event));
  }
  postMessage(data) {
    queueMicrotask(() => this.scope.onmessage({data}));
  }
  terminate() {}
}

const IV_HEX = '000102030405060708090a0b0c0d0e0f';

/**
 * A media playlist with one key for all of it, put before its EXT-X-MAP.
 * @param {string} key - The EXT-X-KEY attributes.
 * @return {Object[]} The hls.js fragments of the playlist.
 */
function parse(key) {
  const text = [
    '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-KEY:${key}`,
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4,', 'seg0.m4s',
    '#EXTINF:4,', 'seg1.m4s',
    '#EXT-X-ENDLIST', '',
  ].join('\n');
  return M3U8Parser.parseLevelPlaylist(text, 'http://127.0.0.1/stream/index.m3u8', 0, 'main', 0, null).fragments;
}

const AES_128 = `METHOD=AES-128,URI="key.bin",IV=0x${IV_HEX}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HLSFragmentRequester.takeOverDecryption', () => {
  it('takes an init segment under the playlist\'s key over from hls.js', () => {
    const fragments = parse(AES_128);
    const init = fragments[0].initSegment;
    // What hls.js makes of it: an encrypted init segment, whose key it would load itself.
    expect(init.encrypted).toBe(true);

    expect(HLSFragmentRequester.takeOverDecryption(fragments)).toBe(true);

    // hls.js no longer loads its key (loadInitSegmentIfNeeded), nor decrypts it once loaded
    // (_loadInitSegment), and requestFragment no longer refuses it.
    expect(init.encrypted).toBe(false);
    expect(init.decryptdata).toBe(null);
    expect(init.fs_oldcryptdata.method).toBe('AES-128');
    expect(init.fs_oldcryptdata.uri).toBe('http://127.0.0.1/stream/key.bin');
    expect(Buffer.from(init.fs_oldcryptdata.iv).toString('hex')).toBe(IV_HEX);
  });

  it('takes the segments over as before', () => {
    const fragments = parse(AES_128);
    expect(HLSFragmentRequester.takeOverDecryption(fragments)).toBe(true);
    fragments.forEach((fragment) => {
      expect(fragment.decryptdata).toBe(null);
      expect(fragment.fs_oldcryptdata.method).toBe('AES-128');
    });
  });

  it('takes an AES-256 key over too, which the worker\'s AES-CBC decrypts', () => {
    expect(HLSFragmentRequester.takeOverDecryption(parse(`METHOD=AES-256,URI="key.bin",IV=0x${IV_HEX}`))).toBe(true);
  });

  it('says it cannot decrypt SAMPLE-AES, AES-256-CTR or a DRM key format', () => {
    const keys = [
      `METHOD=SAMPLE-AES,URI="key.bin",IV=0x${IV_HEX}`,
      `METHOD=AES-256-CTR,URI="key.bin",IV=0x${IV_HEX}`,
      'METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1",URI="skd://key42"',
    ];
    keys.forEach((key) => {
      const fragments = parse(key);
      // hls.js hands out decryptdata for each of them.
      expect(fragments[1].decryptdata).not.toBe(null);
      expect(HLSFragmentRequester.takeOverDecryption(fragments), key).toBe(false);
      expect(fragments[1].fs_oldcryptdata, key).toBeUndefined();
    });
  });

  it('leaves a playlist without a key alone', () => {
    const fragments = parse('METHOD=NONE');
    expect(HLSFragmentRequester.takeOverDecryption(fragments)).toBe(true);
    expect(fragments[0].initSegment.fs_oldcryptdata).toBeUndefined();
  });

  it('does it once: a live refresh hands it the fragments it already took over', () => {
    const fragments = parse(AES_128);
    HLSFragmentRequester.takeOverDecryption(fragments);
    const kept = fragments[0].fs_oldcryptdata;
    expect(HLSFragmentRequester.takeOverDecryption(fragments)).toBe(true);
    expect(fragments[0].fs_oldcryptdata).toBe(kept);
  });
});

describe('HLSFragmentRequester, an init segment under the playlist\'s key', () => {
  /**
   * Requests a fragment, answering its key's download and handing its own download's
   * postProcessor the bytes the server sent.
   * @param {HLSFragment} fragment
   * @param {Buffer} key - The key file's bytes.
   * @param {Buffer} sent - The fragment's bytes as the server sent them.
   * @return {Promise<ArrayBuffer>} What the download stores as the fragment.
   */
  async function download(fragment, key, sent) {
    vi.stubGlobal('Worker', ScriptWorker);
    const getFile = vi.fn(() => ({abort() {}}));
    const player = {emit: vi.fn(), source: {headers: {}}, getClient: () => ({downloadManager: {getFile}})};
    const requester = new HLSFragmentRequester(player);
    requester.requestFragment(fragment, {onSuccess: vi.fn(), onFail: vi.fn(), onAbort: vi.fn()});
    expect(getFile.mock.calls[0][0].url).toBe('http://127.0.0.1/stream/key.bin');
    expect(getFile.mock.calls[1][0].url).toBe('http://127.0.0.1/stream/init.mp4');
    await getFile.mock.calls[0][1].onSuccess({getData: async () => key.buffer.slice(key.byteOffset, key.byteOffset + key.length)});
    const data = sent.buffer.slice(sent.byteOffset, sent.byteOffset + sent.length);
    const response = await getFile.mock.calls[1][0].postProcessor({}, {data});
    requester.destroy();
    return response.data;
  }

  it('is downloaded and decrypted with its own IV, not refused', async () => {
    const fragments = parse(AES_128);
    HLSFragmentRequester.takeOverDecryption(fragments);
    const fragment = new HLSFragment(fragments[0].initSegment, 0, 0);

    const key = randomBytes(16);
    const plain = Buffer.from('ftyp....moov.... an init segment, 47 bytes long');
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.from(IV_HEX, 'hex'));
    const sent = Buffer.concat([cipher.update(plain), cipher.final()]);

    const stored = await download(fragment, key, sent);
    expect(Buffer.from(stored).toString()).toBe(plain.toString());
    expect(fragment.status).toBe(DownloadStatus.DOWNLOAD_INITIATED);
  });

  it('fails, rather than storing nothing as the init segment, under a wrong key', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fragments = parse(AES_128);
    HLSFragmentRequester.takeOverDecryption(fragments);
    const fragment = new HLSFragment(fragments[0].initSegment, 0, 0);
    // Fixed keys: with two random ones, about one run in 256 decrypted to bytes that end
    // in valid padding (a last byte of 1), and the wrong key "worked" (CI on #334). This
    // pair fails the padding check, as most wrong keys do.
    const cipher = createCipheriv('aes-128-cbc', Buffer.alloc(16, 0x11), Buffer.from(IV_HEX, 'hex'));
    const sent = Buffer.concat([cipher.update(Buffer.alloc(40, 7)), cipher.final()]);

    await expect(download(fragment, Buffer.alloc(16, 0x22), sent)).rejects.toThrow(/not decrypted/);
  });

  it('is refused while hls.js still has its key, and is then not marked as downloading', () => {
    // Only a fragment never taken over gets here. Marked first, it stayed "downloading" for
    // good and was never asked for again.
    const fragment = new HLSFragment(parse(AES_128)[0].initSegment, 0, 0);
    const player = {emit: vi.fn(), source: {headers: {}}, getClient: () => ({downloadManager: {getFile: vi.fn()}})};
    expect(() => new HLSFragmentRequester(player).requestFragment(fragment, {})).toThrow(/decryptdata/);
    expect(fragment.status).toBe(DownloadStatus.WAITING);
  });
});

// The background reads a playlist before any player opens (StreamLength.hlsProtected), and
// leaves one it takes for copy-protected to the page's own player. Its rule has to be the
// player's: taken for DRM where the player decrypts it, the page kept a stream FastStream
// plays; taken for clear where the player cannot, the player opened and showed nothing.
describe('StreamLength.hlsProtected, as the player decides', () => {
  const WIDEVINE = 'METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAANHBzc2g=",KEYID=0x46d7,' +
    'KEYFORMATVERSIONS="1",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"';
  const PLAYREADY = 'METHOD=SAMPLE-AES-CTR,URI="data:text/plain;charset=UTF-16;base64,BgIAAA==",KEYFORMAT="com.microsoft.playready"';
  const FAIRPLAY = 'METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1",URI="skd://key42"';

  /**
   * A media playlist: its lines between the header and the end, segments where 'seg' is.
   * @param {string[]} body - EXT-X-KEY attribute lists ('KEY:...'), and 'seg' for a segment.
   * @return {string}
   */
  function playlist(body) {
    let n = 0;
    const lines = body.flatMap((line) => line === 'seg' ? ['#EXTINF:4,', `seg${n++}.m4s`] : [`#EXT-X-${line}`]);
    return ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0',
      ...lines, '#EXT-X-ENDLIST', ''].join('\n');
  }

  const cases = {
    'AES-128': ['KEY:' + AES_128, 'MAP:URI="init.mp4"', 'seg', 'seg'],
    'AES-256': [`KEY:METHOD=AES-256,URI="key.bin",IV=0x${IV_HEX}`, 'seg', 'seg'],
    'no key': ['MAP:URI="init.mp4"', 'seg', 'seg'],
    'METHOD=NONE': ['KEY:METHOD=NONE', 'seg', 'seg'],
    'AES-128, then none': ['KEY:' + AES_128, 'seg', 'KEY:METHOD=NONE', 'seg'],
    'AES-128 beside a FairPlay key': ['KEY:' + AES_128, 'KEY:' + FAIRPLAY, 'seg', 'seg'],
    'SAMPLE-AES': [`KEY:METHOD=SAMPLE-AES,URI="key.bin",IV=0x${IV_HEX}`, 'seg', 'seg'],
    'AES-256-CTR': [`KEY:METHOD=AES-256-CTR,URI="key.bin",IV=0x${IV_HEX}`, 'seg', 'seg'],
    'FairPlay': ['KEY:' + FAIRPLAY, 'seg', 'seg'],
    'Widevine alone': ['KEY:' + WIDEVINE.replace('SAMPLE-AES-CTR', 'SAMPLE-AES-CENC'), 'MAP:URI="init.mp4"', 'seg'],
    'Vimeo: Widevine and PlayReady': ['KEY:' + WIDEVINE, 'KEY:' + PLAYREADY, 'MAP:URI="init.mp4"', 'seg', 'seg'],
    'clear, then Widevine': ['seg', 'KEY:' + WIDEVINE, 'seg'],
  };

  for (const [name, body] of Object.entries(cases)) {
    it(name, () => {
      const text = playlist(body);
      const fragments = M3U8Parser.parseLevelPlaylist(text, 'http://127.0.0.1/stream/index.m3u8', 0, 'main', 0, null).fragments;
      const playerDecrypts = HLSFragmentRequester.takeOverDecryption(fragments);
      expect(StreamLength.hlsProtected(text)).toBe(!playerDecrypts);
    });
  }

  it('reads Vimeo\'s and FairPlay\'s as protected, and AES-128 beside FairPlay as clear', () => {
    // The table above holds only if these come out as measured, whatever takeOverDecryption says.
    expect(StreamLength.hlsProtected(playlist(cases['Vimeo: Widevine and PlayReady']))).toBe(true);
    expect(StreamLength.hlsProtected(playlist(cases['FairPlay']))).toBe(true);
    expect(StreamLength.hlsProtected(playlist(cases['AES-128 beside a FairPlay key']))).toBe(false);
  });

  it('takes a key format hls.js does not know for one FastStream cannot decrypt', () => {
    // hls.js drops such a key ("Ignoring unsupported EXT-X-KEY") and hands the segments on as
    // clear: still encrypted, they play nothing. The one place the two rules part, on purpose.
    const text = playlist(['KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.example.drm",URI="skd://x"', 'seg', 'seg']);
    expect(StreamLength.hlsProtected(text)).toBe(true);
  });
});
