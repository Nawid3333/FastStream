import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {DownloadStatus} from '../../chrome/player/enums/DownloadStatus.mjs';
import {downloadingOutside, HEALTHY_S, shouldConcentrate, SHORT_S} from '../../chrome/player/network/PlayheadFirst.mjs';

vi.mock('../../chrome/player/modules/FSBlob.mjs', () => ({
  FSBlob: class {
    close() {}
    async clear() {}
    deleteBlob() {}
  },
}));
const {DownloadManager} = await import('../../chrome/player/network/DownloadManager.mjs');

// Short of video, a player downloads its next seconds first: parallel downloads share the
// line, and the fragment playback needed arrived no sooner than the two after it (a 3 s
// stall on MP4 with background players loading).

describe('PlayheadFirst', () => {
  it('concentrates below SHORT_S, spreads out again from HEALTHY_S, and holds between', () => {
    expect(shouldConcentrate(SHORT_S - 1, false)).toBe(true);
    expect(shouldConcentrate(HEALTHY_S, true)).toBe(false);
    expect(shouldConcentrate((SHORT_S + HEALTHY_S) / 2, true)).toBe(true);
    expect(shouldConcentrate((SHORT_S + HEALTHY_S) / 2, false)).toBe(false);
  });

  it('finds the downloads that run outside the window around the playhead', () => {
    const at = (start, status = DownloadStatus.DOWNLOAD_INITIATED) => ({start, end: start + 4, status});
    const fragments = [at(0), at(90), at(100), at(140), at(200, DownloadStatus.DOWNLOAD_COMPLETE),
      at(300), {start: NaN, end: NaN, status: DownloadStatus.DOWNLOAD_INITIATED}, undefined];
    // At 100 with 5 s behind and 30 s ahead: [95, 130] is kept.
    expect(downloadingOutside(fragments, 100, 5, 30).map((fragment) => fragment.start)).toEqual([0, 90, 140, 300]);
    expect(downloadingOutside(null, 100, 5, 30)).toEqual([]);
  });
});

describe('DownloadManager.cancelIfCheap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A manager with one download of each kind, as StandardDownloader leaves them. */
  function managerWith(entries) {
    const manager = new DownloadManager(null);
    manager.storage = new Map(entries.map((entry) => [manager.getIdentifier(entry.details), entry]));
    manager.downloaders = entries.filter((entry) => entry.downloader).map((entry) => entry.downloader);
    manager.queue = entries.filter((entry) => entry.status === DownloadStatus.ENQUEUED);
    return manager;
  }

  function entry(url, {status = DownloadStatus.DOWNLOAD_INITIATED, priority = 0, loaded = 0, total = 0, delivering = false} = {}) {
    const details = {url, responseType: 'arraybuffer'};
    const result = {details, url, responseType: 'arraybuffer', status, priority, abort: vi.fn()};
    if (status === DownloadStatus.DOWNLOAD_INITIATED) {
      result.downloader = {entry: result, delivering, stats: total ? {loaded, total} : null};
    }
    return result;
  }

  it('cancels a download ahead, queued or just started, and nothing playback needs', () => {
    const ahead = entry('https://example.com/ahead.ts', {loaded: 10, total: 1000});
    const queued = entry('https://example.com/queued.ts', {status: DownloadStatus.ENQUEUED});
    const playback = entry('https://example.com/playback.ts', {priority: 1000});
    const nearlyDone = entry('https://example.com/done.ts', {loaded: 900, total: 1000});
    const delivering = entry('https://example.com/delivering.ts', {delivering: true});
    const finished = entry('https://example.com/finished.ts', {status: DownloadStatus.DOWNLOAD_COMPLETE});
    const manager = managerWith([ahead, queued, playback, nearlyDone, delivering, finished]);

    expect(manager.activeCount()).toBe(5);
    expect(manager.cancelIfCheap(ahead.details)).toBe(true);
    expect(manager.cancelIfCheap(queued.details)).toBe(true);
    expect(manager.queue).not.toContain(queued);
    for (const kept of [playback, nearlyDone, delivering, finished]) {
      expect(manager.cancelIfCheap(kept.details)).toBe(false);
      expect(kept.abort).not.toHaveBeenCalled();
    }
    expect(ahead.abort).toHaveBeenCalledTimes(1);
    expect(queued.abort).toHaveBeenCalledTimes(1);
    expect(manager.cancelIfCheap({url: 'https://example.com/unknown.ts', responseType: 'arraybuffer'})).toBe(false);
  });
});
