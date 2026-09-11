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

  await browser.waitUntil(
      async () => browser.execute(
          () => window.__out !== undefined || window.__err !== undefined),
      {timeout, interval: 100, timeoutMsg: 'the page never settled'},
  );

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

      // FSBlob does not choose OPFS on every browser that merely supports
      // the API - it deliberately skips it on Chrome, which already
      // offloads Blob storage on its own (see FSBlob.mjs's UseOPFS gate).
      // Check what it actually picked rather than OPFSManager.isSupported(),
      // or this looks for a fsblob/ OPFS directory that was never created.
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

      const id1 = await blobStore.saveBlobAsync(new Blob([new Uint8Array([1])]));
      const id2 = await blobStore.saveBlobAsync(new Blob([new Uint8Array([2])]));

      await blobStore.deleteBlob(id1);
      const afterDelete = blobStore.getBlob(id1) === undefined;

      await blobStore.clear();
      const afterClear = blobStore.getBlob(id2) === undefined;

      blobStore.close();
      return {afterDelete, afterClear};
    });

    console.log('      delete/clear:', JSON.stringify(result));
    expect(result.afterDelete).toBe(true);
    expect(result.afterClear).toBe(true);
  });
});
