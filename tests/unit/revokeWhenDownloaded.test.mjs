import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Utils} from '../../chrome/player/utils/Utils.mjs';

// A download's blob: URL is revoked only once the download is over: revoked as soon as
// downloads.download() resolved, 8 of 60 small downloads failed with no file (e2e:
// ext-specs/download-blob-lifetime.e2e.mjs drives the real one).

let listeners;
let items;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  listeners = new Set();
  items = new Map();
  globalThis.chrome = {
    downloads: {
      onChanged: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
      },
      search: async ({id}) => items.has(id) ? [items.get(id)] : [],
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete globalThis.chrome;
});

const change = (delta) => [...listeners].forEach((fn) => fn(delta));

describe('Utils.revokeWhenDownloaded', () => {
  it('keeps the URL while the download runs, and revokes it once it is complete', async () => {
    items.set(7, {id: 7, state: 'in_progress'});
    Utils.revokeWhenDownloaded('blob:a', 7);
    await vi.advanceTimersByTimeAsync(5000);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    change({id: 8, state: {current: 'complete'}});
    change({id: 7, filename: {current: 'x'}});
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    change({id: 7, state: {current: 'complete'}});
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a');
    expect(listeners.size).toBe(0);
  });

  it('says when it has revoked it, so a save can let go of its file then too', async () => {
    items.set(7, {id: 7, state: 'in_progress'});
    let over = false;
    Utils.revokeWhenDownloaded('blob:a', 7).then(() => (over = true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(over).toBe(false);
    change({id: 7, state: {current: 'complete'}});
    await vi.advanceTimersByTimeAsync(0);
    expect(over).toBe(true);
  });

  it('revokes it when the download was interrupted', async () => {
    items.set(7, {id: 7, state: 'in_progress'});
    Utils.revokeWhenDownloaded('blob:a', 7);
    await vi.advanceTimersByTimeAsync(0);
    change({id: 7, state: {current: 'interrupted'}});
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('revokes it at once when the download was over before anyone listened', async () => {
    items.set(7, {id: 7, state: 'complete'});
    Utils.revokeWhenDownloaded('blob:a', 7);
    await vi.advanceTimersByTimeAsync(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it('gives up on a download that never ends after half an hour', async () => {
    items.set(7, {id: 7, state: 'in_progress'});
    Utils.revokeWhenDownloaded('blob:a', 7);
    await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it('keeps it a minute when there is no download id to follow', async () => {
    Utils.revokeWhenDownloaded('blob:a', true);
    await vi.advanceTimersByTimeAsync(59 * 1000);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
