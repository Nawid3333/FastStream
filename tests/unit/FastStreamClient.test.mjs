import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// FastStreamClient's own logic, run on a client whose parts (the interface, the download
// manager, the analyzers, the player) are stand-ins: the real ones need a page. The client
// is made without its constructor, which builds all of those and starts the main loop.

vi.mock('../../chrome/player/ui/InterfaceController.mjs', () => ({InterfaceController: class {}}));
vi.mock('../../chrome/player/ui/KeybindManager.mjs', () => ({KeybindManager: class {}}));
vi.mock('../../chrome/player/ui/FrameStepper.mjs', () => ({FrameStepper: class {}}));
vi.mock('../../chrome/player/network/DownloadManager.mjs', () => ({DownloadManager: class {}}));
vi.mock('../../chrome/player/modules/analyzer/VideoAnalyzer.mjs', () => ({VideoAnalyzer: class {}}));
vi.mock('../../chrome/player/ui/SourcesBrowser.mjs', () => ({SourcesBrowser: class {}}));
vi.mock('../../chrome/player/players/PlayerLoader.mjs', () => ({PlayerLoader: class {}}));
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {playerContainer: {style: {}}}}));
vi.mock('../../chrome/player/ui/audio/AudioConfigManager.mjs', () => ({AudioConfigManager: class {}}));
vi.mock('../../chrome/player/utils/EnvUtils.mjs', () => ({
  EnvUtils: {
    isWebAudioSupported: () => false,
    isExtension: () => true,
    isIncognito: () => false,
    getAvailableStorage: async () => 1e12,
  },
}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key, getLanguageMatchLevel: () => 0}}));
vi.mock('../../chrome/player/modules/SecureMemory.mjs', () => ({SecureMemory: class {}}));
vi.mock('../../chrome/player/utils/CSSFilterUtils.mjs', () => ({CSSFilterUtils: {getFilterString: () => '', getTransformString: () => ''}}));
vi.mock('../../chrome/player/utils/Utils.mjs', () => ({Utils: {mergeOptions: (a) => a}}));
vi.mock('../../chrome/player/modules/analyzer/AudioAnalyzer.mjs', () => ({AudioAnalyzer: class {}}));
vi.mock('../../chrome/player/modules/analyzer/PreviewFrameExtractor.mjs', () => ({PreviewFrameExtractor: class {}}));
vi.mock('../../chrome/player/ui/StatusManager.mjs', () => ({StatusTypes: {INFO: 'info', REQINTERACTION: 'reqinteraction'}}));
vi.mock('../../chrome/player/utils/InterfaceUtils.mjs', () => ({InterfaceUtils: {}}));
vi.mock('../../chrome/player/ui/audio/VirtualAudioNode.mjs', () => ({VirtualAudioNode: class {}}));
vi.mock('../../chrome/player/players/SyncedAudioPlayer.mjs', () => ({
  SyncedAudioPlayer: class {
    setPlaybackRate() {}
    async setup() {}
    setVideoDelay() {}
    setVolume() {
      return false;
    }
    setCurrentTime() {}
    setLevel() {}
    async play() {}
    async pause() {}
    destroy() {}
  },
}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({AlertPolyfill: {errorSendToDeveloper: () => {}}}));

const {FastStreamClient} = await import('../../chrome/player/FastStreamClient.mjs');
const {EventEmitter} = await import('../../chrome/player/modules/eventemitter.mjs');
const {DefaultPlayerEvents} = await import('../../chrome/player/enums/DefaultPlayerEvents.mjs');
const {DownloadStatus} = await import('../../chrome/player/enums/DownloadStatus.mjs');
const {ReferenceTypes} = await import('../../chrome/player/enums/ReferenceTypes.mjs');
const {MessageTypes} = await import('../../chrome/player/enums/MessageTypes.mjs');
const {Fragment} = await import('../../chrome/player/players/Fragment.mjs');
const {LevelManager} = await import('../../chrome/player/players/LevelManager.mjs');

/** A player as the player loader makes one, with what the client reads and sets on it. */
class FakePlayer extends EventEmitter {
  constructor(source) {
    super();
    this.source = source;
    this.video = {readyState: 1, style: {}, videoWidth: 640, videoHeight: 360};
    this.duration = 60;
    this.seeks = [];
    this._currentTime = 0;
    this.paused = true;
    this.videoLevel = null;
    this.audioLevel = null;
  }
  async setup() {}
  async setSource() {}
  getSource() {
    return this.source;
  }
  getVideo() {
    return this.video;
  }
  get currentTime() {
    return this._currentTime;
  }
  set currentTime(value) {
    this._currentTime = value;
    this.seeks.push(value);
  }
  async play() {
    this.paused = false;
  }
  async pause() {
    this.paused = true;
  }
  destroy() {
    this.emit(DefaultPlayerEvents.DESTROYED);
  }
  getVideoLevels() {
    return new Map();
  }
  getAudioLevels() {
    return new Map();
  }
  getCurrentVideoLevelID() {
    return this.videoLevel;
  }
  getCurrentAudioLevelID() {
    return this.audioLevel;
  }
  setCurrentVideoLevelID() {}
  setCurrentAudioLevelID() {}
}

/**
 * A video source.
 * @param {string} url
 * @param {Object} [extra] - More fields, such as defaultLevelInfo.
 * @return {Object}
 */
function makeSource(url, extra = {}) {
  const source = {url, identifier: url, mode: 'hls', headers: {}, ...extra, destroy() {}};
  source.copy = () => ({...source});
  return source;
}

/**
 * Remembered times: getFile answers with `record`, after `wait` if one is given.
 * @param {?Object} record
 * @param {Promise} [wait]
 * @return {Object}
 */
function makeProgressMemory(record, wait = null) {
  return {
    getHashes: vi.fn(async () => {
      if (wait) await wait;
      return ['h1', 'h2'];
    }),
    getFile: vi.fn(async () => record),
    setFile: vi.fn(async () => {}),
  };
}

/**
 * A client without its constructor, its parts stood in for.
 * @param {Object} [options] - Options over the defaults below.
 * @return {FastStreamClient}
 */
function makeClient(options = {}) {
  const client = Object.create(FastStreamClient.prototype);
  Object.assign(client, new EventEmitter());
  Object.assign(client, {
    options: {
      autoPlay: false, autoplayNext: false, storeProgress: false, disableLoadProgress: false,
      previewEnabled: false, videoDelay: 0, freeUnusedChannels: true, downloadAll: false,
      bufferAhead: 300, bufferBehind: 20, maxVideoSize: 0,
      ...options,
    },
    state: {
      playing: false, buffering: false, currentTime: 0, volume: 1, playbackRate: 1,
      autoPlayTriggered: false, hasNextVideo: false, hasPrevVideo: false,
      bufferAhead: 300, bufferBehind: 20, fullscreen: false, windowedFullscreen: false, miniplayer: false,
    },
    fragmentsStore: {},
    pastSeeks: [],
    pastUnseeks: [],
    saveSeek: true,
    playPauseTurn: 0,
    sourceRequests: 0,
    fallbacks: {request: 0, sources: []},
    player: null,
    source: null,
    context: null,
    previewContext: null,
    previewPlayer: null,
    syncedAudioPlayer: null,
    audioContext: null,
    audioSource: null,
    progressMemory: null,
    interfaceController: {
      saveManager: null,
      reset: vi.fn(),
      setStatusMessage: vi.fn(),
      addVideo: vi.fn(),
      updateToolVisibility: vi.fn(),
      failedToLoad: vi.fn(),
      setBuffering: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      updateQualityLevels: vi.fn(),
      updateLanguageTracks: vi.fn(),
      updateFragmentsLoaded: vi.fn(),
      timeUpdated: vi.fn(),
      updateMarkers: vi.fn(),
      durationChanged: vi.fn(),
      isInPip: () => false,
      isUserSeeking: () => false,
    },
    downloadManager: {reset: vi.fn(async () => {}), removeFile: vi.fn(), removeAllDownloaders: vi.fn()},
    audioAnalyzer: {reset: vi.fn(), setLevel: vi.fn(), updateBackgroundAnalyzer: vi.fn()},
    frameExtractor: {reset: vi.fn(), setLevel: vi.fn(), updateBackground: vi.fn()},
    videoAnalyzer: {setLevel: vi.fn(), setSource: vi.fn(async () => {}), pushFrame: () => false},
    audioConfigManager: {updateChannelCount: vi.fn()},
    frameStepper: {watch: vi.fn()},
    sourcesBrowser: {updateSources: vi.fn()},
    playerLoader: {createPlayer: vi.fn(async (mode, c, config) => new FakePlayer(null))},
  });
  client.levelManager = new LevelManager(client);
  return client;
}

/**
 * Lets the promise chains the client started run.
 * @return {Promise<void>}
 */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/**
 * Sets a source the way FastStreamClient.setSource does, with a FakePlayer for it.
 * @param {FastStreamClient} client
 * @param {Object} source
 * @param {Function} [prepare] - Called with the player before the source is set on it.
 * @return {Promise<FakePlayer>}
 */
async function setSource(client, source, prepare = () => {}) {
  let made = null;
  client.playerLoader.createPlayer = vi.fn(async () => {
    made = new FakePlayer(source);
    prepare(made);
    return made;
  });
  client.sourceRequests++;
  await client.setSourceInternal(source, {request: client.sourceRequests, sources: []});
  await settle();
  return made;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {getItem: () => null, setItem: () => {}});
  vi.stubGlobal('window', {location: {href: 'moz-extension://faststream/player/index.html'}, top: {}, self: {}});
  vi.stubGlobal('chrome', {runtime: {sendMessage: vi.fn()}});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FastStreamClient, a source that never shows a picture', () => {
  it('stops its once-a-second wait for a picture when the next source comes', async () => {
    // The wait's interval was cleared only once some later source had a picture, and each
    // source that failed first (a dead manifest, a chain of fallbacks) left one running.
    vi.useFakeTimers();
    const client = makeClient();
    const player = new FakePlayer(makeSource('http://127.0.0.1/dead.m3u8'));
    player.duration = 0;
    player.video.readyState = 0;
    client.player = player;
    client.context = player.createContext();
    client.setupInitHook();
    expect(vi.getTimerCount()).toBe(1);

    await client.resetPlayer();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('FastStreamClient, autoplay', () => {
  it('leaves autoplay to be tried again when the browser blocks it at canplay', async () => {
    // Marked as done before the attempt, so the retry once the remembered time was applied
    // was skipped; and the blocked play() was an unhandled rejection.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient({autoPlay: true});
    const player = new FakePlayer(makeSource('http://127.0.0.1/a.m3u8'));
    client.player = player;
    client.bindPlayer(player);
    client.play = vi.fn(() => Promise.reject(new Error('NotAllowedError: autoplay blocked')));

    player.emit(DefaultPlayerEvents.CANPLAY);
    await settle();

    expect(client.play).toHaveBeenCalledTimes(1);
    expect(client.state.autoPlayTriggered).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('marks autoplay as done once it has started', async () => {
    const client = makeClient({autoPlay: true});
    const player = new FakePlayer(makeSource('http://127.0.0.1/a.m3u8'));
    client.player = player;
    client.bindPlayer(player);
    client.play = vi.fn(async () => {});

    player.emit(DefaultPlayerEvents.CANPLAY);
    await settle();

    expect(client.state.autoPlayTriggered).toBe(true);
  });
});

describe('FastStreamClient, a change of quality', () => {
  /**
   * A downloaded fragment of a level.
   * @param {string} level
   * @param {number} sn
   * @return {Fragment}
   */
  function downloaded(level, sn) {
    const fragment = new Fragment(level, sn);
    fragment.status = DownloadStatus.DOWNLOAD_COMPLETE;
    fragment.getContext = () => ({url: `http://127.0.0.1/${level}/${sn}.ts`});
    return fragment;
  }

  it('frees the level it leaves, but not the fragments a save is writing', () => {
    // A save holds its fragments (SAVER) until it has written them: freed, they were
    // downloaded a second time.
    const client = makeClient();
    const player = new FakePlayer(makeSource('http://127.0.0.1/a.m3u8'));
    client.player = player;
    const saving = downloaded('0:0', 0);
    saving.addReference(ReferenceTypes.SAVER);
    const played = downloaded('0:0', 1);
    client.fragmentsStore['0:0'] = [saving, played];
    client.levelManager.setCurrentVideoLevelID('0:0');

    player.videoLevel = '0:1';
    client.checkLevelChange();

    expect(played.status).toBe(DownloadStatus.WAITING);
    expect(saving.status).toBe(DownloadStatus.DOWNLOAD_COMPLETE);
    expect(client.downloadManager.removeFile).toHaveBeenCalledTimes(1);
    expect(client.levelManager.getCurrentVideoLevelID()).toBe('0:1');
  });
});

describe('FastStreamClient, a source opened from an archive', () => {
  it('asks for the archive\'s audio track as well as its video level', async () => {
    // SaveManager names it audioLevel, and this read `audio`: never restored.
    const client = makeClient();
    const source = makeSource('http://127.0.0.1/a.m3u8', {defaultLevelInfo: {level: '0:2', audioLevel: '1:1'}});
    let seeded = null;
    await setSource(client, source, () => {
      seeded = {video: client.levelManager.getCurrentVideoLevelID(), audio: client.levelManager.getCurrentAudioLevelID()};
    });
    expect(seeded).toEqual({video: '0:2', audio: '1:1'});
  });
});

describe('FastStreamClient, remembered times', () => {
  it('does not seek a live stream to the time it was left at', async () => {
    // A live stream's duration is Infinity, and "the time is before the end" always held:
    // the next day it was sought far outside the live window.
    const client = makeClient({storeProgress: true});
    client.progressMemory = makeProgressMemory({lastTime: 3600});
    const player = await setSource(client, makeSource('http://127.0.0.1/live.mpd'), (made) => {
      made.duration = Infinity;
    });
    expect(player.seeks).not.toContain(3600);
  });

  it('does not seek a live HLS stream either, whose duration is the end of its window', async () => {
    // hls.js, as HLSPlayer sets it up, gives a live stream a finite duration that grows:
    // only the player can say it is live.
    const client = makeClient({storeProgress: true});
    client.progressMemory = makeProgressMemory({lastTime: 60});
    const player = await setSource(client, makeSource('http://127.0.0.1/live.m3u8'), (made) => {
      made.duration = 120;
      made.isLive = true;
    });
    expect(player.seeks).not.toContain(60);
  });

  it('does not remember a time for a live HLS stream', () => {
    const client = makeClient({storeProgress: true});
    client.progressMemory = makeProgressMemory(null);
    client.progressHashesCache = ['h1', 'h2'];
    client.progressData = {lastTime: 0};
    client.lastProgressSave = 0;
    client.player = new FakePlayer(makeSource('http://127.0.0.1/live.m3u8'));
    client.player.duration = 120;
    client.player.isLive = true;

    client.updateTime(100);

    expect(client.progressMemory.setFile).not.toHaveBeenCalled();
  });

  it('still seeks a video to the time it was left at', async () => {
    const client = makeClient({storeProgress: true});
    client.progressMemory = makeProgressMemory({lastTime: 30});
    const player = await setSource(client, makeSource('http://127.0.0.1/vod.mp4'));
    expect(player.seeks).toContain(30);
  });

  it('does not remember a time for a live stream', () => {
    const client = makeClient({storeProgress: true});
    client.progressMemory = makeProgressMemory(null);
    client.progressHashesCache = ['h1', 'h2'];
    client.progressData = {lastTime: 0};
    client.lastProgressSave = 0;
    client.player = new FakePlayer(makeSource('http://127.0.0.1/live.mpd'));
    client.player.duration = Infinity;

    client.updateTime(1234);

    expect(client.progressMemory.setFile).not.toHaveBeenCalled();
    expect(client.progressData.lastTime).toBe(0);
  });

  it('does not take a live stream for one too big to download, with a warning', () => {
    // bitrate x Infinity was more than any storage: a storage warning on every live stream,
    // and everything downloaded so far pinned for the session.
    const client = makeClient();
    const player = new FakePlayer(makeSource('http://127.0.0.1/live.mpd'));
    player.duration = Infinity;
    player.videoLevel = 'video-1';
    player.getVideoLevels = () => new Map([['video-1', {bitrate: 5e6}]]);
    client.player = player;
    client.hasDownloadSpace = true;
    client.storageAvailable = 1e12;

    client.updateHasDownloadSpace();

    expect(client.hasDownloadSpace).toBe(false);
    expect(client.interfaceController.setStatusMessage).not.toHaveBeenCalled();
  });

  // #378: with predownload off the maximum size is not used, but a size smaller than the
  // video (10 MB) still warned "Video size exceeds limits" at the start of every video.
  it('warns about the maximum size only with predownload on', () => {
    for (const downloadAll of [false, true]) {
      const client = makeClient({downloadAll, maxVideoSize: 1e7});
      const player = new FakePlayer(makeSource('http://127.0.0.1/episode.mp4'));
      player.duration = 1400;
      player.videoLevel = 'video-1';
      player.getVideoLevels = () => new Map([['video-1', {bitrate: 5e5}]]);
      client.player = player;
      client.hasDownloadSpace = true;
      client.storageAvailable = 1e12;

      client.updateHasDownloadSpace();

      expect(client.hasDownloadSpace).toBe(false);
      expect(client.interfaceController.setStatusMessage).toHaveBeenCalledTimes(downloadAll ? 1 : 0);
    }
  });

  it('applies the remembered time when an options change looked it up first', async () => {
    // setOptions() looks the time up too. While that lookup ran, the source's own returned at
    // once with nothing, its time was never applied, and the next save wrote ~0 over it.
    const client = makeClient({storeProgress: true});
    let release;
    client.progressMemory = makeProgressMemory({lastTime: 1234}, new Promise((resolve) => release = resolve));
    client.player = new FakePlayer(makeSource('http://127.0.0.1/vod.mp4'));

    const fromOptions = client.loadProgressData();
    let seen = 'not yet';
    const fromSource = client.loadProgressData().then(() => {
      seen = client.progressData;
    });
    release();
    await fromOptions;
    await fromSource;

    expect(seen).toEqual({lastTime: 1234});
    expect(client.progressMemory.getHashes).toHaveBeenCalledTimes(1);
  });

  it('looks the time up again for the next source, not joining the last one\'s lookup', async () => {
    const client = makeClient({storeProgress: true});
    let release;
    client.progressMemory = makeProgressMemory({lastTime: 77}, new Promise((resolve) => release = resolve));
    client.player = new FakePlayer(makeSource('http://127.0.0.1/first.mp4'));
    const first = client.loadProgressData();

    await client.resetPlayer();
    client.player = new FakePlayer(makeSource('http://127.0.0.1/second.mp4'));
    const second = client.loadProgressData();
    release();
    await first;
    await second;

    expect(client.progressMemory.getHashes).toHaveBeenCalledTimes(2);
    expect(client.progressData).toEqual({lastTime: 77});
  });
});

describe('FastStreamClient, a time in the player page\'s address', () => {
  it('starts the first video there, and not the next video set in the same player', async () => {
    // Read again for every source: a video picked from the sources browser started at the
    // first one's time too, and skipped its own remembered time.
    window.location.href = 'moz-extension://faststream/player/index.html?faststream-timestamp=42';
    const client = makeClient();
    const first = await setSource(client, makeSource('http://127.0.0.1/first.mp4'));
    expect(first.seeks).toContain(42);

    const second = await setSource(client, makeSource('http://127.0.0.1/second.mp4'));
    expect(second.seeks).not.toContain(42);
  });

  it('starts a fallback there when the first stream showed nothing', async () => {
    window.location.href = 'moz-extension://faststream/player/index.html?faststream-timestamp=42';
    const client = makeClient();
    await setSource(client, makeSource('http://127.0.0.1/dead.m3u8'), (made) => {
      made.duration = 0;
      made.video.readyState = 0;
    });
    const fallback = await setSource(client, makeSource('http://127.0.0.1/fallback.mp4'));
    expect(fallback.seeks).toContain(42);
  });
});

describe('FastStreamClient, autoplay of the next video', () => {
  /**
   * A client at the end of a video, with a next one to go to.
   * @return {{client: FastStreamClient, player: FakePlayer}}
   */
  function atTheEnd() {
    const client = makeClient({autoplayNext: true});
    const player = new FakePlayer(makeSource('http://127.0.0.1/ep1.mp4'));
    player.duration = 1200;
    player._currentTime = 1199.6;
    client.player = player;
    client.state.hasNextVideo = true;
    client.bindPlayer(player);
    return {client, player};
  }

  /**
   * @return {number} How many times the player asked to go to the next video.
   */
  function navigations() {
    return chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.type === MessageTypes.REQUEST_PLAYLIST_NAVIGATION).length;
  }

  it('asks for the next video once when the end is both waited at and reached', async () => {
    // The last second's `waiting` asked, and `ended` asked again: a page whose next button
    // counts clicks skipped an episode.
    const {player} = atTheEnd();
    player.emit(DefaultPlayerEvents.WAITING);
    player.emit(DefaultPlayerEvents.ENDED);
    await settle();
    expect(navigations()).toBe(1);
  });

  it('asks again when the video is played to the end again', async () => {
    const {client, player} = atTheEnd();
    player.emit(DefaultPlayerEvents.ENDED);
    await settle();
    await client.play();
    player.emit(DefaultPlayerEvents.ENDED);
    await settle();
    expect(navigations()).toBe(2);
  });

  it('goes on at the end once the page has said there is a next video', async () => {
    const {client, player} = atTheEnd();
    client.state.hasNextVideo = false;
    player.emit(DefaultPlayerEvents.WAITING);
    client.state.hasNextVideo = true;
    player.emit(DefaultPlayerEvents.ENDED);
    await settle();
    expect(navigations()).toBe(1);
  });

  it('still goes to the next video each time it is asked by hand', () => {
    const {client} = atTheEnd();
    client.nextVideo();
    client.nextVideo();
    expect(navigations()).toBe(2);
  });
});

describe('FastStreamClient, the page\'s own media', () => {
  // While the player plays, the background has the page around it hold its own media
  // (PLAYER_PLAYING). A stream that fails while playing (a fatal network error) plays out
  // what it has and waits, without a pause: the page's player stayed held under the error
  // message, paused again each time the user started it.
  it('may play again once the player has failed', () => {
    const client = makeClient();
    const player = new FakePlayer(makeSource('http://127.0.0.1/a.m3u8'));
    client.player = player;
    client.bindPlayer(player);
    const reports = () => chrome.runtime.sendMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === MessageTypes.PLAYER_PLAYING);

    player.emit(DefaultPlayerEvents.PLAY);
    expect(reports().at(-1)).toEqual({type: MessageTypes.PLAYER_PLAYING, playing: true});

    player.emit(DefaultPlayerEvents.ERROR, 'fatal network error');
    expect(client.interfaceController.failedToLoad).toHaveBeenCalled();
    expect(reports().at(-1)).toEqual({type: MessageTypes.PLAYER_PLAYING, playing: false});
  });
});

describe('FastStreamClient, the decoding-aware quality option', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // LevelManager reads client.options.decodingAwareQuality at each pick; an options change
  // that did not copy it would leave the option page's switch without effect.
  it('takes the option over from an options change, on unless turned off', () => {
    vi.stubGlobal('document', {body: {dataset: {}}, getElementById: () => null});
    vi.stubGlobal('localStorage', {setItem: () => {}, getItem: () => null});
    vi.stubGlobal('sessionStorage', {setItem: () => {}, getItem: () => null});
    const client = makeClient();
    client.videoAnalyzer.disable = vi.fn();
    client.interfaceController.updateAutoNextIndicator = vi.fn();
    client.loadProgressData = vi.fn(async () => {});

    client.setOptions({decodingAwareQuality: false});
    expect(client.options.decodingAwareQuality).toBe(false);
    client.setOptions({decodingAwareQuality: true});
    expect(client.options.decodingAwareQuality).toBe(true);
    // Options saved before it existed.
    client.setOptions({});
    expect(client.options.decodingAwareQuality).toBe(true);
  });
});

describe('FastStreamClient, a video codec that failed to decode for good', () => {
  // DashPlayer.takeCodecReload answers once that a codec just failed for good. dash.js's own
  // recovery picked another codec in place, but the element then never loaded its metadata
  // (#348: HEVC failed on the Windows runner, then H.264 stayed at readyState 0).
  const HEVC = 'hev1.1.6.L90.b0';
  const failTwice = (client) => {
    client.getLevelManager().noteVideoDecodeFailure(HEVC);
    client.getLevelManager().noteVideoDecodeFailure(HEVC);
  };

  it('loads the same source again, keeping the failure, instead of giving up', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient();
    const source = makeSource('https://cdn.example/live.mpd');
    const first = await setSource(client, source, (player) => {
      player.takeCodecReload = () => true;
    });
    failTwice(client);
    let second = null;
    client.playerLoader.createPlayer = vi.fn(async () => (second = new FakePlayer(source)));

    first.emit(DefaultPlayerEvents.ERROR, {}, 'decode');
    await settle();

    expect(second).not.toBe(null);
    expect(client.player).toBe(second);
    expect(client.source.url).toBe(source.url);
    expect(client.getLevelManager().isVideoCodecFailed(HEVC)).toBe(true);
    expect(client.interfaceController.failedToLoad).not.toHaveBeenCalled();
  });

  it('gives up as before when no codec failed for good', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient();
    const first = await setSource(client, makeSource('https://cdn.example/live.mpd'), (player) => {
      player.takeCodecReload = () => false;
    });
    client.playerLoader.createPlayer = vi.fn();

    first.emit(DefaultPlayerEvents.ERROR, {}, 'decode');
    await settle();

    expect(client.playerLoader.createPlayer).not.toHaveBeenCalled();
    expect(client.interfaceController.failedToLoad).toHaveBeenCalledTimes(1);
  });

  it('does not reload for a player already replaced', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient();
    const first = await setSource(client, makeSource('https://cdn.example/a.mpd'), (player) => {
      player.takeCodecReload = () => true;
    });
    client.player = new FakePlayer(makeSource('https://cdn.example/b.mpd'));
    expect(client.reloadWithoutFailedCodec(first)).toBe(false);
  });

  it('carries the failure to that source only', () => {
    const client = makeClient();
    failTwice(client);
    client.carriedDecodeFailures = {url: 'https://cdn.example/live.mpd', failures: client.getLevelManager().getVideoDecodeFailures()};
    client.getLevelManager().reset();
    client.restoreCarriedDecodeFailures({url: 'https://cdn.example/other.mpd'});
    expect(client.getLevelManager().isVideoCodecFailed(HEVC)).toBe(false);
    expect(client.carriedDecodeFailures).toBe(null);
  });
});
