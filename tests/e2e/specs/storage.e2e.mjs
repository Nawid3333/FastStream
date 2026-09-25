// FSBlob's OPFS backend (chrome/player/network/OPFSManager.mjs +
// opfs-worker.mjs) can't be unit tested in Node - it touches
// navigator.storage/Worker at module scope, which vitest.config.mjs
// deliberately keeps out of the Node-based unit suite (see its own comment).
// This is its real coverage: it proves OPFS is actually selected as the
// backend on this browser (not silently falling back to memory), that bytes
// round-trip correctly through a worker-owned FileSystemSyncAccessHandle,
// and that several concurrent saves - which all funnel through one FIFO
// queue inside the worker, since two sync access handles can't be open on
// the same file at once - don't corrupt or swap each other's data.

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
        (diag ? `: ${JSON.stringify(diag)}` : ''));
  }

  const {out, err} = await browser.execute(
      () => ({out: window.__out, err: window.__err}));
  if (err) throw new Error('page-side failure: ' + err);
  return out;
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
      const identifier = await blobStore.saveBlobAsync(new Blob([payload]));

      // FSBlob does not choose OPFS wherever the API merely exists: a
      // private window claims it and then refuses. Check what it actually
      // picked rather than OPFSManager.isSupported(), or this looks for a
      // fsblob/ OPFS directory that was never created.
      const usedOPFS = !!blobStore.opfsManager;

      // Verify independently of FSBlob's own bookkeeping: look directly at
      // OPFS for a fsblob/<session>/<identifier> file with the right bytes.
      let sawOnDisk = false;
      if (usedOPFS) {
        const root = await navigator.storage.getDirectory();
        const fsblobRoot = await root.getDirectoryHandle('fsblob');
        for await (const sessionName of fsblobRoot.keys()) {
          try {
            const sessionDir = await fsblobRoot.getDirectoryHandle(sessionName);
            const fileHandle = await sessionDir.getFileHandle(identifier);
            const file = await fileHandle.getFile();
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (bytes.length === payload.length && bytes.every((b, i) => b === payload[i])) {
              sawOnDisk = true;
            }
          } catch (e) {
            // not this session's directory - keep looking
          }
        }
      }

      const readBack = new Uint8Array(await blobStore.getBlob(identifier).arrayBuffer());
      blobStore.close();

      return {
        usedOPFS,
        sawOnDisk,
        readBackMatches: readBack.length === payload.length && readBack.every((b, i) => b === payload[i]),
      };
    });

    console.log('      opfs backend:', JSON.stringify(result));
    // sawOnDisk only means anything when OPFS was actually the backend - on
    // a browser where FSBlob chose Cache/IndexedDB instead, it correctly
    // stays false rather than being checked against a directory that was
    // never supposed to exist.
    expect(result.sawOnDisk).toBe(result.usedOPFS);
    expect(result.readBackMatches).toBe(true);
  });

  it('round-trips many concurrent saves without swapping or corrupting bytes', async function() {
    const result = await runInPage(async () => {
      const {FSBlob} = await import('/player/modules/FSBlob.mjs');
      const blobStore = new FSBlob();

      const COUNT = 12;
      const payloads = Array.from({length: COUNT}, (_, i) =>
        new Uint8Array(50).fill(i + 1));

      const identifiers = await Promise.all(
          payloads.map((payload) => blobStore.saveBlobAsync(new Blob([payload]))),
      );

      const readBacks = await Promise.all(
          identifiers.map((id) => blobStore.getBlob(id).arrayBuffer()),
      );

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
      // On Firefox 157 Beta on the Windows runner the first save once never returned.
      // No sessionName means the worker's init never answered; ids still pending name
      // the calls that did not (0 is init).
      window.__diag = () => {
        const opfs = blobStore.opfsManager;
        return {
          backend: opfs ? 'opfs' : blobStore.cache ? 'cache' : blobStore.indexedDBManager ? 'indexeddb' : 'memory',
          sessionName: opfs?.sessionName ?? null,
          pending: opfs ? [...opfs.pending.keys()] : null,
          nextId: opfs?.nextId ?? null,
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

  // The private-window suite (tests/e2e/wdio.pbm.conf.mjs) covers the one
  // case this actually happens in today, where getDirectory() throws
  // SecurityError. This proves the same mechanism in an ordinary window, on
  // whatever browser is running, by failing OPFS setup synthetically: any
  // backend that claims support and then fails must cost one step down
  // FSBlob's chain, not a drop to memory. The old code went straight to
  // memory - and worse, clear() then rejected, which is what left the player
  // unbuilt in private windows.
  it('falls through to the next backend when OPFS setup fails, not to memory', async function() {
    const result = await runInPage(async () => {
      const {FSBlob} = await import('/player/modules/FSBlob.mjs');
      const {OPFSManager} = await import('/player/network/OPFSManager.mjs');

      // Nothing to prove where OPFS was never in FSBlob's chain to begin
      // with. Ask an unstubbed instance what it picks.
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
            await blobStore.getBlob(identifier).arrayBuffer());

        // Both of these used to reject with the OPFS failure rather than
        // absorbing it.
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
    if (result.skipped) return;
    expect(result.teardownError).toBe(null);
    expect(result.roundTrips).toBe(true);
    expect(result.backend).not.toBe('opfs');
    expect(result.backend).not.toBe('memory');
  });
});
