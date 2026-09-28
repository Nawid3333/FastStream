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
});
