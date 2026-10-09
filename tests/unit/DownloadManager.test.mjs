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
const {StandardDownloader} = await import('../../chrome/player/network/StandardDownloader.mjs');

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
      abort: () => {
        downloader.entry = null;
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

  it('raises the priority of a download playback starts waiting for while it runs', () => {
    // A download ahead (priority 0) that the player now needs (1000): a retry of it must
    // go out first in Firefox's queue (StandardDownloader asks entry.priority each attempt).
    const manager = new DownloadManager(null);
    manager.downloaders = [idleDownloader()];
    const details = {url: 'https://example.com/a.ts', responseType: 'arraybuffer'};
    const entry = manager.getFile(details, {}, 0).entry;
    expect(manager.downloaders[0].entry).toBe(entry);
    entry.status = DownloadStatus.DOWNLOAD_INITIATED; // as StandardDownloader.run() leaves it

    manager.getFile(details, {}, 1000);
    expect(entry.priority).toBe(1000);
    // A lower one leaves it.
    manager.getFile(details, {}, 0);
    expect(entry.priority).toBe(1000);
  });

  it('downloads again a fragment whose stored data can no longer be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new DownloadManager(null);
    manager.blobStore = {deleteBlob: vi.fn(), close() {}};
    manager.downloaders = [idleDownloader()];
    const details = {url: 'https://example.com/a.ts', responseType: 'arraybuffer'};
    const entry = manager.getFile(details, {}, 0).entry;
    entry.status = DownloadStatus.DOWNLOAD_COMPLETE;
    entry.data = () => undefined;

    await expect(entry.getDataFromBlob()).rejects.toThrow();

    expect(manager.getEntry(details)).toBeUndefined();
    expect(manager.blobStore.deleteBlob).toHaveBeenCalledTimes(1);
    // The next request makes a new download of it.
    const again = manager.getFile(details, {}, 1000).entry;
    expect(again).not.toBe(entry);
    vi.restoreAllMocks();
  });

  it('yielding cancels the downloads ahead, not what playback waits for, nor one nearly done', () => {
    // Another player the user watches is short of video (PlayerPeers.shouldYield).
    const client = {predownloadFragments: vi.fn()};
    const manager = new DownloadManager(client);
    const running = (priority, loaded, total, delivering = false) => {
      const entry = {priority, abort: vi.fn()};
      return {entry, delivering, stats: total ? {loaded, total} : null};
    };
    const ahead = running(0, 100, 1000);
    const unknownSize = running(0, 0, 0);
    const playback = running(1000, 0, 1000);
    const nearlyDone = running(0, 600, 1000);
    const delivering = running(0, 0, 1000, true);
    manager.downloaders = [ahead, unknownSize, playback, nearlyDone, delivering, {entry: null}];

    manager.setYield(true);
    expect(manager.yielding).toBe(true);
    expect(ahead.entry.abort).toHaveBeenCalledTimes(1);
    expect(unknownSize.entry.abort).toHaveBeenCalledTimes(1);
    expect(playback.entry.abort).not.toHaveBeenCalled();
    expect(nearlyDone.entry.abort).not.toHaveBeenCalled();
    expect(delivering.entry.abort).not.toHaveBeenCalled();
    // Once, not on every tick.
    manager.setYield(true);
    expect(ahead.entry.abort).toHaveBeenCalledTimes(1);

    // Taking the network back starts the downloads ahead again.
    manager.setYield(false);
    expect(manager.yielding).toBe(false);
    expect(client.predownloadFragments).toHaveBeenCalledTimes(1);
  });

  it('a paused player that yields holds even its playback\'s requests until it stops yielding', () => {
    // Paused MP4 players in background tabs asked for the ranges they buffer ahead
    // themselves (priority 1000) once their downloads ahead were cancelled.
    const manager = new DownloadManager({predownloadFragments: vi.fn()});
    manager.downloaders = [idleDownloader()];
    manager.setYield(true, true);
    const entry = manager.getFile({url: 'https://example.com/range', responseType: 'arraybuffer'}, {}, 1000).entry;
    expect(manager.downloaders[0].entry).toBe(null);
    expect(entry.status).toBe(DownloadStatus.ENQUEUED);

    // Playing again (still yielding): its playback gets the network.
    manager.setYield(true, false);
    expect(manager.downloaders[0].entry).toBe(entry);
  });

  it('reads the downloader limit the same way for the speed test and the key', () => {
    // 0 meant "never add one" to the speed test, and "no limit" to the add-downloader key.
    const limit = (maximumDownloaders) => new DownloadManager({options: {maximumDownloaders}}).downloaderLimit();
    expect([0, undefined, null, NaN, -2, 1, 3, 6, 9, 2.7].map(limit)).toEqual([6, 6, 6, 6, 6, 1, 3, 6, 6, 2]);
    expect(new DownloadManager(null).downloaderLimit()).toBe(6);
  });

  // A seek preview's build still running when a source was set again queued its manifest
  // during the reset, while there were no downloaders. reset() added them without starting
  // the queue, the client asked for nothing more while the queue held something
  // (canGetFile), and the next player's request for the same manifest joined that entry:
  // a live DASH stream reloaded without a failed codec never loaded (the real-streams
  // check, 2026-10-06, 1 run in 4).
  describe('a request made while a reset has no downloaders', () => {
    const details = {url: 'https://cdn.example/live.mpd', responseType: 'text'};
    const callbacks = () => ({onSuccess() {}, onFail() {}, onAbort() {}});

    it('starts once the reset has its downloaders', async () => {
      globalThis.self = globalThis;
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
      try {
        const manager = new DownloadManager({options: {maximumDownloaders: 6}, resetFailed() {}, predownloadFragments() {}});
        const resetting = manager.reset();
        expect(manager.downloaders).toHaveLength(0);
        const watcher = manager.getFile(details, callbacks());
        expect(watcher.entry.status).toBe(DownloadStatus.ENQUEUED);
        await resetting;
        expect(watcher.entry.status).toBe(DownloadStatus.DOWNLOAD_INITIATED);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('starts when another request joins it', () => {
      const manager = new DownloadManager(null);
      manager.downloaders = [];
      const stranded = manager.getFile(details, callbacks());
      // Downloaders back, and no queueNext: as reset() left it.
      manager.downloaders = [idleDownloader()];
      const joined = manager.getFile(details, callbacks());
      expect(joined.entry).toBe(stranded.entry);
      expect(manager.downloaders[0].entry).toBe(stranded.entry);
      expect(manager.queue).toHaveLength(0);
    });
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
      getSpeed: () => 1e6, abort: vi.fn(),
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

      // A Retry-After held the last video's downloads; the next video's server is asked anew.
      const held = new DownloadManager(client());
      held.holdUntil = Date.now() + 20000;
      await held.reset();
      expect(held.holdUntil).toBe(0);
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

    it('hears a real 429 through FetchLoader and StandardDownloader, with its Retry-After', async () => {
      globalThis.self = globalThis;
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', {status: 429, statusText: 'Too Many Requests', headers: {'Retry-After': '4'}})));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const manager = new DownloadManager(client());
      manager.downloaders = Array.from({length: 4}, () => new StandardDownloader(manager));
      const entry = {
        details: {url: 'https://cdn.example/1.ts'},
        getRequest: async () => ({url: 'https://cdn.example/1.ts', responseType: 'arraybuffer', headers: {}}),
        onFail() {
          this.status = DownloadStatus.DOWNLOAD_FAILED;
        },
        onAbort() {
          this.status = DownloadStatus.DOWNLOAD_FAILED;
        },
        onProgress() {},
      };
      const start = Date.now();
      manager.downloaders[0].run(entry);
      await vi.advanceTimersByTimeAsync(10);
      expect(manager.downloaders).toHaveLength(2);
      expect(manager.throttled).toBe(true);
      expect(manager.holdUntil - start).toBeGreaterThanOrEqual(4000);
      expect(manager.holdUntil - start).toBeLessThan(4100);
    });

    it('does not read the last download\'s error as the next one\'s', () => {
      const downloader = new StandardDownloader({onDownloaderFinished: vi.fn()});
      downloader.stats = {error: {code: 429, text: ''}};
      downloader.run({getRequest: () => new Promise(() => {})});
      expect(downloader.stats).toBe(null);
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
        manager.downloaders = [idleDownloader()];
        manager.slowDown(retryAfter);
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

  describe('backing off and coming back', () => {
    const client = (maximumDownloaders = 6) => ({
      options: {maximumDownloaders}, resetFailed: vi.fn(), predownloadFragments: vi.fn(),
    });
    /** A downloader that is not downloading anything. slowDown() retires the ones it cuts. */
    const idleDownloader = () => ({
      canHandle: () => true,
      run(entry) {
        this.entry = entry;
      },
      abort: vi.fn(),
      retire: vi.fn(),
    });
    /** A downloader that just finished a download, failed with an HTTP status or not. */
    const finished = (code, retryAfter) => Object.assign(idleDownloader(), {
      getSpeed: () => 1e6,
      stats: code ? {error: {code, text: '', ...(retryAfter !== undefined ? {retryAfter} : {})}} : {},
    });
    const failedEntry = {status: DownloadStatus.DOWNLOAD_FAILED};

    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal('navigator', {onLine: true});
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('halves the downloaders once per slow-down burst, not once per answer', () => {
      const manager = new DownloadManager(client());
      manager.downloaders = Array.from({length: 8}, () => finished(429));

      manager.slowDown(0);
      expect(manager.downloaders).toHaveLength(4);
      expect(manager.slowDowns).toBe(1);

      // A second 429 or 503 inside SlowDownSettleMs is the same burst: no second halving.
      manager.slowDown(0);
      expect(manager.downloaders).toHaveLength(4);
      expect(manager.slowDowns).toBe(1);

      // One after the settle window is a new burst.
      vi.advanceTimersByTime(DownloadManager.SlowDownSettleMs);
      manager.slowDown(0);
      expect(manager.downloaders).toHaveLength(2);
      expect(manager.slowDowns).toBe(2);
    });

    it('hands the entry of a cut downloader mid-fetch back to the queue, and its watchers hear nothing', () => {
      const manager = new DownloadManager(client());
      const kept = Object.assign(finished(), {canHandle: () => !kept.entry});
      const cut = new StandardDownloader(manager);
      manager.downloaders = [kept, cut];

      const entry = {
        priority: 1,
        getRequest: () => new Promise(() => {}), // the loader is still fetching
        onAbort: vi.fn(), onFail: vi.fn(), onSuccess: vi.fn(), onProgress: vi.fn(),
      };
      cut.run(entry);
      expect(cut.entry).toBe(entry);
      expect(entry.status).toBe(DownloadStatus.DOWNLOAD_INITIATED);

      // Work of higher and lower priority is already waiting.
      const higher = {status: DownloadStatus.ENQUEUED, priority: 2, details: {}};
      const lower = {status: DownloadStatus.ENQUEUED, priority: 0, details: {}};
      manager.queue = [higher, lower];

      manager.slowDown(5000);

      // The cut downloader let go of the entry without telling its watchers...
      expect(manager.downloaders).toHaveLength(1);
      expect(manager.downloaders[0]).toBe(kept);
      expect(cut.entry).toBe(null);
      expect(entry.downloader).toBe(null);
      expect(entry.onAbort).not.toHaveBeenCalled();
      expect(entry.onFail).not.toHaveBeenCalled();
      // ...and put it back in the queue, after higher or equal priority work.
      expect(entry.status).toBe(DownloadStatus.ENQUEUED);
      expect(manager.queue[0]).toBe(higher);
      expect(manager.queue[1]).toBe(entry);
      expect(manager.queue[2]).toBe(lower);

      // Nothing starts while the Retry-After holds...
      vi.advanceTimersByTime(4900);
      expect(kept.entry).toBeUndefined();
      vi.advanceTimersByTime(200);
      // ...then the higher-priority entry goes first...
      expect(kept.entry).toBe(higher);
      // ...and once it is done, a kept downloader runs the handed-back entry.
      kept.entry = null;
      manager.onDownloaderFinished(kept, {status: DownloadStatus.DOWNLOAD_COMPLETE});
      expect(kept.entry).toBe(entry);
    });

    it('does not abort a cut downloader that is delivering a finished download', async () => {
      const manager = new DownloadManager(client());
      const kept = idleDownloader();
      const delivering = new StandardDownloader(manager);
      manager.downloaders = [kept, delivering];

      let finish;
      const entry = {
        getRequest: () => new Promise(() => {}),
        onSuccess() {
          entry.status = DownloadStatus.DOWNLOAD_COMPLETE;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        onAbort: vi.fn(), onFail: vi.fn(), onProgress: vi.fn(),
      };
      const onSuccess = vi.spyOn(entry, 'onSuccess');
      delivering.run(entry);

      // The loader handed the whole payload over; the downloader is now delivering it.
      delivering.onSuccess(new Response(''), {loaded: 1, loading: {start: 0}}, entry, null);
      await Promise.resolve();
      expect(delivering.delivering).toBe(true);
      expect(onSuccess).toHaveBeenCalled();

      manager.slowDown(0);
      expect(delivering.delivering).toBe(true);
      expect(delivering.entry).toBe(entry);
      expect(entry.onAbort).not.toHaveBeenCalled();
      expect(entry.onFail).not.toHaveBeenCalled();

      // The delivery it started finishes: the watchers get onSuccess, not an abort.
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(delivering.delivering).toBe(false);
      expect(delivering.entry).toBe(null);
      expect(entry.downloader).toBe(null);
      expect(manager.retiring.size).toBe(0);
    });

    it('still stops a downloader that was taken away while delivering when the player resets', async () => {
      const manager = new DownloadManager(client());
      const delivering = new StandardDownloader(manager);
      manager.downloaders = [idleDownloader(), delivering];
      const entry = {
        getRequest: () => new Promise(() => {}),
        onSuccess: () => new Promise(() => {}), // still delivering
        onAbort: vi.fn(), onFail: vi.fn(), onProgress: vi.fn(),
      };
      delivering.run(entry);
      delivering.onSuccess(new Response(''), {loaded: 1, loading: {start: 0}}, entry, null);
      await Promise.resolve();
      manager.slowDown(0);
      expect(manager.retiring.has(delivering)).toBe(true);

      // A new video: an old piece must not reach the player torn down for it.
      await manager.reset();
      expect(entry.onAbort).toHaveBeenCalled();
      expect(manager.retiring.size).toBe(0);
    });

    it('probes no sooner than the Retry-After hold is over', () => {
      const manager = new DownloadManager(client());
      manager.downloaders = [finished(), finished()];
      manager.slowDown(0);
      // A later answer of the same burst asks for longer than the calm period.
      manager.slowDown(DownloadManager.MaxRetryAfterMs);
      vi.advanceTimersByTime(DownloadManager.CalmPeriodMs);
      manager.onDownloaderFinished(manager.downloaders[0], {status: DownloadStatus.DOWNLOAD_COMPLETE});
      expect(manager.probing).toBe(false);
      vi.advanceTimersByTime(DownloadManager.MaxRetryAfterMs - DownloadManager.CalmPeriodMs);
      manager.onDownloaderFinished(manager.downloaders[0], {status: DownloadStatus.DOWNLOAD_COMPLETE});
      expect(manager.probing).toBe(true);
    });

    it('probes again after a calm period when the next video\'s probe was stopped short', async () => {
      const manager = new DownloadManager(client());
      manager.throttled = true;
      await manager.reset();
      expect(manager.probing).toBe(true);
      // The add-downloader key ends the speed test by hand.
      manager.addDownloader();
      expect(manager.testing).toBe(false);
      manager.downloaders.forEach((d) => {
        d.getSpeed = () => 1e6;
      });
      vi.advanceTimersByTime(DownloadManager.CalmPeriodMs);
      manager.onDownloaderFinished(manager.downloaders[0], {status: DownloadStatus.DOWNLOAD_COMPLETE});
      expect(manager.testing).toBe(true);
      expect(manager.probing).toBe(true);
    });

    it('comes back only after the calm period, probes, and calms down when the speed stops improving', () => {
      const manager = new DownloadManager(client());
      manager.slowDown(0);
      expect(manager.throttled).toBe(true);
      expect(manager.probing).toBe(false);

      // A successful download while the calm period is still running brings nothing back.
      manager.downloaders = [finished(), finished(), finished()];
      manager.onDownloaderFinished(manager.downloaders[0], {status: DownloadStatus.DOWNLOAD_COMPLETE});
      expect(manager.probing).toBe(false);
      expect(manager.testing).toBe(false);

      // Once the server has been calm for CalmPeriodMs, success starts the probe.
      vi.advanceTimersByTime(DownloadManager.CalmPeriodMs);
      manager.onDownloaderFinished(manager.downloaders[1], {status: DownloadStatus.DOWNLOAD_COMPLETE});
      expect(manager.probing).toBe(true);
      expect(manager.testing).toBe(true);

      // The speed test then adds a downloader per two samples while the total speed rises:
      // with the same speed per downloader, up to the limit, where the probe has found the
      // rate the server takes.
      for (let i = 0; i < 40 && manager.testing; i++) {
        manager.downloaders.slice().forEach((d) => {
          d.getSpeed = () => 1e6;
          manager.onDownloaderFinished(d, {status: DownloadStatus.DOWNLOAD_COMPLETE});
        });
      }
      expect(manager.testing).toBe(false);
      expect(manager.downloaders).toHaveLength(6);
      expect(manager.probing).toBe(false);
      expect(manager.throttled).toBe(false);
      expect(manager.slowDowns).toBe(0);
    });

    it('doubles the calm period per slow-down in a row, up to MaxCalmPeriodMs, never below Retry-After', () => {
      const manager = new DownloadManager(client());
      const calmAfter = (retryAfter) => {
        // Each slow-down below is a burst of its own.
        vi.advanceTimersByTime(DownloadManager.SlowDownSettleMs);
        manager.slowDown(retryAfter);
        return manager.calmUntil - Date.now();
      };

      expect(calmAfter(0)).toBe(DownloadManager.CalmPeriodMs);
      expect(calmAfter(0)).toBe(2 * DownloadManager.CalmPeriodMs);
      expect(calmAfter(0)).toBe(4 * DownloadManager.CalmPeriodMs);
      expect(calmAfter(0)).toBe(DownloadManager.MaxCalmPeriodMs);
      expect(calmAfter(0)).toBe(DownloadManager.MaxCalmPeriodMs);

      // A Retry-After longer than the base calm period wins over it.
      const patient = new DownloadManager(client());
      patient.slowDown(90000);
      expect(patient.calmUntil - Date.now()).toBe(90000);
    });

    it('a final 429 or 503 in onDownloaderFinished neither halves again nor drops a downloader', () => {
      const manager = new DownloadManager(client());
      const downloaders = Array.from({length: 4}, () => finished(429));
      manager.downloaders = [...downloaders];
      manager.lastFailed = 12345;
      const slowDown = vi.spyOn(manager, 'slowDown');

      // slowDown() ran when the answer came; the final failure must not run it again.
      manager.onDownloaderFinished(downloaders[0], failedEntry);
      expect(slowDown).not.toHaveBeenCalled();
      expect(manager.downloaders).toEqual(downloaders);
      expect(manager.lastFailed).toBe(12345);
      expect(manager.throttled).toBe(false);

      // A 503 is signalled the same way and behaves the same.
      downloaders[1].stats.error.code = 503;
      manager.onDownloaderFinished(downloaders[1], failedEntry);
      expect(slowDown).not.toHaveBeenCalled();
      expect(manager.downloaders).toEqual(downloaders);
      expect(manager.lastFailed).toBe(12345);
    });

    it('retries a real 429 through FetchLoader and StandardDownloader after its Retry-After', async () => {
      globalThis.self = globalThis;
      const fetchMock = vi.fn()
          .mockResolvedValueOnce(new Response('', {
            status: 429, statusText: 'Too Many Requests', headers: {'Retry-After': '4'},
          }))
          .mockResolvedValueOnce(new Response('small body', {status: 200, headers: {'Content-Type': 'text/plain'}}));
      vi.stubGlobal('fetch', fetchMock);
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const manager = new DownloadManager(client());
      manager.downloaders = Array.from({length: 4}, () => new StandardDownloader(manager));

      const entry = {
        details: {url: 'https://cdn.example/1.ts'},
        getRequest: async () => ({url: 'https://cdn.example/1.ts', responseType: 'arraybuffer', headers: {}}),
        onSuccess() {
          this.status = DownloadStatus.DOWNLOAD_COMPLETE;
        },
        onFail() {
          this.status = DownloadStatus.DOWNLOAD_FAILED;
        },
        onAbort() {
          this.status = DownloadStatus.DOWNLOAD_FAILED;
        },
        onProgress() {},
      };
      const onSuccess = vi.spyOn(entry, 'onSuccess');

      const start = Date.now();
      manager.downloaders[0].run(entry);
      // The 429 halves the pool at once and holds new downloads for its Retry-After.
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(manager.slowDowns).toBe(1);
      expect(manager.throttled).toBe(true);
      expect(manager.downloaders).toHaveLength(2);
      expect(manager.holdUntil - start).toBeGreaterThanOrEqual(4000);
      expect(manager.holdUntil - start).toBeLessThan(4100);

      // The same downloader waits the Retry-After out...
      await vi.advanceTimersByTimeAsync(3500);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // ...gets the whole body on the retry, and the entry succeeds.
      await vi.advanceTimersByTimeAsync(700);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onSuccess).toHaveBeenCalled();
      expect(entry.status).toBe(DownloadStatus.DOWNLOAD_COMPLETE);
      expect(manager.slowDowns).toBe(1);
    });

    it('starts the next video with one downloader after a slow-down, its speed test a probe', async () => {
      const manager = new DownloadManager(client());
      manager.downloaders = Array.from({length: 4}, () => finished(429));
      manager.slowDown(0);
      expect(manager.throttled).toBe(true);
      expect(manager.downloaders).toHaveLength(2);

      // The next video starts carefully, with one downloader, and its speed test probes.
      await manager.reset();
      expect(manager.downloaders).toHaveLength(1);
      expect(manager.slowDowns).toBe(1);
      expect(manager.testing).toBe(true);
      expect(manager.probing).toBe(true);

      // It climbs while the speed rises; reaching the limit without a slow-down ends the caution.
      for (let i = 0; i < 40 && manager.testing; i++) {
        manager.downloaders.slice().forEach((d) => {
          d.getSpeed = () => 1e6;
          manager.onDownloaderFinished(d, {status: DownloadStatus.DOWNLOAD_COMPLETE});
        });
      }
      expect(manager.downloaders).toHaveLength(6);
      expect(manager.throttled).toBe(false);
      expect(manager.slowDowns).toBe(0);
    });
  });
});
