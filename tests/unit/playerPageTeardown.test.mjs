import {describe, expect, it, vi} from 'vitest';

// The player page's teardown (main.mjs): the client goes when its page really goes, and
// stays when a navigation never happens - Firefox fires beforeunload for a link answered
// with a download or a 204 too, and the player was torn down in a page that stayed.
// main.mjs runs setup() when it is evaluated, so the stubs sit before the import.

const listeners = new Map();

vi.stubGlobal('window', {
  location: {href: 'https://page.example/watch', search: '', hash: ''},
  self: {},
  top: {},
  addEventListener: (type, handler) => listeners.set(type, handler),
});
vi.stubGlobal('document', {body: {}});
vi.stubGlobal('MutationObserver', class {
  observe() {}
});
vi.stubGlobal('chrome', {
  runtime: {
    onMessage: {addListener: vi.fn()},
    sendMessage: vi.fn(() => Promise.resolve(null)),
  },
});

vi.mock('../../chrome/player/FastStreamClient.mjs', () => ({
  FastStreamClient: class {
    constructor() {
      this.version = 'test';
      this.destroy = vi.fn();
    }
    async setup() {}
    setOptions() {}
    setMediaInfo() {}
    setNeedsUserInteraction() {}
    setupPoll() {}
  },
}));
vi.mock('../../chrome/player/utils/EnvUtils.mjs', () => ({EnvUtils: {isExtension: () => true}}));
vi.mock('../../chrome/player/utils/Utils.mjs', () => ({Utils: {
  getOptionsFromStorage: async () => ({}),
  getSubtitlesSettingsFromStorage: async () => ({}),
  printWelcome: () => {},
}}));

const {MessageTypes} = await import('../../chrome/player/enums/MessageTypes.mjs');
await import('../../chrome/player/main.mjs');
// setup() ran at the import; its awaits chain before the page's listeners are added.
for (let i = 0; i < 30 && !listeners.has('pagehide'); i++) {
  await Promise.resolve();
}

describe('the player page\'s teardown', () => {
  it('destroys the client when the page really goes, and keeps it when it does not', () => {
    const fire = (type, event) => listeners.get(type)?.(event);
    const client = window.fastStream;
    const frameRemoved = () => chrome.runtime.sendMessage.mock.calls.filter(([m]) => m.type === MessageTypes.FRAME_REMOVED);
    expect(client).toBeDefined();

    // A download link: beforeunload, and the page stays.
    fire('beforeunload', {});
    expect(client.destroy).not.toHaveBeenCalled();
    expect(window.fastStream).toBe(client);
    expect(frameRemoved()).toEqual([]);

    // Only hidden, for the back-forward cache: the page may come back with its player.
    fire('pagehide', {persisted: true});
    expect(client.destroy).not.toHaveBeenCalled();

    // Really going: torn down, and the background told the frame is gone, once.
    fire('pagehide', {persisted: false});
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(window.fastStream).toBeUndefined();
    expect(frameRemoved()).toHaveLength(1);
  });
});
