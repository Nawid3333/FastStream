import fs from 'node:fs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {DownloadStatus} from '../../chrome/player/enums/DownloadStatus.mjs';
import {downloadStatusText} from '../../chrome/player/ui/DownloadStatusText.mjs';

// The download line shows how many connections download at this moment, as upstream did
// ("3C ↓1.2MB/s 50%"); it was dropped on 2026-10-09 and asked back for on 2026-10-22, now
// with the speed in Mbit/s, the unit of the speed setting.

vi.mock('../../chrome/player/modules/FSBlob.mjs', () => ({
  FSBlob: class {
    close() {}
    async clear() {}
  },
}));
const {DownloadManager} = await import('../../chrome/player/network/DownloadManager.mjs');

describe('the download line', () => {
  it('reads "<connections>C ↓<Mbit/s> <percent>%"', () => {
    expect(downloadStatusText(3, 1.2e6, 50)).toBe('3C ↓9.6 Mbit/s 50%');
    expect(downloadStatusText(0, 0, 100)).toBe('0C ↓0 Mbit/s 100%');
  });

  it('is what the player shows, with the downloads running now', () => {
    // InterfaceController touches the DOM when it is imported: its source is read.
    const source = fs.readFileSync(new URL('../../chrome/player/ui/InterfaceController.mjs', import.meta.url), 'utf8');
    expect(source).toContain('downloadStatusText(this.client.downloadManager.runningCount(), this.lastSpeed, percentDone)');
  });

  describe('its count (DownloadManager.runningCount)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal('navigator', {onLine: true});
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    /** A video's manager, its three downloaders there and ten downloads queued, none started. */
    async function managerWithWork() {
      const manager = new DownloadManager({options: {maximumDownloaders: 6}, predownloadFragments: () => {}});
      await manager.reset();
      for (let i = 0; i < 10; i++) {
        // A download whose request never comes: it runs until it is stopped.
        manager.queue.push({status: DownloadStatus.ENQUEUED, details: {}, priority: 0,
          getRequest: () => new Promise(() => {}), onAbort() {}});
      }
      return manager;
    }

    it('counts the downloaders downloading, not those there are', async () => {
      const manager = await managerWithWork();
      expect(manager.downloaders).toHaveLength(3);
      expect(manager.runningCount()).toBe(0);
      manager.queueNext();
      expect(manager.runningCount()).toBe(3);
    });

    it('goes up and down as downloaders are added and taken away (the keys)', async () => {
      const manager = await managerWithWork();
      manager.queueNext();
      expect(manager.runningCount()).toBe(3);
      manager.addDownloader();
      expect(manager.runningCount()).toBe(4);
      manager.removeDownloader();
      manager.removeDownloader();
      expect(manager.runningCount()).toBe(2);
    });
  });
});
