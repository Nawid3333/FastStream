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
