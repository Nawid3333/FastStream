// FSBlob's OPFS backend in the real Firefox (vitest keeps it out): OPFS is chosen, bytes
// round-trip, concurrent saves stay apart.

import {browser, expect} from '@wdio/globals';

/** Runs an async snippet in the page and waits for it to settle - see modules.e2e.mjs for why this shape is needed over a bare browser.execute(). */
async function runInPage(fn, timeout = 30000) {
  await browser.execute((body) => {
    window.__out = undefined;
    window.__err = undefined;
    (0, eval)(`(${body})()`)
        .then((v) => {
          window.__out = v;
        })
        .catch((e) => {
          window.__err = ((e && e.message) ? e.message + '\n' : '') + ((e && e.stack) || String(e));
        });
  }, fn.toString());

  try {
    await browser.waitUntil(
        async () => browser.execute(
            () => window.__out !== undefined || window.__err !== undefined),
        {timeout, interval: 100, timeoutMsg: 'the page never settled'},
    );
  } catch (e) {
    // A snippet that sets window.__step says how far it got - which call never returned;
    // one that sets window.__diag says what the storage was doing at that point.
    const {step, diag} = await browser.execute(() => ({step: window.__step, diag: window.__diag?.()}));
    throw new Error(`the page never settled${step ? ` (last step reached: ${step})` : ''}` +
        (diag ? `: ${JSON.stringify(diag)}` : '') + `; the page's storage then: ${JSON.stringify(await storageProbe())}`);
  }

  const {out, err} = await browser.execute(
      () => ({out: window.__out, err: window.__err}));
  if (err) throw new Error('page-side failure: ' + err);
  return out;
}

/**
 * Whether the rest of the page's storage answers, for a step that never settled: OPFS from the
 * page, Cache API, IndexedDB 3 s each, the page 10 s.
 * @return {Promise<Object>} Each one's milliseconds, or what became of it.
 */
async function storageProbe() {
  const started = Date.now();
  const call = browser.execute(() => new Promise((done) => {
    const within = (promise) => {
      const begun = performance.now();
      return Promise.race([
        promise.then(() => Math.round(performance.now() - begun), (e) => `failed: ${e?.name || e}`),
        new Promise((resolve) => setTimeout(() => resolve('no answer in 3 s'), 3000)),
      ]);
    };
    const name = 'fs-e2e-probe-' + Date.now();
    Promise.all([
      within(navigator.storage.getDirectory().then(async (root) => {
        await root.getDirectoryHandle(name, {create: true});
        await root.removeEntry(name);
      })),
      within(caches.open(name).then(() => caches.delete(name))),
      within(new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => {
          request.result.close();
          indexedDB.deleteDatabase(name);
          resolve();
        };
        request.onerror = () => reject(request.error);
      })),
    ]).then(([opfs, cache, indexedDB]) => done({opfs, cache, indexedDB}));
  }));
  // Given up on, it may still fail later, with the session.
  call.catch(() => {});
  let timer;
  try {
    const answer = await Promise.race([call, new Promise((resolve) => {
      timer = setTimeout(() => resolve('the page did not answer in 10 s'), 10000);
    })]);
    return {answer, ms: Date.now() - started};
  } catch (e) {
    return {failed: e.message};
  } finally {
    clearTimeout(timer);
  }
}

