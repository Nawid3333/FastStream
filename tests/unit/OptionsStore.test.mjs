import {beforeEach, describe, expect, it, vi} from 'vitest';

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

  it('gives the options as they are now after a save', async () => {
    const first = OptionsStore.init();
    resolveLoad({maxSpeed: 5});
    await first;
    await OptionsStore.set({maxSpeed: 7});
    expect((await OptionsStore.init()).maxSpeed).toBe(7);
  });
});
