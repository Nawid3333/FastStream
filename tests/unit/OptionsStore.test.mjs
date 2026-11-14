import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// OptionsStore.init(): a second call while the first still read the storage got null, and
// one after a save got the options as first loaded, not as saved since.

let resolveLoad;
vi.mock('../../chrome/player/utils/Utils.mjs', () => ({
  Utils: {
    getOptionsFromStorage: vi.fn(() => new Promise((resolve) => {
      resolveLoad = resolve;
    })),
    mergeOptions: (defaults, options) => ({...defaults, ...options}),
    setConfig: vi.fn(async () => {}),
  },
}));

let OptionsStore;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('window', {addEventListener: () => {}, postMessage: () => {}, location: {origin: 'https://x'}});
  ({OptionsStore} = await import('../../chrome/player/options/OptionsStore.mjs'));
});

describe('OptionsStore.init', () => {
  it('gives every caller the options, also one that asks while the first load runs', async () => {
    const first = OptionsStore.init();
    const second = OptionsStore.init();
    resolveLoad({maxSpeed: 5});
    expect((await first).maxSpeed).toBe(5);
    expect((await second).maxSpeed).toBe(5);
  });

  it('reads the storage again after a read that failed', async () => {
    const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
    Utils.getOptionsFromStorage.mockImplementationOnce(async () => {
      throw new Error('storage');
    });
    await expect(OptionsStore.init()).rejects.toThrow('storage');
    const again = OptionsStore.init();
    resolveLoad({maxSpeed: 3});
    expect((await again).maxSpeed).toBe(3);
  });

  it('gives the options as they are now after a save', async () => {
    const first = OptionsStore.init();
    resolveLoad({maxSpeed: 5});
    await first;
    await OptionsStore.replace({...OptionsStore.get(), maxSpeed: 7});
    expect((await OptionsStore.init()).maxSpeed).toBe(7);
  });
});

// In the extension a save goes to the background (LOAD_OPTIONS), which tells every tab
// (UPDATE_OPTIONS) with the save's time, the page that saved included; a dragged slider saves
// once a frame. Only the echo of the latest save was known as the page's own: an earlier one
// that came after the next save was taken for a change made elsewhere, and the page redrew
// every keybind row and the search, and put the slider back mid-drag.
describe('OptionsStore in the extension', () => {
  let heard;
  let sent;
  let Utils;

  beforeEach(async () => {
    heard = [];
    sent = [];
    vi.stubGlobal('chrome', {
      extension: {},
      runtime: {sendMessage: (message) => sent.push(message), onMessage: {addListener: (fn) => heard.push(fn)}},
    });
    ({Utils} = await import('../../chrome/player/utils/Utils.mjs'));
    const loaded = OptionsStore.init();
    resolveLoad({maxSpeed: 5});
    await loaded;
    Utils.getOptionsFromStorage.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const hear = (time) => heard.forEach((fn) => fn({type: 'UPDATE_OPTIONS', time}));
  const saveAt = async (time, options) => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(time);
    await OptionsStore.replace(options);
  };

  it('knows the late echo of an earlier save of its own', async () => {
    await saveAt(1000, {maxSpeed: 6});
    await saveAt(1016, {maxSpeed: 7});
    expect(sent.map((message) => message.time)).toEqual([1000, 1016]);
    const listener = vi.fn();
    OptionsStore.subscribe(listener);

    hear(1000);
    hear(1016);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Utils.getOptionsFromStorage).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(OptionsStore.get().maxSpeed).toBe(7);
  });

  it('knows the echoes of two saves in the same millisecond', async () => {
    await saveAt(2000, {maxSpeed: 6});
    await saveAt(2000, {maxSpeed: 7});
    hear(2000);
    hear(2000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Utils.getOptionsFromStorage).not.toHaveBeenCalled();
  });

  it('still shows a change made elsewhere, also one between its own saves and their echoes', async () => {
    await saveAt(3000, {maxSpeed: 6});
    const listener = vi.fn();
    OptionsStore.subscribe(listener);

    hear(3050);
    hear(3000);
    expect(Utils.getOptionsFromStorage).toHaveBeenCalledTimes(1);
    resolveLoad({maxSpeed: 9});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listener).toHaveBeenCalled();
    expect(OptionsStore.get().maxSpeed).toBe(9);
  });
});
