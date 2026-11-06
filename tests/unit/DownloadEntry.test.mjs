import {afterEach, describe, expect, it, vi} from 'vitest';
import {DownloadStatus} from '../../chrome/player/enums/DownloadStatus.mjs';
import {DownloadEntry} from '../../chrome/player/network/DownloadEntry.mjs';

// Several watchers can wait on one download: the player's loader, and a save that needs
// the same fragment. DownloadEntry called them one after another with nothing in between,
// so a watcher that threw kept the ones after it from ever hearing, and the entry from
// being cleaned up.

/**
 * An entry whose download is under way, as StandardDownloader.run leaves it.
 * @return {DownloadEntry}
 */
function runningEntry() {
  const entry = new DownloadEntry({url: 'http://127.0.0.1/seg.ts', responseType: 'arraybuffer', storeRaw: true});
  entry.status = DownloadStatus.DOWNLOAD_INITIATED;
  entry.downloader = {};
  return entry;
}

/**
 * A watcher whose every callback throws, and one that records what it heard.
 * @return {Object} {throwing, listening, heard}
 */
function watchers() {
  const heard = [];
  const fail = () => {
    throw new Error('a watcher bug');
  };
  const throwing = {callbacks: {onSuccess: fail, onFail: fail, onAbort: fail}};
  const listening = {callbacks: {
    onSuccess: () => heard.push('onSuccess'),
    onFail: () => heard.push('onFail'),
    onAbort: () => heard.push('onAbort'),
  }};
  return {throwing, listening, heard};
}

describe('DownloadEntry watchers', () => {
  // Also after a failed test: a spy left behind would silence the later tests.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const cases = {
    onSuccess: (entry) => entry.onSuccess({data: new ArrayBuffer(4), url: entry.url}, {}),
    onFail: (entry) => entry.onFail({}),
    onAbort: (entry) => entry.onAbort({}),
  };
  for (const [name, finish] of Object.entries(cases)) {
    it(`tells every watcher of ${name}, although one before it throws`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const entry = runningEntry();
      const {throwing, listening, heard} = watchers();
      entry.addWatcher(throwing);
      entry.addWatcher(listening);

      await finish(entry);

      expect(heard).toEqual([name]);
      // Cleaned up: no downloader or watcher left on it.
      expect(entry.downloader).toBe(null);
      expect(entry.watchers).toEqual([]);
    });
  }

  it('tells every watcher when one gives another up while it hears', async () => {
    // abortWatcher from a callback took a watcher out of the list forEach was walking, and
    // the one after it never heard (final review, 2026-10-10).
    const entry = runningEntry();
    const heard = [];
    const second = {callbacks: {onSuccess: () => heard.push('second')}};
    const third = {callbacks: {onSuccess: () => heard.push('third')}};
    const first = {callbacks: {onSuccess: () => {
      heard.push('first');
      entry.removeWatcher(first);
    }}};
    entry.addWatcher(first);
    entry.addWatcher(second);
    entry.addWatcher(third);
    await entry.onSuccess({data: new ArrayBuffer(4), url: entry.url}, {});
    expect(heard).toEqual(['first', 'second', 'third']);
  });

  it('tells every watcher of progress, although one before it throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const entry = runningEntry();
    const heard = [];
    entry.addWatcher({callbacks: {onProgress: () => {
      throw new Error('a watcher bug');
    }}});
    entry.addWatcher({callbacks: {onProgress: () => heard.push('progress')}});
    expect(() => entry.onProgress({}, {}, null, null)).not.toThrow();
    expect(heard).toEqual(['progress']);
  });
});

