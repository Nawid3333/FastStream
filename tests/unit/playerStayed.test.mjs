import {afterEach, describe, expect, it, vi} from 'vitest';

// The player page (main.mjs) at beforeunload, which Firefox fires for a link answered with
// a download, or a "Leave page?" answered Stay, too: the page stays. The client is torn
// down there all the same (a live player keeps the page out of the back-forward cache),
// and the player stayed dead until a reload. Still here a moment later, it loads again at
// the second it was at.

const PLAYER = 'moz-extension://faststream/player/index.html?opener=page-1';

/**
 * Loads main.mjs into a stand-in page, with a client playing at the given second.
 * @param {number} time - Where the client plays.
 * @param {boolean} [inFrame] - A player in a page's frame (else a player tab).
 * @param {function(): Promise<*>} [answer] - The background's answer to PLAYER_LOADED.
 * @return {Promise<{fire: Function, client: Object, replace: Function}>}
 */
async function loadPlayerPage(time, inFrame = true, answer = () => Promise.resolve(null)) {
  vi.resetModules();
  vi.useFakeTimers();
  const listeners = new Map();
  const replace = vi.fn();
  vi.stubGlobal('window', {
    location: {href: PLAYER, search: '?opener=page-1', hash: '', replace, reload: vi.fn()},
    self: {},
    top: {},
    addEventListener: (type, handler) => listeners.set(type, handler),
  });
  if (!inFrame) window.top = window;
  vi.stubGlobal('document', {body: {}});
  vi.stubGlobal('MutationObserver', class {
    observe() {}
  });
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {addListener: vi.fn()},
      sendMessage: vi.fn((message) => message.type === 'PLAYER_LOADED' ? answer() : Promise.resolve(null)),
    },
  });
  vi.doMock('../../chrome/player/FastStreamClient.mjs', () => ({
    FastStreamClient: class {
      constructor() {
        this.version = 'test';
        this.destroy = vi.fn();
        this.handOffBuffer = vi.fn();
        this.source = {url: 'https://cdn.test/film.m3u8'};
        this.currentTime = time;
      }
      async setup() {}
      setOptions() {}
      setMediaInfo() {}
      setNeedsUserInteraction() {}
      setupPoll() {}
    },
  }));
  vi.doMock('../../chrome/player/utils/EnvUtils.mjs', () => ({EnvUtils: {isExtension: () => true}}));
  vi.doMock('../../chrome/player/utils/Utils.mjs', () => ({Utils: {
    getOptionsFromStorage: async () => ({}),
    getSubtitlesSettingsFromStorage: async () => ({}),
    printWelcome: () => {},
  }}));
  await import('../../chrome/player/main.mjs');
  // setup() ran at the import; its awaits chain before the page's listeners are added.
  for (let i = 0; i < 50 && !listeners.has('pagehide'); i++) {
    await Promise.resolve();
  }
  return {fire: (type, event) => listeners.get(type)?.(event), client: window.fastStream, replace};
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../../chrome/player/FastStreamClient.mjs');
  vi.doUnmock('../../chrome/player/utils/EnvUtils.mjs');
  vi.doUnmock('../../chrome/player/utils/Utils.mjs');
});

describe('the player page at beforeunload', () => {
  it('loads again at its second when the page stayed (a download link)', async () => {
    const {fire, client, replace} = await loadPlayerPage(1234.6);
    fire('beforeunload', {});
    // Torn down at once, as before: the back-forward cache needs it gone.
    expect(client.destroy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2999);
    expect(replace).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(replace).toHaveBeenCalledTimes(1);
    const url = new URL(replace.mock.calls[0][0]);
    expect(url.searchParams.get('faststream-timestamp')).toBe('1234');
    expect(url.searchParams.get('opener')).toBe('page-1');
  });

  it('does not load again when the page really went', async () => {
    const {fire, replace} = await loadPlayerPage(50);
    fire('beforeunload', {});
    fire('pagehide', {persisted: false});
    vi.advanceTimersByTime(10000);
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not load again in a player tab: a slow navigation there is the user choosing', async () => {
    // An address typed into a player tab whose answer took over 3 s: loading again then
    // cancelled the navigation the user asked for.
    const {fire, client, replace} = await loadPlayerPage(50, false);
    fire('beforeunload', {});
    expect(client.destroy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10000);
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not load again when the page went into the back-forward cache', async () => {
    const {fire, replace} = await loadPlayerPage(50);
    fire('beforeunload', {});
    fire('pagehide', {persisted: true});
    vi.advanceTimersByTime(10000);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('the player page, the background answering late', () => {
  it('takes a PLAYER_LOADED answer that came after beforeunload quietly', async () => {
    // beforeunload had taken the client before the background answered: the answer threw
    // on the missing client, a rejection nothing caught.
    const late = Promise.withResolvers();
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const {fire} = await loadPlayerPage(10, true, () => late.promise);
      fire('beforeunload', {});
      late.resolve({mediaInfo: {}, isMainPlayer: true});
      // Real time for Node to report a rejection nothing caught (the harness's timers are fake).
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
