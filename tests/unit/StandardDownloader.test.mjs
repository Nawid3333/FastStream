import {describe, expect, it, vi} from 'vitest';
import {StandardDownloader} from '../../chrome/player/network/StandardDownloader.mjs';

// A downloader is free for the next download once cleanup() has run. On a successful
// response it ran after the entry's own onSuccess, so anything that went wrong in there
// left the downloader busy for good: DownloadManager never gave it another download.

describe('StandardDownloader', () => {
  it('is free again after a download whose entry failed to take the response', async () => {
    const manager = {onDownloaderFinished: vi.fn()};
    const downloader = new StandardDownloader(manager);
    // Mid-download, as run() leaves it.
    downloader.loader = {destroy: () => {}};
    downloader.entry = {
      downloader,
      onSuccess: async () => {
        throw new Error('the entry could not store the response');
      },
    };

    const stats = {loaded: 10, loading: {start: 0}};
    await expect(downloader.onSuccess({data: new ArrayBuffer(10)}, stats, null, null)).rejects.toThrow();

    expect(downloader.canHandle({})).toBe(true);
    expect(manager.onDownloaderFinished).toHaveBeenCalledTimes(1);
  });

  // An entry whose request is still being made (a DASH segment's preprocessor) can be
  // aborted, by a seek; the request failing after that failed whatever entry the
  // downloader had by then, or threw on none (#148).
  describe('a request that fails after its download was aborted', () => {
    /** An entry whose request fails when the test says. */
    function pendingEntry() {
      const entry = {onAbort: vi.fn(), onFail: vi.fn()};
      entry.request = new Promise((resolve, reject) => {
        entry.failRequest = reject;
      });
      entry.getRequest = () => entry.request;
      return entry;
    }

    it('leaves the download the downloader has moved on to alone', async () => {
      const downloader = new StandardDownloader({onDownloaderFinished: vi.fn()});
      const aborted = pendingEntry();
      downloader.run(aborted);
      downloader.abort();
      const next = pendingEntry();
      downloader.run(next);

      aborted.failRequest(new Error('the preprocessor failed'));
      await new Promise((resolve) => setTimeout(resolve));

      expect(next.onFail).not.toHaveBeenCalled();
      expect(downloader.entry).toBe(next);
    });

    it('is not an error when the downloader has nothing else', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const downloader = new StandardDownloader({onDownloaderFinished: vi.fn()});
      const aborted = pendingEntry();
      downloader.run(aborted);
      downloader.abort();

      aborted.failRequest(new Error('the preprocessor failed'));
      await new Promise((resolve) => setTimeout(resolve));

      expect(error).not.toHaveBeenCalled();
      expect(aborted.onFail).not.toHaveBeenCalled();
      error.mockRestore();
    });
  });
});
