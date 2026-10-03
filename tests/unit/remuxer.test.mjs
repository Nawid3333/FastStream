import {afterEach, describe, expect, it, vi} from 'vitest';

// The remuxer (Mediabunny, for what MP4Merger cannot join) keeps the file it wrote in its
// blob store, in pieces: how long the store stays open.

const stores = [];

vi.mock('../../chrome/player/modules/FSBlob.mjs', () => ({
  FSBlob: class {
    constructor() {
      stores.push(this);
      this.closed = false;
    }
    close() {
      this.closed = true;
    }
  },
}));

const {Remuxer} = await import('../../chrome/player/modules/remux/remuxer.mjs');

afterEach(() => {
  vi.useRealTimers();
});

describe('Remuxer: the blob store of a save', () => {
  it('keeps the store the saved file reads from until release()', async () => {
    // destroy() after a save that worked closed it two minutes later, and a closed OPFS
    // session is deleted by the next player or save that starts: a longer download, or
    // the same file saved again, lost it.
    vi.useFakeTimers();
    const remuxer = new Remuxer();
    remuxer.destroy();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(stores.at(-1).closed).toBe(false);

    remuxer.release();
    expect(stores.at(-1).closed).toBe(true);
  });

  it('closes the store at once when the save failed', () => {
    const remuxer = new Remuxer();
    remuxer.destroy(/* immediate */ true);
    expect(stores.at(-1).closed).toBe(true);
  });
});
