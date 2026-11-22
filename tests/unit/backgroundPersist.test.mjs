import {afterEach, describe, expect, it, vi} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// unlimitedStorage gives the extension's storage about half the disk only once it is persisted. Firefox did
// that by itself after a restart, or at once when a top-level page opened the storage first; a player framed
// in a web page opened first (a site, right after an install) kept the 10 GiB of best-effort storage for the
// rest of the session, and its own persist() answers false. The background is a top-level page.

/** @type {Awaited<ReturnType<typeof loadBackground>>} */
let bg;

afterEach(() => {
  bg?.unload();
  bg = undefined;
  vi.unstubAllGlobals();
});

/**
 * The background, loaded with a navigator.storage of the test's.
 * @param {*} storage - navigator.storage, or undefined for none.
 * @return {Promise<void>}
 */
async function loadWithStorage(storage) {
  bg = await loadBackground({beforeImport: () => vi.stubGlobal('navigator', {...globalThis.navigator, storage})});
}

describe('the background at its start', () => {
  it('asks for persistent storage once', async () => {
    const persist = vi.fn(async () => true);
    await loadWithStorage({persist});
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('leaves nothing unhandled when the answer is an error', async () => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      // Not a vi.fn: a spy follows the promise it returns, which counts as handling its rejection.
      let asked = 0;
      await loadWithStorage({persist: () => {
        asked++;
        return Promise.reject(new Error('denied'));
      }});
      expect(asked).toBe(1);
      // Real time for Node to report a rejection nothing caught (the harness's timers are fake).
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('starts where there is no navigator.storage (the import would fail on a missing API)', async () => {
    await expect(loadWithStorage(undefined)).resolves.toBeUndefined();
    await expect(loadWithStorage({})).resolves.toBeUndefined();
  });
});
