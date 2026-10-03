import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DownloadStatus} from '../../chrome/player/enums/DownloadStatus.mjs';

// FSBlob keeps downloaded data in the browser's storage, which a unit test has none of,
// and imports the player's UI on the way. DownloadManager only opens and closes it here.
vi.mock('../../chrome/player/modules/FSBlob.mjs', () => ({
  FSBlob: class {
    close() {}
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
});
