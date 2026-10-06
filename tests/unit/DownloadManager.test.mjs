import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DownloadStatus} from '../../chrome/player/enums/DownloadStatus.mjs';

// FSBlob keeps downloaded data in the browser's storage, which a unit test has none of,
// and imports the player's UI on the way. DownloadManager only opens and closes it here.
vi.mock('../../chrome/player/modules/FSBlob.mjs', () => ({
  FSBlob: class {
    close() {}
    async clear() {}
  },
}));

const {DownloadManager} = await import('../../chrome/player/network/DownloadManager.mjs');

describe('DownloadManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves no retry behind once destroyed', () => {
    // Right after a failed download, queueNext waits a second before the next one.
    const manager = new DownloadManager(null);
    manager.queue.push({status: DownloadStatus.ENQUEUED, details: {}});
    manager.lastFailed = Date.now();
    manager.queueNext();

    manager.destroy();

    // The wait used to end in queueNext on a manager with no downloaders: a TypeError.
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
  });

  /** A downloader that takes one download and keeps it. */
  function idleDownloader() {
    const downloader = {
      entry: null,
      canHandle: () => !downloader.entry,
      run: (entry) => {
        downloader.entry = entry;
      },
    };
    return downloader;
  }

  it('starts a queued download on every free downloader once a failure\'s wait is over', () => {
    // The wait after a failure ends in one queueNext, which started one download: with
    // three free downloaders and five queued downloads, one ran at a time (#133).
    const manager = new DownloadManager(null);
    manager.downloaders = [idleDownloader(), idleDownloader(), idleDownloader()];
    for (let i = 0; i < 5; i++) manager.queue.push({status: DownloadStatus.ENQUEUED, details: {}});
    manager.lastFailed = Date.now();
    manager.queueNext();
    expect(manager.downloaders.filter((downloader) => downloader.entry)).toHaveLength(0);

    vi.advanceTimersByTime(1100);
    expect(manager.downloaders.filter((downloader) => downloader.entry)).toHaveLength(3);
    expect(manager.queue).toHaveLength(2);
  });

  it('gives a downloader dropped for a failed download back once downloads succeed again', () => {
    // A failure takes one away; it never came back, so a few failures in a long video
    // left half the downloaders for the rest of it (#133).
    vi.stubGlobal('navigator', {onLine: true});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = {resetFailed: vi.fn(), predownloadFragments: vi.fn()};
    const manager = new DownloadManager(client);
    manager.testing = false;
    const [failed, other] = [idleDownloader(), idleDownloader()];
    manager.downloaders = [failed, other];
    const succeed = () => manager.onDownloaderFinished(other, {status: DownloadStatus.DOWNLOAD_COMPLETE});

    manager.onDownloaderFinished(failed, {status: DownloadStatus.DOWNLOAD_FAILED});
    expect(manager.downloaders).toEqual([other]);

    // Not while failures are recent.
    vi.advanceTimersByTime(DownloadManager.FailureRecoveryMs / 2);
    succeed();
    expect(manager.downloaders).toHaveLength(1);

    vi.advanceTimersByTime(DownloadManager.FailureRecoveryMs);
    succeed();
    expect(manager.downloaders).toHaveLength(2);
    // And no more than were taken away.
    succeed();
    expect(manager.downloaders).toHaveLength(2);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads the downloader limit the same way for the speed test and the key', () => {
    // 0 meant "never add one" to the speed test, and "no limit" to the add-downloader key.
    const limit = (maximumDownloaders) => new DownloadManager({options: {maximumDownloaders}}).downloaderLimit();
    expect([0, undefined, null, NaN, -2, 1, 3, 6, 9, 2.7].map(limit)).toEqual([6, 6, 6, 6, 6, 1, 3, 6, 6, 2]);
    expect(new DownloadManager(null).downloaderLimit()).toBe(6);
  });

  // The speed test started a video with one downloader and added one per three speed
  // samples: 3.3 s, a third of a Vimeo video, before it had six (2026-10-06). It starts
  // with three and decides per two samples; a server that answers 429 or 503 gets half.
  describe('a fast start that backs off when a server asks', () => {
    const client = (maximumDownloaders = 6) => ({
      options: {maximumDownloaders}, resetFailed: vi.fn(), predownloadFragments: vi.fn(),
    });
    /** A downloader that finished a download, failed with an HTTP status or not. */
    const finished = (code, retryAfter) => Object.assign(idleDownloader(), {
      getSpeed: () => 1e6,
      stats: code ? {error: {code, text: '', ...(retryAfter !== undefined ? {retryAfter} : {})}} : {},
    });
    const failedEntry = {status: DownloadStatus.DOWNLOAD_FAILED};

    beforeEach(() => {
      vi.stubGlobal('navigator', {onLine: true});
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('starts a video with three downloaders, the limit allowing, and one once a server throttled', async () => {
      const start = async (limit, throttled = false) => {
        const manager = new DownloadManager(client(limit));
        manager.throttled = throttled;
        await manager.reset();
        return manager.downloaders.length;
      };
      expect(await start(6)).toBe(3);
      expect(await start(2)).toBe(2);
      expect(await start(1)).toBe(1);
      expect(await start(6, true)).toBe(1);
    });

    it('adds a downloader after two speed samples that show a gain', () => {
      const manager = new DownloadManager(client());
      manager.downloaders = [finished(), finished(), finished()];
      const round = () => manager.downloaders.slice(0, 3).forEach((d) => manager.onDownloaderFinished(d, {status: DownloadStatus.DOWNLOAD_COMPLETE}));
      round();
      expect(manager.downloaders).toHaveLength(3);
      round();
      expect(manager.downloaders).toHaveLength(4);
    });

    it('halves the downloaders on a 429 or 503, stops the test, and gives none back', () => {
      const c = client();
      const manager = new DownloadManager(c);
      manager.downloaders = Array.from({length: 6}, () => finished(429));
      manager.onDownloaderFinished(manager.downloaders[0], failedEntry);
      expect(manager.downloaders).toHaveLength(3);
      expect(manager.testing).toBe(false);
      expect(manager.throttled).toBe(true);
      expect(c.resetFailed).toHaveBeenCalled();

      // Successes long after it bring nothing back, unlike after another failure.
      vi.advanceTimersByTime(DownloadManager.FailureRecoveryMs * 2);
      manager.onDownloaderFinished(manager.downloaders[1], {status: DownloadStatus.DOWNLOAD_COMPLETE});
      expect(manager.downloaders).toHaveLength(3);

      manager.downloaders[0] = finished(503);
      manager.onDownloaderFinished(manager.downloaders[0], failedEntry);
      expect(manager.downloaders).toHaveLength(1);
      manager.downloaders[0] = finished(429);
      manager.onDownloaderFinished(manager.downloaders[0], failedEntry);
      expect(manager.downloaders).toHaveLength(1);
    });

    it('keeps the one-downloader drop for other failures', () => {
      const manager = new DownloadManager(client());
      manager.testing = false;
      manager.downloaders = Array.from({length: 4}, () => finished(500));
      manager.onDownloaderFinished(manager.downloaders[0], failedEntry);
      expect(manager.downloaders).toHaveLength(3);
      expect(manager.throttled).toBe(false);
    });

    it('starts no download before the server\'s Retry-After is over, and waits 30 s at most', () => {
      const run = (retryAfter) => {
        const manager = new DownloadManager(client());
        manager.downloaders = [finished(429, retryAfter), idleDownloader()];
        manager.onDownloaderFinished(manager.downloaders[0], failedEntry);
        manager.queue.push({status: DownloadStatus.ENQUEUED, details: {}});
        manager.queueNext();
        return manager;
      };
      const started = (manager) => manager.downloaders.some((downloader) => downloader.entry);

      const asked = run(5000);
      vi.advanceTimersByTime(4900);
      expect(started(asked)).toBe(false);
      vi.advanceTimersByTime(300);
      expect(started(asked)).toBe(true);

      const tooLong = run(600000);
      vi.advanceTimersByTime(DownloadManager.MaxRetryAfterMs - 200);
      expect(started(tooLong)).toBe(false);
      vi.advanceTimersByTime(400);
      expect(started(tooLong)).toBe(true);
    });
  });
});