describe('FSBlob storage backends', function() {
  beforeEach(async function() {
    await browser.url('/player/index.html?t=' + Date.now());
  });

  it('uses OPFS where FSBlob selects it, and writes correctly either way', async function() {
    const result = await runInPage(async () => {
      const {FSBlob} = await import('/player/modules/FSBlob.mjs');

      const blobStore = new FSBlob();
      const payload = new Uint8Array([10, 20, 30, 40, 50]);
      // FSBlob's made-up names and DownloadManager's identifiers (URL and range, with '/') are both
      // stored.
      const identifiers = [
        await blobStore.saveBlobAsync(new Blob([payload])),
        await blobStore.saveBlobAsync(new Blob([payload]), 'https://cdn.example/v/seg-1.ts::0-100::arraybuffer'),
      ];

      // what FSBlob actually picked, not OPFSManager.isSupported(): a private window claims it and
      // refuses
      const usedOPFS = !!blobStore.opfsManager;
      const matches = (bytes) => bytes.length === payload.length && bytes.every((b, i) => b === payload[i]);

      const results = [];
      for (const identifier of identifiers) {
        // Verify independently of FSBlob's own bookkeeping: look directly at
        // OPFS for a fsblob/<session>/<file name> file with the right bytes.
        let sawOnDisk = false;
        // In this store's own session directory: another session's file of the same name
        // (an earlier test's, or another tab's) proves nothing about this one.
        const name = usedOPFS ? blobStore.opfsManager.fileName(identifier) : null;
        if (name) {
          try {
            const root = await navigator.storage.getDirectory();
            const fsblobRoot = await root.getDirectoryHandle('fsblob');
            const sessionDir = await fsblobRoot.getDirectoryHandle(blobStore.opfsManager.sessionName);
            const fileHandle = await sessionDir.getFileHandle(name);
            const file = await fileHandle.getFile();
            sawOnDisk = matches(new Uint8Array(await file.arrayBuffer()));
          } catch (e) {
            // Not there.
          }
        }

        // the store hands back the file on disk, not a copy in RAM
        const stored = blobStore.getBlob(identifier);
        results.push({
          sawOnDisk,
          diskBacked: stored instanceof File && !!name && stored.name === name,
          readBackMatches: matches(new Uint8Array(await stored.arrayBuffer())),
        });
      }
      blobStore.close();

      return {usedOPFS, results};
    });

    console.log('      opfs backend:', JSON.stringify(result));
    // sawOnDisk counts only where OPFS was the backend
    for (const stored of result.results) {
      expect(stored.sawOnDisk).toBe(result.usedOPFS);
      expect(stored.diskBacked).toBe(result.usedOPFS);
      expect(stored.readBackMatches).toBe(true);
    }
    // An ordinary window, where FSBlob picks OPFS: a build that never chose it fails here.
    expect(result.usedOPFS).toBe(true);
  });

  it('gives two players starting together on a fresh profile the same salts', async function() {
    // Two tabs making the salt at once keep one: the first tab's saved positions stay findable.
    const result = await runInPage(async () => {
      const {SecureMemory} = await import('/player/modules/SecureMemory.mjs');
      const {IndexedDBManager} = await import('/player/network/IndexedDBManager.mjs');
      const name = 'faststream-salt-race-' + Date.now();
      const tabs = [new SecureMemory(name), new SecureMemory(name)];
      await Promise.all(tabs.map((tab) => tab.setup()));
      const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
      // Of two adds of one key at once, exactly one stores and the other is told so.
      const db = tabs[0].indexedDbManager.getDatabase();
      const adds = await Promise.all([
        IndexedDBManager.addValue(db, 'metadata', 'race', 'first'),
        IndexedDBManager.addValue(db, 'metadata', 'race', 'second'),
      ]).catch((e) => String(e));
      const out = {
        identifier: same(tabs[0].identifierSalt, tabs[1].identifierSalt),
        key: same(tabs[0].keySalt, tabs[1].keySalt),
        adds,
        stored: await IndexedDBManager.getValue(db, 'metadata', 'race'),
      };
      tabs.forEach((tab) => tab.destroy());
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = request.onerror = request.onblocked = resolve;
      });
      return out;
    });
    expect(result).toEqual({identifier: true, key: true, adds: [true, false], stored: 'first'});
  });

  it('keeps an intact remembered time when reading it failed, and starts over a broken one', async function() {
    // A read that fails does not start at 0 and save over the intact record.
    const result = await runInPage(async () => {
      const {FastStreamClient} = await import('/player/FastStreamClient.mjs');
      const load = async (failure) => {
        const client = {
          readProgressData: FastStreamClient.prototype.readProgressData,
          options: {storeProgress: true},
          player: {getSource: () => ({identifier: 'video'})},
          disableProgressSave: false,
          progressData: null,
          progressMemory: {
            getHashes: async () => ({identifierHash: 'id', keyHash: 'key'}),
            getFile: async () => {
              throw failure;
            },
          },
        };
        await FastStreamClient.prototype.loadProgressData.call(client);
        return {progressData: client.progressData, disableProgressSave: client.disableProgressSave};
      };
      const unusable = Object.assign(new Error('The saved record does not decrypt'), {unusableRecord: true});
      return {
        readFailed: await load(new Error('IndexedDB is having a moment')),
        unusable: await load(unusable),
      };
    });
    console.log('      progress:', JSON.stringify(result));
    // No progress kept, so nothing saves over the record.
    expect(result.readFailed.progressData).toBeNull();
    expect(result.unusable.progressData).toEqual({lastTime: 0});
  });

  it('logs a remembered time it could not save, instead of an unhandled rejection every second', async function() {
    const result = await runInPage(async () => {
      const {FastStreamClient} = await import('/player/FastStreamClient.mjs');
      let unhandled = 0;
      const onUnhandled = () => unhandled++;
      window.addEventListener('unhandledrejection', onUnhandled);
      const client = {
        disableProgressSave: false,
        progressData: {lastTime: 5},
        progressHashesCache: {},
        progressMemory: {setFile: async () => {
          throw new Error('QuotaExceededError');
        }},
      };
      const outcome = await FastStreamClient.prototype.saveProgressData.call(client)
          .then(() => 'resolved', () => 'rejected');
      await new Promise((resolve) => setTimeout(resolve, 200));
      window.removeEventListener('unhandledrejection', onUnhandled);
      return {outcome, unhandled};
    });
    expect(result).toEqual({outcome: 'resolved', unhandled: 0});
  });

  it('round-trips many concurrent saves without swapping or corrupting bytes', async function() {
    const result = await runInPage(async () => {
      const {FSBlob} = await import('/player/modules/FSBlob.mjs');
      const blobStore = new FSBlob();
      // the step reached and the calls still waiting, if it never settles
      window.__diag = () => {
        const opfs = blobStore.opfsManager;
        return {
          backend: opfs ? 'opfs' : blobStore.cache ? 'cache' : blobStore.indexedDBManager ? 'indexeddb' : 'memory',
          sessionName: opfs?.sessionName ?? null,
          pending: opfs ? opfs.pendingCalls() : null,
          worker: opfs ? !!opfs.worker : null,
        };
      };

      const COUNT = 12;
      const payloads = Array.from({length: COUNT}, (_, i) =>
        new Uint8Array(50).fill(i + 1));

      window.__step = 'saves';
      const identifiers = await Promise.all(
          payloads.map((payload) => blobStore.saveBlobAsync(new Blob([payload]))),
      );

      window.__step = 'reads';
      const readBacks = await Promise.all(
          // getBlob answers a promise for a blob the Cache API holds (read when asked for).
          identifiers.map(async (id) => (await blobStore.getBlob(id)).arrayBuffer()),
      );

      window.__step = 'close';
      blobStore.close();

      return readBacks.every((buf, i) => {
        const bytes = new Uint8Array(buf);
        return bytes.length === payloads[i].length && bytes.every((b) => b === i + 1);
      });
    });

    console.log('      concurrent round-trip ok:', result);
    expect(result).toBe(true);
  });

  it('deleteBlob removes the OPFS file, and clear() empties the session directory', async function() {
    const result = await runInPage(async () => {
      const {FSBlob} = await import('/player/modules/FSBlob.mjs');
      const blobStore = new FSBlob();
      // No sessionName: the worker's init never answered; pending names the calls still waiting.
      window.__diag = () => {
        const opfs = blobStore.opfsManager;
        return {
          backend: opfs ? 'opfs' : blobStore.cache ? 'cache' : blobStore.indexedDBManager ? 'indexeddb' : 'memory',
          sessionName: opfs?.sessionName ?? null,
          pending: opfs ? opfs.pendingCalls() : null,
          worker: opfs ? !!opfs.worker : null,
        };
      };

      window.__step = 'save 1';
      const id1 = await blobStore.saveBlobAsync(new Blob([new Uint8Array([1])]));
      window.__step = 'save 2';
      const id2 = await blobStore.saveBlobAsync(new Blob([new Uint8Array([2])]));

      window.__step = 'deleteBlob';
      await blobStore.deleteBlob(id1);
      const afterDelete = blobStore.getBlob(id1) === undefined;

      window.__step = 'clear';
      await blobStore.clear();
      const afterClear = blobStore.getBlob(id2) === undefined;

      window.__step = 'close';

      blobStore.close();
      return {afterDelete, afterClear};
    });

    console.log('      delete/clear:', JSON.stringify(result));
    expect(result.afterDelete).toBe(true);
    expect(result.afterClear).toBe(true);
  });

  // A backend that claims support and then fails costs one step down FSBlob's chain, not a drop to
  // memory (as in a private window).
  // A live OPFS worker that goes silent counts as crashed past its timeout, and the store moves on.
  it('moves to the next backend when the OPFS worker stops answering mid-session', async function() {
    const result = await runInPage(async () => {
      const {FSBlob} = await import('/player/modules/FSBlob.mjs');
      const {OPFSManager} = await import('/player/network/OPFSManager.mjs');
      const probe = new FSBlob();
      const opfsIsInChain = !!probe.opfsManager;
      probe.close();
      if (!opfsIsInChain) {
        return {skipped: true};
      }

      const timeout = OPFSManager.CallTimeoutMs;
      try {
        const blobStore = new FSBlob();
        await blobStore.ready();
        const before = !!blobStore.opfsManager;
        if (!before) {
          blobStore.close();
          return {skipped: false, before};
        }
        const first = await blobStore.saveBlobAsync(new Blob([new Uint8Array([1, 2, 3])]));
        const firstOnDisk = blobStore.getBlob(first) instanceof File;

        // the timeout shortened only now: the worker's start can take longer on a slow runner
        OPFSManager.CallTimeoutMs = 500;
        blobStore.opfsManager.worker.postMessage = () => {};
        // the monotonic clock: the wall clock can be set back mid-wait
        const started = performance.now();
        const payload = new Uint8Array([4, 5, 6, 7]);
        const second = await blobStore.saveBlobAsync(new Blob([payload]));
        const waited = performance.now() - started;
        // The Cache API now: getBlob answers a promise, read when asked for.
        const readBack = new Uint8Array(await (await blobStore.getBlob(second)).arrayBuffer());
        const after = blobStore.opfsManager ? 'opfs' :
          (blobStore.cache ? 'cache' : (blobStore.indexedDBManager ? 'indexeddb' : 'memory'));
        blobStore.close();
        return {
          skipped: false, before, firstOnDisk, waited, after,
          roundTrips: readBack.length === payload.length && readBack.every((b, i) => b === payload[i]),
        };
      } finally {
        OPFSManager.CallTimeoutMs = timeout;
      }
    });

    console.log('      silent OPFS worker:', JSON.stringify(result));
    if (result.skipped) {
      // eslint-disable-next-line no-invalid-this
      this.skip();
    }
    expect(result.before).toBe(true);
    expect(result.firstOnDisk).toBe(true);
    expect(result.after).not.toBe('opfs');
    expect(result.after).not.toBe('memory');
    expect(result.roundTrips).toBe(true);
    // It waited for the timeout, not for good.
    expect(result.waited).toBeGreaterThanOrEqual(400);
    expect(result.waited).toBeLessThan(10000);
  });

  it('falls through to the next backend when OPFS setup fails, not to memory', async function() {
    const result = await runInPage(async () => {
      const {FSBlob} = await import('/player/modules/FSBlob.mjs');
      const {OPFSManager} = await import('/player/network/OPFSManager.mjs');

      // nothing to prove where OPFS was never in the chain: an unstubbed instance says what it
      // picks
      const probe = new FSBlob();
      const opfsIsInChain = !!probe.opfsManager;
      probe.close();
      if (!opfsIsInChain) {
        return {skipped: true};
      }

      const originalSetup = OPFSManager.prototype.setup;
      OPFSManager.prototype.setup = function() {
        return Promise.reject(new Error('synthetic OPFS setup failure'));
      };

      try {
        const blobStore = new FSBlob();
        const payload = new Uint8Array([21, 22, 23, 24]);
        const identifier = await blobStore.saveBlobAsync(new Blob([payload]));

        const backend = blobStore.opfsManager ? 'opfs' :
          (blobStore.cache ? 'cache' :
            (blobStore.indexedDBManager ? 'indexeddb' : 'memory'));

        const readBack = new Uint8Array(
            await (await blobStore.getBlob(identifier)).arrayBuffer());

        // both absorb the OPFS failure
        let teardownError = null;
        try {
          await blobStore.deleteBlob(identifier);
          await blobStore.clear();
        } catch (e) {
          teardownError = (e && e.message) || String(e);
        }

        blobStore.close();
        return {
          skipped: false,
          backend,
          teardownError,
          roundTrips: readBack.length === payload.length &&
              readBack.every((b, i) => b === payload[i]),
        };
      } finally {
        OPFSManager.prototype.setup = originalSetup;
      }
    });

    console.log('      opfs fall-through:', JSON.stringify(result));
    if (result.skipped) {
      // Reported as skipped, not as a pass with nothing checked.
      // eslint-disable-next-line no-invalid-this
      this.skip();
    }
    expect(result.teardownError).toBe(null);
    expect(result.roundTrips).toBe(true);
    expect(result.backend).not.toBe('opfs');
    expect(result.backend).not.toBe('memory');
  });
});
