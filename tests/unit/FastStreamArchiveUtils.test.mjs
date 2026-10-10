import {describe, expect, it} from 'vitest';
import {DownloadStatus} from '../../chrome/player/enums/DownloadStatus.mjs';
import {LargeBuffer} from '../../chrome/player/modules/LargeBuffer.mjs';
import {FastStreamArchiveUtils} from '../../chrome/player/utils/FastStreamArchiveUtils.mjs';

// The .fsa archive ("save the buffer"): writeFSAToStream writes one into a save's stream,
// parseFSA reads one back, from a file dropped on the player.

/** A complete download entry holding `bytes`. */
function entry(bytes, status = DownloadStatus.DOWNLOAD_COMPLETE) {
  return {
    status,
    storeRaw: true,
    url: 'https://cdn.example/seg.ts',
    responseType: 'arraybuffer',
    responseHeaders: {},
    getData: async () => new Uint8Array(bytes).buffer,
  };
}

/**
 * A stream like a save's, recording what happens to it.
 * @param {Object} [sink] - overrides for the underlying sink
 * @return {{stream: WritableStream, log: Array<string>}}
 */
function recordingStream(sink = {}) {
  const log = [];
  const stream = new WritableStream({
    write: () => {
      log.push('write');
    },
    close: async () => {
      await sink.close?.();
      log.push('closed');
    },
    abort: () => {
      log.push('aborted');
    },
  });
  return {stream, log};
}

describe('writeFSAToStream', () => {
  it('is done only once the stream has finished the file', async () => {
    // A streamed save hands its file to the download when the stream closes; the player
    // said "saved" before that had happened.
    let finish;
    const {stream, log} = recordingStream({close: () => new Promise((resolve) => (finish = resolve))});
    let done = false;
    const writing = FastStreamArchiveUtils.writeFSAToStream(stream, null, [entry([1, 2, 3])]).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    finish();
    await writing;
    expect(log.at(-1)).toBe('closed');
  });

  it('fails when the stream cannot finish the file', async () => {
    const {stream} = recordingStream({close: async () => {
      throw new Error('the download was refused');
    }});
    await expect(FastStreamArchiveUtils.writeFSAToStream(stream, null, [entry([1])])).rejects.toThrow('the download was refused');
  });

  it('ends the stream\'s save when an entry is not complete', async () => {
    const {stream, log} = recordingStream();
    const entries = [entry([1]), entry([2], DownloadStatus.DOWNLOAD_FAILED)];
    await expect(FastStreamArchiveUtils.writeFSAToStream(stream, null, entries)).rejects.toThrow('Entry is not complete!');
    expect(log).toContain('aborted');
    expect(log).not.toContain('closed');
  });
});

describe('parseFSA', () => {
  /** A LargeBuffer over the given bytes. */
  async function bufferOf(bytes) {
    const buf = new LargeBuffer(bytes.length, 1);
    await buf.initialize(async () => new Uint8Array(bytes));
    return buf;
  }

  it('says a header size past the end of the file is out of range', async () => {
    // 0xFFFFFFF0 read as a signed number was -16, and a RangeError said nothing useful.
    const archive = await bufferOf([0xff, 0xff, 0xff, 0xf0, 0x7b, 0x7d]);
    await expect(FastStreamArchiveUtils.parseFSA(archive)).rejects.toThrow(/out of range/);
  });

  // An archive is a file the user may pass on: the session's login went with it (review).
  it('keeps the source\'s headers without the login ones', async () => {
    const chunks = [];
    const stream = new WritableStream({write: (chunk) => {
      chunks.push(...chunk);
    }});
    const player = {
      getSource: () => ({url: 'https://cdn.example/a.m3u8', identifier: 'a', mode: 'hls',
        headers: {'Cookie': 'session=1', 'authorization': 'Bearer x', 'Referer': 'https://site.example/'}}),
      getCurrentVideoLevelID: () => 0,
      getCurrentAudioLevelID: () => null,
    };
    await FastStreamArchiveUtils.writeFSAToStream(stream, player, [entry([1])]);
    const {source} = await FastStreamArchiveUtils.parseFSA(await bufferOf(chunks));
    expect(source.headers).toEqual({'Referer': 'https://site.example/'});
  });

  it('reads back what writeFSAToStream wrote', async () => {
    const chunks = [];
    const stream = new WritableStream({write: (chunk) => {
      chunks.push(...chunk);
    }});
    const written = [];
    await FastStreamArchiveUtils.writeFSAToStream(stream, null, [entry([1, 2, 3]), entry([4, 5])], (p) => written.push(p));
    const read = [];
    const {entries} = await FastStreamArchiveUtils.parseFSA(await bufferOf(chunks), (p) => read.push(p));
    expect(entries.map((e) => [...e.data])).toEqual([[1, 2, 3], [4, 5]]);
    // Each entry done counts: the progress stopped at 50 % (0 % for an archive of one).
    expect(written).toEqual([0.5, 1]);
    expect(read).toEqual([0.5, 1]);
  });
});
