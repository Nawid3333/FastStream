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
