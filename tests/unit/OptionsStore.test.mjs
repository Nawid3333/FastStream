import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The storage as a stand-in: a read before anything was stored waits for resolveLoad, one
// after answers what is stored.
let resolveLoad;
let stored = null;
vi.mock('../../chrome/player/utils/Utils.mjs', () => ({
  Utils: {
    getOptionsFromStorage: vi.fn(() => stored ? Promise.resolve(structuredClone(stored)) : new Promise((resolve) => {
      resolveLoad = (value) => {
        stored = value;
        resolve(structuredClone(value));
      };
    })),
    mergeOptions: (defaults, options) => ({...defaults, ...options}),
    setConfig: vi.fn(async (key, value) => {
      stored = JSON.parse(value);
    }),
  },
}));

let OptionsStore;

beforeEach(async () => {
  vi.resetModules();
  stored = null;
  vi.stubGlobal('window', {addEventListener: () => {}, postMessage: () => {}, location: {origin: 'https://x'}});
  ({OptionsStore} = await import('../../chrome/player/options/OptionsStore.mjs'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

describe('OptionsStore.replace', () => {
  beforeEach(async () => {
    const loaded = OptionsStore.init();
    resolveLoad({maxSpeed: 5, autoplayNext: true});
    await loaded;
  });

  it('keeps a save made elsewhere since the page read the options, and shows it', async () => {
    // A player's settings, or the background (the mpv switches), saved after this page read
    // the options: the page wrote its whole copy, and put that save back.
    stored = {...stored, autoplayNext: false};
    const listener = vi.fn();
    OptionsStore.subscribe(listener);
    await OptionsStore.replace({...OptionsStore.get(), maxSpeed: 7});
    expect(stored).toMatchObject({maxSpeed: 7, autoplayNext: false});
    expect(OptionsStore.get()).toMatchObject({maxSpeed: 7, autoplayNext: false});
    expect(listener.mock.calls[0][0]).toMatchObject({autoplayNext: false});
  });

  it('writes a change of the page\'s own made in place, as the options page makes them', async () => {
    const options = OptionsStore.get();
    options.maxSpeed = 8;
    await OptionsStore.replace(options);
    expect(stored.maxSpeed).toBe(8);
  });

  it('writes two saves one after the other: the second keeps the first', async () => {
    const first = OptionsStore.replace({...OptionsStore.get(), maxSpeed: 7});
    const second = OptionsStore.replace({...OptionsStore.get(), autoplayNext: false});
    await Promise.all([first, second]);
    expect(stored).toMatchObject({maxSpeed: 7, autoplayNext: false});
  });

  it('tells its listeners of its own save with the object it gave out, so the page is not redrawn', async () => {
    const listener = vi.fn();
    OptionsStore.subscribe(listener);
    const saving = OptionsStore.replace({...OptionsStore.get(), maxSpeed: 7});
    const own = OptionsStore.get();
    await saving;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toBe(own);
  });
});

// The player saves its autoplay switch with it, and has no options form.
describe('OptionsStore.set', () => {
  it('reads the options first, then writes only its own key over what is stored', async () => {
    const saving = OptionsStore.set('autoplayNext', true);
    resolveLoad({maxSpeed: 5, autoplayNext: false});
    stored = {...stored, maxSpeed: 9};
    await saving;
    expect(stored).toMatchObject({maxSpeed: 9, autoplayNext: true});
  });

  it('keeps the order of two quick switches', async () => {
    const loaded = OptionsStore.init();
    resolveLoad({autoplayNext: false});
    await loaded;
    await Promise.all([OptionsStore.set('autoplayNext', true), OptionsStore.set('autoplayNext', false)]);
    expect(stored.autoplayNext).toBe(false);
  });
});

// In the extension a save goes to the background (LOAD_OPTIONS), which tells every tab
// (UPDATE_OPTIONS) with the save's time, the page that saved included; a dragged slider saves
// once a frame. An echo of the page's own save taken for a change made elsewhere redrew every
// keybind row and the search, and put the slider back mid-drag.
describe('OptionsStore in the extension', () => {
  let heard;
  let sent;

  beforeEach(async () => {
    heard = [];
    sent = [];
    vi.stubGlobal('chrome', {
      extension: {},
      runtime: {sendMessage: (message) => sent.push(message), onMessage: {addListener: (fn) => heard.push(fn)}},
    });
    const loaded = OptionsStore.init();
    resolveLoad({maxSpeed: 5});
    await loaded;
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
    await settle();
    expect(listener).not.toHaveBeenCalled();
    expect(OptionsStore.get().maxSpeed).toBe(7);
  });

  it('knows the echoes of two saves in the same millisecond', async () => {
    await saveAt(2000, {maxSpeed: 6});
    await saveAt(2000, {maxSpeed: 7});
    const listener = vi.fn();
    OptionsStore.subscribe(listener);
    hear(2000);
    hear(2000);
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });

  it('reads a change made elsewhere only after its own save is written', async () => {
    // Read before the write, it showed the value the page had just replaced.
    const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
    let finishWrite;
    Utils.setConfig.mockImplementationOnce((key, value) => new Promise((resolve) => {
      finishWrite = () => {
        stored = JSON.parse(value);
        resolve();
      };
    }));
    const saving = OptionsStore.replace({...OptionsStore.get(), maxSpeed: 7});
    await settle();
    hear(9999);
    await settle();
    finishWrite();
    await saving;
    await settle();
    expect(OptionsStore.get().maxSpeed).toBe(7);
  });

  it('still shows a change made elsewhere, also one between its own saves and their echoes', async () => {
    await saveAt(3000, {maxSpeed: 6});
    const listener = vi.fn();
    OptionsStore.subscribe(listener);

    stored = {...stored, maxSpeed: 9};
    hear(3050);
    hear(3000);
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(OptionsStore.get().maxSpeed).toBe(9);
  });
});
