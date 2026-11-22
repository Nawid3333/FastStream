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

  it('starts as usual when the answer is no, an error, or there is no such API', async () => {
    const vetoed = vi.fn(async () => {
      throw new Error('denied');
    });
    await loadWithStorage({persist: vetoed});
    expect(vetoed).toHaveBeenCalledTimes(1);
    expect(bg.callbackErrors).toEqual([]);
    bg.unload();
    await loadWithStorage(undefined);
    expect(bg.callbackErrors).toEqual([]);
  });
});