// The pieces of a range's answer as they come (FetchLoader -> StandardDownloader -> here), for
// MP4Player to feed mp4box before the range is in.
describe('DownloadEntry: the pieces of an answer', () => {
  const ANSWER = {status: 206, contentRange: 'bytes 0-5/100', headers: {}};
  /** A range's download under way, not processed before it is stored. */
  const rangeEntry = () => {
    const entry = new DownloadEntry({url: 'http://127.0.0.1/v.mp4', rangeStart: 0, rangeEnd: 6, responseType: 'arraybuffer'});
    entry.status = DownloadStatus.DOWNLOAD_INITIATED;
    entry.downloader = {};
    return entry;
  };
  /** A watcher recording the pieces it is told. */
  const reader = () => {
    const pieces = [];
    return {pieces, watcher: {callbacks: {onSuccess() {}, onChunk: (chunk, offset) => pieces.push([Array.from(chunk), offset])}}};
  };

  it('tells its watchers each piece, and one that joins on the way those so far first', async () => {
    const entry = rangeEntry();
    const early = reader();
    entry.addWatcher(early.watcher);
    entry.onChunk(new Uint8Array([1, 2, 3]), 0, ANSWER);
    const late = reader();
    entry.addWatcher(late.watcher);
    entry.onChunk(new Uint8Array([4, 5]), 3, ANSWER);
    await Promise.resolve();
    expect(early.pieces).toEqual([[[1, 2, 3], 0], [[4, 5], 3]]);
    // A task later (once the caller has its hold), all in order: the piece that came meanwhile
    // with them, not before them.
    expect(late.pieces).toEqual([[[1, 2, 3], 0], [[4, 5], 3]]);
    entry.onChunk(new Uint8Array([6]), 5, ANSWER);
    expect(late.pieces.at(-1)).toEqual([[6], 5]);
  });

  it('starts over at a retry, and keeps none once the download is over', async () => {
    const entry = rangeEntry();
    entry.onChunk(new Uint8Array([1, 2]), 0, ANSWER);
    entry.onChunk(new Uint8Array([1, 2, 3]), 0, ANSWER);
    expect(entry.pieces.map((p) => p.offset)).toEqual([0]);
    entry.cleanup();
    expect(entry.pieces).toBe(null);
    const late = reader();
    entry.addWatcher(late.watcher);
    await Promise.resolve();
    expect(late.pieces).toEqual([]);
  });

  it('tells none of an answer it processes before storing it (an encrypted segment), nor of a raw one', () => {
    const decrypted = rangeEntry();
    decrypted.postProcessor = async (entry, response) => response;
    const raw = new DownloadEntry({url: 'http://127.0.0.1/key', responseType: 'arraybuffer', storeRaw: true});
    raw.status = DownloadStatus.DOWNLOAD_INITIATED;
    for (const entry of [decrypted, raw]) {
      const {pieces, watcher} = reader();
      entry.addWatcher(watcher);
      entry.onChunk(new Uint8Array([1]), 0, ANSWER);
      expect(pieces).toEqual([]);
    }
  });

  it('a watcher that throws keeps the others from nothing', () => {
    const entry = rangeEntry();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    entry.addWatcher({callbacks: {onSuccess() {}, onChunk: () => {
      throw new Error('a reader bug');
    }}});
    const {pieces, watcher} = reader();
    entry.addWatcher(watcher);
    entry.onChunk(new Uint8Array([7]), 0, ANSWER);
    expect(pieces).toEqual([[[7], 0]]);
    error.mockRestore();
  });
});

describe('DownloadEntry: stored data that can no longer be read', () => {
  // An OPFS file deleted or rewritten under its File, a Cache API entry that went: the
  // fragment is downloaded again when next asked for, instead of failing the same way.
  it('tells onDataLost when its data is gone, and still fails this read', async () => {
    const entry = new DownloadEntry({url: 'https://example.com/a.ts', responseType: 'arraybuffer'});
    entry.status = DownloadStatus.DOWNLOAD_COMPLETE;
    entry.data = () => undefined;
    entry.onDataLost = vi.fn();
    await expect(entry.getDataFromBlob()).rejects.toThrow('gone');
    expect(entry.onDataLost).toHaveBeenCalledTimes(1);
  });

  it('tells onDataLost when its stored file cannot be read', async () => {
    const entry = new DownloadEntry({url: 'https://example.com/a.ts', responseType: 'arraybuffer'});
    entry.status = DownloadStatus.DOWNLOAD_COMPLETE;
    entry.data = () => ({arrayBuffer: async () => {
      throw new DOMException('The file was deleted', 'NotFoundError');
    }});
    entry.onDataLost = vi.fn();
    await expect(entry.getDataFromBlob()).rejects.toThrow('deleted');
    expect(entry.onDataLost).toHaveBeenCalledTimes(1);
  });

  it('keeps its data when reading it fails for another reason', async () => {
    // A TypeError is a mistake in reading it, not storage that lost it: a new download
    // would fail the same way.
    const entry = new DownloadEntry({url: 'https://example.com/a.ts', responseType: 'arraybuffer'});
    entry.status = DownloadStatus.DOWNLOAD_COMPLETE;
    entry.data = () => new ArrayBuffer(3);
    entry.onDataLost = vi.fn();
    await expect(entry.getDataFromBlob()).rejects.toThrow(TypeError);
    expect(entry.onDataLost).not.toHaveBeenCalled();
  });

  it('reads data that is there as before', async () => {
    const entry = new DownloadEntry({url: 'https://example.com/a.ts', responseType: 'arraybuffer'});
    entry.status = DownloadStatus.DOWNLOAD_COMPLETE;
    entry.data = () => new Blob([new Uint8Array([1, 2, 3])]);
    entry.onDataLost = vi.fn();
    expect([...new Uint8Array(await entry.getDataFromBlob())]).toEqual([1, 2, 3]);
    expect(entry.onDataLost).not.toHaveBeenCalled();
  });
});
