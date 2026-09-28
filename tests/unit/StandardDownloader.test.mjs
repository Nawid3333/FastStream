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
});
