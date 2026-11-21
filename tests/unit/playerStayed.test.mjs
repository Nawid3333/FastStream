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

describe('the player page and the background', () => {
  it('pauses while mpv asks about the stream its MPV button sent', async () => {
    const {client} = await loadPlayerPage(10);
    const whileMpvAsks = vi.fn();
    client.interfaceController = {saveManager: {whileMpvAsks}};
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    const sendResponse = vi.fn();
    listener({type: 'MPV_ASKING'}, {}, sendResponse);
    expect(whileMpvAsks).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith('ok');
  });
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
    vi.advanceTimersByTime(10000);
    expect(replace).not.toHaveBeenCalled();
    fire('pagehide', {persisted: false});
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps a player tab playing when its navigation never happens (a download)', async () => {
    // Torn down at beforeunload, a player tab whose link answered with a download stayed dead:
    // it does not load again by itself (above).
    const {fire, client} = await loadPlayerPage(50, false);
    fire('beforeunload', {});
    vi.advanceTimersByTime(10000);
    expect(client.destroy).not.toHaveBeenCalled();
    expect(client.handOffBuffer).not.toHaveBeenCalled();
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

describe('the player page\'s messages', () => {
  /**
   * The page with its message listener, and a client that can take sources.
   * @return {Promise<{listener: Function, client: Object}>}
   */
  async function withListener() {
    const {client} = await loadPlayerPage(0);
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    client.source = null;
    client.options = {};
    client.interfaceController = {
      exitCarriedFullscreen: vi.fn(() => true),
      setStatusMessage: vi.fn(),
      carryFullscreen: vi.fn(),
      pipToggle: vi.fn(),
      toggleWindowedFullscreen: vi.fn(),
      subtitlesManager: {activeTracks: []},
    };
    client.addSource = vi.fn(async (s) => s);
    client.clearSubtitles = vi.fn();
    client.setAutoPlay = vi.fn();
    // As SubtitlesManager.loadTrackAndActivateBest: the track the player has already for one it has.
    const tracks = [];
    client.loadSubtitleTrack = vi.fn((track) => tracks.find((t) => t.label === track.label) ??
      (tracks.push(track), track));
    return {listener, client};
  }

  it('answers a carried fullscreen\'s Escape once, with what the player did', async () => {
    const {listener} = await withListener();
    const sendResponse = vi.fn();
    listener({type: 'EXIT_CARRIED_FULLSCREEN'}, {}, sendResponse);
    expect(sendResponse.mock.calls).toEqual([[true]]);
  });

  it('carries the fullscreen and answers when the language of the subtitles cannot be told', async () => {
    const {listener, client} = await withListener();
    chrome.i18n = {detectLanguage: (text, callback) => callback(undefined), getMessage: (key) => key};
    const sendResponse = vi.fn();
    listener({
      type: 'SOURCES',
      sources: [{url: 'https://cdn.test/ep2.m3u8', mode: 'hls', headers: {}, duration: 1400}],
      autoSetSource: true,
      subtitles: [{label: 'English', language: null, data: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello'}],
      continuationOptions: {autoPlay: true, fullscreenState: 'fullscreen'},
    }, {}, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith('sources_recieved'));
    expect(client.interfaceController.carryFullscreen).toHaveBeenCalledTimes(1);
    expect(client.loadSubtitleTrack).toHaveBeenCalledTimes(1);
    // Loaded and none turned on: the player says they are there, once.
    const said = () => client.interfaceController.setStatusMessage.mock.calls.filter((call) => call[0] === 'subtitles-hint');
    expect(said()).toHaveLength(1);
    expect(said()[0][3]).toBe(8000);
    // The frame's list sent again with another stream: no new track, nothing said again.
    listener({
      type: 'SOURCES',
      sources: [{url: 'https://cdn.test/ep3.m3u8', mode: 'hls', headers: {}, duration: 1400}],
      autoSetSource: false,
      subtitles: [{label: 'English', language: null, data: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello'}],
    }, {}, vi.fn());
    // The notice is decided in the same step as the loads.
    await vi.waitFor(() => expect(client.loadSubtitleTrack).toHaveBeenCalledTimes(2));
    expect(said()).toHaveLength(1);
  });

  it('carries the fullscreen before the subtitles are fetched', async () => {
    const {listener, client} = await withListener();
    let detected = null;
    chrome.i18n = {detectLanguage: (text, callback) => {
      detected = callback;
    }};
    listener({
      type: 'SOURCES',
      sources: [{url: 'https://cdn.test/ep2.m3u8', mode: 'hls', headers: {}, duration: 1400}],
      autoSetSource: true,
      subtitles: [{label: 'English', language: null, data: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello'}],
      continuationOptions: {autoPlay: true, fullscreenState: 'fullscreen'},
    }, {}, vi.fn());
    await vi.waitFor(() => expect(detected).not.toBe(null));
    expect(client.interfaceController.carryFullscreen).toHaveBeenCalledTimes(1);
  });
});
