import {describe, expect, it, vi} from 'vitest';
import {StandardDownloader} from '../../chrome/player/network/StandardDownloader.mjs';

// A downloader is free for the next download once cleanup() has run. On a successful
// response it ran after the entry's own onSuccess, so anything that went wrong in there
// left the downloader busy for good: DownloadManager never gave it another download.

describe('StandardDownloader', () => {
  it('asks for what playback waits for first, and for the rest as usual', async () => {
    // Playback's requests (HLSLoader, DashLoader, MP4Player) have priority 1000; the
    // client's downloads ahead have 0. Firefox sends a host's queued requests by priority.
    globalThis.self = globalThis;
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    try {
      for (const priority of [1000, 0]) {
        const downloader = new StandardDownloader({onDownloaderFinished: vi.fn()});
        downloader.run({
          priority,
          config: {},
          onAbort: vi.fn(),
          getRequest: async () => ({url: 'https://example.com/a.ts', responseType: 'arraybuffer', headers: {}}),
        });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(priority ? 1 : 2));
        downloader.abort();
      }
      expect(fetchMock.mock.calls.map(([, init]) => init.priority)).toEqual(['high', 'auto']);

      // While its player leaves the network to a watched one, the rest goes 'low'.
      const yielding = new StandardDownloader({onDownloaderFinished: vi.fn(), yielding: true});
      yielding.run({
        priority: 0,
        config: {},
        onAbort: vi.fn(),
        getRequest: async () => ({url: 'https://example.com/b.ts', responseType: 'arraybuffer', headers: {}}),
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      yielding.abort();
      expect(fetchMock.mock.calls[2][1].priority).toBe('low');
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
