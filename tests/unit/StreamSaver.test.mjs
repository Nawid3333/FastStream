import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// A streamed save writes its file into its own blob store (an OPFS session), and the
// download reads it from there. The store used to be closed two minutes after the save
// ended, whatever the download was doing; a closed session is deleted by the next player
// or save that starts, so a download longer than that lost its file midway (#134).

const state = vi.hoisted(() => ({opfs: true, stores: []}));

vi.mock('../../chrome/player/modules/FSBlob.mjs', () => ({
  FSBlob: class {
    constructor() {
      this.close = vi.fn();
      this.blobs = new Map();
      this.opfsManager = state.opfs ? {
        saveBegin: async () => {},
        saveAppend: async () => {},
        saveEnd: async () => {},
        getSavedFile: async () => new Blob(['video']),
        saveAbort: async () => {},
      } : null;
      state.stores.push(this);
    }
    async ready() {
      return state.opfs;
    }
    createBlob(data) {
      const id = 'blob' + this.blobs.size;
      this.blobs.set(id, new Blob([data]));
      return id;
    }
    getBlob(id) {
      return this.blobs.get(id);
    }
  },
}));

const {streamSaver} = await import('../../chrome/player/modules/StreamSaver.mjs');
const {Utils} = await import('../../chrome/player/utils/Utils.mjs');

let listeners;
let items;

beforeEach(() => {
  vi.useFakeTimers();
  state.stores.length = 0;
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(Utils, 'downloadURL').mockResolvedValue(7);
  listeners = new Set();
  items = new Map([[7, {id: 7, state: 'in_progress'}]]);
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

/** Saves one chunk through a stream, and gives back the save's blob store. */
async function save() {
  const writer = streamSaver.createWriteStream('video.mp4').getWriter();
  await writer.write(new Uint8Array([1, 2, 3]));
  await writer.close();
  expect(Utils.downloadURL).toHaveBeenCalledTimes(1);
  return state.stores[0];
}

const finishDownload = () => [...listeners].forEach((fn) => fn({id: 7, state: {current: 'complete'}}));

describe.each([['OPFS', true], ['memory', false]])('a streamed save to the %s sink', (sink, opfs) => {
  beforeEach(() => {
    state.opfs = opfs;
  });

  it('keeps its blob store while the download runs, and closes it once it is over', async () => {
    const store = await save();
    // Ten minutes: a big video to a slow disk.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(store.close).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    finishDownload();
    await vi.advanceTimersByTimeAsync(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(store.close).toHaveBeenCalledTimes(1);
  });

  it('never closes it sooner than two minutes, even after a quick download', async () => {
    const store = await save();
    await vi.advanceTimersByTimeAsync(1000);
    finishDownload();
    await vi.advanceTimersByTimeAsync(118 * 1000);
    expect(store.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.close).toHaveBeenCalledTimes(1);
  });
});
