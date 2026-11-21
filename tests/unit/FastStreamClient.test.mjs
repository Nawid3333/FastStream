import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// FastStreamClient's own logic on a client whose parts are stand-ins, made without its constructor.

vi.mock('../../chrome/player/ui/InterfaceController.mjs', () => ({InterfaceController: class {}}));
vi.mock('../../chrome/player/ui/KeybindManager.mjs', () => ({KeybindManager: class {}}));
vi.mock('../../chrome/player/ui/FrameStepper.mjs', () => ({FrameStepper: class {}}));
vi.mock('../../chrome/player/network/DownloadManager.mjs', () => ({DownloadManager: class {}}));
vi.mock('../../chrome/player/modules/analyzer/VideoAnalyzer.mjs', () => ({VideoAnalyzer: class {}}));
vi.mock('../../chrome/player/ui/SourcesBrowser.mjs', () => ({SourcesBrowser: class {}}));
vi.mock('../../chrome/player/players/PlayerLoader.mjs', () => ({PlayerLoader: class {}}));
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {playerContainer: {style: {}}}}));
vi.mock('../../chrome/player/ui/audio/AudioOutput.mjs', () => ({AudioOutput: class {}}));
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
vi.mock('../../chrome/player/utils/VideoTransformUtils.mjs', () => ({VideoTransformUtils: {
  getTransformString: () => '', getAspectRatioStyles: () => ({objectFit: '', aspectRatio: ''}),
}}));
vi.mock('../../chrome/player/utils/Utils.mjs', () => ({Utils: {mergeOptions: (a) => a}}));
vi.mock('../../chrome/player/modules/analyzer/AudioAnalyzer.mjs', () => ({AudioAnalyzer: class {}}));
vi.mock('../../chrome/player/modules/analyzer/PreviewFrameExtractor.mjs', () => ({PreviewFrameExtractor: class {}}));
vi.mock('../../chrome/player/ui/StatusManager.mjs', () => ({StatusTypes: {INFO: 'info', REQINTERACTION: 'reqinteraction', QUALITY: 'quality'}}));
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
const {DISK_ONLY_ROOM_BYTES} = await import('../../chrome/player/network/MemoryBudget.mjs');
const {MessageTypes} = await import('../../chrome/player/enums/MessageTypes.mjs');
const {Fragment} = await import('../../chrome/player/players/Fragment.mjs');
const {LevelManager} = await import('../../chrome/player/players/LevelManager.mjs');
const {DroppedFrameWatch} = await import('../../chrome/player/players/DroppedFrameWatch.mjs');
const {Localize} = await import('../../chrome/player/modules/Localize.mjs');

/** A player as the player loader makes one, with what the client reads and sets on it. */
class FakePlayer extends EventEmitter {
  constructor(source) {
    super();
    this.source = source;
    this.video = {readyState: 1, style: {setProperty() {}}, classList: {toggle() {}}, videoWidth: 640, videoHeight: 360};
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
  return {
    url, identifier: url, mode: 'hls', headers: {}, ...extra, destroy() {},
    // as VideoSource.copy(): a copy whose URL was changed is copied with that URL
    copy() {
      return {...this};
    },
  };
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
      bufferAhead: 300, bufferBehind: 20, maxVideoSize: -1,
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
    droppedFrameWatch: new DroppedFrameWatch(),
    droppedSampledAt: 0,
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
    downloadManager: {reset: vi.fn(async () => {}), removeFile: vi.fn(), removeAllDownloaders: vi.fn(), setBufferToDisk: vi.fn()},
    audioAnalyzer: {reset: vi.fn(), setLevel: vi.fn(), updateBackgroundAnalyzer: vi.fn()},
    frameExtractor: {reset: vi.fn(), setLevel: vi.fn(), updateBackground: vi.fn()},
    videoAnalyzer: {setLevel: vi.fn(), setSource: vi.fn(async () => {}), pushFrame: () => false},
    audioOutput: {updateChannelCount: vi.fn()},
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

/**
 * Sets a source with a start of its own (setSource's third argument), a FakePlayer for it.
 * @param {FastStreamClient} client
 * @param {Object} source
 * @param {Object} start
 * @return {Promise<FakePlayer>}
 */
async function setSourceStarting(client, source, start) {
  let made = null;
  client.playerLoader.createPlayer = vi.fn(async () => (made = new FakePlayer(source)));
  client.sourceRequests++;
  await client.setSourceInternal(source, {request: client.sourceRequests, sources: []}, start);
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
    // each source that failed first must not leave its wait's interval running
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
    // the retry after the remembered time is applied runs, and a blocked play() is handled
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

describe('FastStreamClient, a video built again after autoplay', () => {
  // Another quality of the page's, or a recovery, builds the same video again with play: whether it played.
  // Autoplay (an automatic continuation's) started it, the user paused: the new build stays paused.

  /**
   * The same video at 30 s built again, with start, after autoplay started the first build or was blocked.
   * @param {Object} start - setSource's third argument.
   * @param {boolean} blocked - Whether the browser blocked the first autoplay.
   * @return {Promise<number>} How often the new build was played.
   */
  async function rebuild(start, blocked) {
    const client = makeClient({autoPlay: true});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    client.play = vi.fn(async () => {
      if (blocked) throw new Error('NotAllowedError: autoplay blocked');
    });
    await setSource(client, makeSource('http://127.0.0.1/film.mp4'), (made) => {
      made.duration = 7200;
    });
    expect(client.state.autoPlayTriggered).toBe(!blocked);
    client.play = vi.fn(async () => {});
    const player = await setSourceStarting(client, makeSource('http://127.0.0.1/film-720.mp4?faststream-timestamp=30'),
        {...start, keepChoice: true});
    player.emit(DefaultPlayerEvents.CANPLAY);
    await settle();
    expect(player.seeks).toContain(30);
    return client.play.mock.calls.length;
  }

  it('stays paused when the user paused it', async () => {
    expect(await rebuild({play: false}, false)).toBe(0);
  });

  it('plays when it was playing', async () => {
    expect(await rebuild({play: true}, false)).toBe(1);
  });

  it('still autoplays when the browser had blocked autoplay', async () => {
    expect(await rebuild({play: false}, true)).toBeGreaterThan(0);
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
    // A save holds its fragments (SAVER) until written: freed, they would be downloaded again.
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
    // A live stream's duration is Infinity: its remembered time is not sought.
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

  it('does not seek to it over a seek the user made while the player got ready', async () => {
    // An MP4's duration, and with it the seek bar, comes before its first frame; the time was looked up by then.
    const client = makeClient({storeProgress: true});
    client.progressMemory = makeProgressMemory({lastTime: 1200});
    const player = await setSource(client, makeSource('http://127.0.0.1/vod.mp4'), (made) => {
      made.duration = 7200;
      made.video.readyState = 0;
    });
    client.currentTime = 300;
    player.video.readyState = 1;
    player.emit(DefaultPlayerEvents.LOADEDMETADATA);
    await settle();
    expect(player.seeks).toContain(300);
    expect(player.seeks).not.toContain(1200);
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
    // bitrate x Infinity: no storage warning on a live stream, and nothing pinned.
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

  // With predownload off the maximum size is not used, but a size smaller than the
  // video (10 MB) still warned "Video size exceeds limits" at the start of every video.
  it('warns about the maximum size only with predownload on, also once it is turned on', () => {
    const client = makeClient({downloadAll: false, maxVideoSize: 1e7});
    const player = new FakePlayer(makeSource('http://127.0.0.1/episode.mp4'));
    player.duration = 1400;
    player.videoLevel = 'video-1';
    player.getVideoLevels = () => new Map([['video-1', {bitrate: 5e5}]]);
    client.player = player;
    client.hasDownloadSpace = true;
    client.storageAvailable = 1e12;

    client.updateHasDownloadSpace();
    expect(client.interfaceController.setStatusMessage).not.toHaveBeenCalled();
    expect(client.shouldDownloadAll()).toBeFalsy();

    // turned on mid-video: too big for the 10 MB, warned once, buffer window only
    client.options.downloadAll = true;
    client.updateHasDownloadSpace();
    client.updateHasDownloadSpace();
    expect(client.interfaceController.setStatusMessage).toHaveBeenCalledTimes(1);
    expect(client.hasDownloadSpace).toBe(false);
    expect(client.shouldDownloadAll()).toBeFalsy();
  });

  it('applies the remembered time when an options change looked it up first', async () => {
    // setOptions() looks the time up too: the source's own lookup still applies its time.
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

describe('FastStreamClient, a source that comes with its own time', () => {
  // Autoplay and a rebuilt player's resume start at the remembered time, not from 0 with a jump
  // back.

  /**
   * Records what the client plays, and at which time of its player.
   * @param {FastStreamClient} client
   * @return {Array<number>} The times it played at.
   */
  function recordPlays(client) {
    const plays = [];
    client.play = vi.fn(async () => {
      plays.push(client.player.currentTime);
    });
    return plays;
  }

  it('autoplays only once its time is applied, without waiting for the remembered time', async () => {
    const client = makeClient({autoPlay: true, storeProgress: true});
    // A lookup that is still running: the source's own time does not wait for it.
    client.progressMemory = makeProgressMemory({lastTime: 7}, new Promise(() => {}));
    const plays = recordPlays(client);
    const player = await setSource(client, makeSource('http://127.0.0.1/film.mp4?faststream-timestamp=3725'), (made) => {
      made.duration = 7200;
      made.video.readyState = 0;
    });

    expect(plays).toEqual([]);
    expect(player.seeks).not.toContain(3725);

    // The element has its metadata, and no frame yet.
    player.video.readyState = 1;
    player.emit(DefaultPlayerEvents.LOADEDMETADATA);
    await settle();

    expect(player.seeks).toContain(3725);
    expect(plays).toEqual([3725]);
    expect(client.startPending).toBe(null);
  });

  it('does not autoplay at canplay before its time is applied', async () => {
    const client = makeClient({autoPlay: true});
    const plays = recordPlays(client);
    const player = await setSource(client, makeSource('http://127.0.0.1/film.mp4?faststream-timestamp=3725'), (made) => {
      made.video.readyState = 0;
    });

    player.emit(DefaultPlayerEvents.CANPLAY);
    await settle();

    expect(plays).toEqual([]);
  });

  it('does not autoplay at a canplay while its player is still being set up', async () => {
    // the time is armed before the player's setup: a canplay meanwhile does not play from 0
    const client = makeClient({autoPlay: true});
    const plays = recordPlays(client);
    await setSource(client, makeSource('http://127.0.0.1/film.mp4?faststream-timestamp=3725'), (made) => {
      made.video.readyState = 0;
      made.setSource = async () => {
        made.emit(DefaultPlayerEvents.CANPLAY);
      };
    });

    expect(plays).toEqual([]);
  });

  it('resumes a player built again after an error at its time, not from 0 first', async () => {
    const client = makeClient();
    client.downloadManager.keepStorageOnce = vi.fn();
    client.recoveries = {url: null, times: []};
    const first = await setSource(client, makeSource('http://127.0.0.1/film.mp4'), (made) => {
      made.duration = 7200;
    });
    client.playedSource = client.source;
    first._currentTime = 3725.4;
    first.paused = false;

    let made = null;
    client.playerLoader.createPlayer = vi.fn(async () => {
      made = new FakePlayer(makeSource('http://127.0.0.1/film.mp4'));
      made.duration = 7200;
      made.video.readyState = 0;
      return made;
    });
    const plays = recordPlays(client);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(client.recoverPlayer(first, 'Playback stuck at 3725.4')).toBe(true);
    await client.sourceChange;
    await settle();
    expect(made).not.toBe(null);
    expect(plays).toEqual([]);

    made.video.readyState = 1;
    made.emit(DefaultPlayerEvents.LOADEDMETADATA);
    await settle();

    expect(made.seeks).toContain(3725);
    expect(plays).toEqual([3725]);
  });

  it('stays paused when it was paused', async () => {
    const client = makeClient();
    client.downloadManager.keepStorageOnce = vi.fn();
    client.recoveries = {url: null, times: []};
    const first = await setSource(client, makeSource('http://127.0.0.1/film.mp4'), (made) => {
      made.duration = 7200;
    });
    client.playedSource = client.source;
    first._currentTime = 600;

    let made = null;
    client.playerLoader.createPlayer = vi.fn(async () => {
      made = new FakePlayer(makeSource('http://127.0.0.1/film.mp4'));
      made.duration = 7200;
      return made;
    });
    const plays = recordPlays(client);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(client.recoverPlayer(first, 'Playback stuck at 600')).toBe(true);
    await client.sourceChange;
    await settle();

    expect(made.seeks).toContain(600);
    expect(plays).toEqual([]);
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

  it('still goes to the next video each time it is asked by hand', async () => {
    const {client} = atTheEnd();
    answerNavigations('clicked', 'clicked');
    client.nextVideo();
    await settle();
    client.nextVideo();
    expect(navigations()).toBe(2);
  });

  it('shows the wait in the last second when there is no next video to go to', () => {
    // Autoplay on and no next video: the buffering indicator shows in the last second.
    const {client, player} = atTheEnd();
    client.state.hasNextVideo = false;
    player.emit(DefaultPlayerEvents.WAITING);
    expect(client.interfaceController.setBuffering).toHaveBeenCalledWith(true);
    expect(navigations()).toBe(0);
  });

  // The end asks the background again while it stays at the end (an unloaded event page answers
  // 'error').
  it('asks again while it stays at the end when the background could not go on', async () => {
    vi.useFakeTimers();
    const {player} = atTheEnd();
    answerNavigations('error', 'clicked');
    player.emit(DefaultPlayerEvents.ENDED);
    await settle();
    expect(navigations()).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(navigations()).toBe(2);
    // 'clicked': the page goes on, and nothing more is asked.
    await vi.advanceTimersByTimeAsync(30000);
    expect(navigations()).toBe(2);
  });

  it('asks again when its request gets no answer', async () => {
    vi.useFakeTimers();
    const {player} = atTheEnd();
    answerNavigations(NO_ANSWER, undefined, 'clicked');
    player.emit(DefaultPlayerEvents.ENDED);
    await settle();
    await vi.advanceTimersByTimeAsync(5000 + 3000);
    expect(navigations()).toBe(2);
    // An answer of nothing (the message's port closed, chrome.runtime.lastError) too.
    await vi.advanceTimersByTimeAsync(3000);
    expect(navigations()).toBe(3);
  });

  it('gives up asking after a few tries, and the banner still goes on', async () => {
    vi.useFakeTimers();
    const {client, player} = atTheEnd();
    answerNavigations('no_button', 'no_button', 'no_button', 'no_button', 'no_button', 'no_button', 'no_button', 'clicked');
    player.emit(DefaultPlayerEvents.ENDED);
    await settle();
    await vi.advanceTimersByTimeAsync(60000);
    const asked = navigations();
    expect(asked).toBeGreaterThan(1);
    expect(asked).toBeLessThanOrEqual(6);
    client.nextVideo();
    expect(navigations()).toBe(asked + 1);
  });

  it('asks nothing more once the user went back from the end, or the series ends there', async () => {
    vi.useFakeTimers();
    let {client, player} = atTheEnd();
    answerNavigations('error');
    player.emit(DefaultPlayerEvents.ENDED);
    await settle();
    player._currentTime = 600;
    await vi.advanceTimersByTimeAsync(30000);
    expect(navigations()).toBe(1);

    chrome.runtime.sendMessage.mockClear();
    ({client, player} = atTheEnd());
    answerNavigations('series_end');
    player.emit(DefaultPlayerEvents.ENDED);
    await settle();
    await vi.advanceTimersByTimeAsync(30000);
    expect(navigations()).toBe(1);
    expect(client.hasNextVideo()).toBe(false);
  });

  it('goes on when its time stands still in the last seconds with no wait and no end told', async () => {
    // A video stuck in its last second with no `waiting` and no `ended` is still watched.
    vi.useFakeTimers();
    const {player} = atTheEnd();
    answerNavigations('clicked');
    player.emit(DefaultPlayerEvents.TIMEUPDATE);
    await vi.advanceTimersByTimeAsync(2000);
    expect(navigations()).toBe(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(navigations()).toBe(1);
  });

  it('does not go on while its time runs in the last seconds, nor when paused there', async () => {
    vi.useFakeTimers();
    const {player} = atTheEnd();
    player._currentTime = 1195;
    for (let i = 0; i < 8; i++) {
      player._currentTime += 0.25;
      player.emit(DefaultPlayerEvents.TIMEUPDATE);
      await vi.advanceTimersByTimeAsync(250);
    }
    player.video.paused = true;
    player.emit(DefaultPlayerEvents.TIMEUPDATE);
    await vi.advanceTimersByTimeAsync(10000);
    expect(navigations()).toBe(0);
  });

  it('sends one request when the banner is clicked while the end\'s request is on its way', async () => {
    // A second request while the page goes on: a next button that counts clicks skips an episode.
    const {client, player} = atTheEnd();
    answerNavigations(NO_ANSWER);
    player.emit(DefaultPlayerEvents.ENDED);
    await settle();
    client.nextVideo();
    expect(navigations()).toBe(1);
  });

  it('keeps the next video it knew when a poll is answered with an error', async () => {
    // 'error' (an event page started anew) is not "no next video": autoplay stays on.
    const {client} = atTheEnd();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === MessageTypes.REQUEST_PLAYLIST_POLL) callback('error');
    });
    await client.pollPrevNext();
    expect(client.hasNextVideo()).toBe(true);
  });
});

// The background's answers to the player's requests for the next video, one per request, in
// order; NO_ANSWER for one it never answers. Polls are answered with nothing.
const NO_ANSWER = Symbol('no answer');
function answerNavigations(...answers) {
  chrome.runtime.sendMessage.mockImplementation((message, callback) => {
    if (message.type !== MessageTypes.REQUEST_PLAYLIST_NAVIGATION) return;
    const answer = answers.length > 0 ? answers.shift() : NO_ANSWER;
    if (answer !== NO_ANSWER) queueMicrotask(() => callback?.(answer));
  });
}

describe('FastStreamClient, the page\'s own media', () => {
  // A stream that fails while playing lets the page's own player play again.
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
  // DashPlayer.takeCodecReload: a codec that failed for good rebuilds the player (dash.js's
  // in-place switch never loads).
  const HEVC = 'hev1.1.6.L90.b0';
  const failTwice = (client) => {
    client.getLevelManager().noteVideoDecodeFailure(HEVC);
    client.getLevelManager().noteVideoDecodeFailure(HEVC);
  };

  it('loads the same source again, keeping the failure, instead of giving up', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient();
    client.downloadManager.keepStorageOnce = vi.fn();
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

// A limit of 0 is none, an empty field (-1) no limit. With nothing on disk what is kept fits under
// MemoryBudget.LOW.
describe('FastStreamClient, the RAM budget with nothing on disk', () => {
  const MB = 1e6;
  const GB = 1e9;
  let EnvUtils;
  let Utils;

  beforeEach(async () => {
    ({EnvUtils} = await import('../../chrome/player/utils/EnvUtils.mjs'));
    ({Utils} = await import('../../chrome/player/utils/Utils.mjs'));
    Utils.measuredBitrate = () => null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete Utils.measuredBitrate;
  });

  /**
   * A finite video, 1400 s at 5 Mbit/s (875 MB), on a disk with room to spare.
   * @param {Object} options - The client's options.
   * @return {Object} The client.
   */
  function clientWithVideo(options) {
    const client = makeClient({downloadAll: true, ...options});
    const player = new FakePlayer(makeSource('http://127.0.0.1/movie.mp4'));
    player.duration = 1400;
    player.videoLevel = 'video-1';
    player.getVideoLevels = () => new Map([['video-1', {bitrate: 5e6}]]);
    client.player = player;
    client.hasDownloadSpace = true;
    client.storageAvailable = 1e12;
    return client;
  }

  /**
   * The seconds that fit in a share at 5 Mbit/s: all of them ahead, as behind is what the
   * budget lets go of first.
   * @param {number} share - Bytes.
   * @return {number}
   */
  const fits = (share) => Math.floor(share * 8 * 0.75 / 5e6 / 1.1);

  it('predownloads a video that fits in the budget, 2 GB or 8 GB, as with the disk', () => {
    for (const ramBudget of [2 * GB, 8 * GB]) {
      const client = clientWithVideo({bufferToDisk: false, ramBudget});
      client.updateHasDownloadSpace();
      expect(client.hasDownloadSpace, String(ramBudget)).toBe(true);
      expect(client.state.bufferAhead, String(ramBudget)).toBeGreaterThanOrEqual(300);
      expect(client.interfaceController.setStatusMessage).not.toHaveBeenCalled();
    }
  });

  it('keeps only what fits of a bigger one, warns once, and pins nothing', () => {
    const client = clientWithVideo({bufferToDisk: false, ramBudget: 500 * MB});
    const fragment = {status: DownloadStatus.DOWNLOAD_COMPLETE, dataSize: null, addReference: vi.fn()};
    client.fragmentsStore['video-1'] = [fragment];
    client.updateHasDownloadSpace();
    client.updateHasDownloadSpace();
    expect(client.hasDownloadSpace).toBe(false);
    // Less the 20 s kept behind, as with the disk: with predownload on, that is how it counts.
    expect(client.state.bufferAhead).toBe(fits(500 * MB) - 20);
    expect(client.interfaceController.setStatusMessage).toHaveBeenCalledTimes(1);
    expect(client.interfaceController.setStatusMessage.mock.calls[0][1]).toBe('player_buffer_storage_warning');
    // Pinned, the budget could not let go of it.
    expect(fragment.addReference).not.toHaveBeenCalled();

    // With the disk, the same video is predownloaded whole: what does not fit goes there.
    const withDisk = clientWithVideo({bufferToDisk: true, ramBudget: 500 * MB});
    withDisk.updateHasDownloadSpace();
    expect(withDisk.hasDownloadSpace).toBe(true);
  });

  it('keeps to the budget, and says so once, when no disk backend works', () => {
    // every disk backend failed: the buffer is planned for RAM, not the disk's free space
    const client = clientWithVideo({bufferToDisk: true, ramBudget: 500 * MB});
    client.downloadManager = {...client.downloadManager, blobStore: {diskGone: true}};
    client.updateHasDownloadSpace();
    client.updateHasDownloadSpace();
    expect(client.hasDownloadSpace).toBe(false);
    expect(client.state.bufferAhead).toBe(fits(500 * MB) - 20);
    const said = client.interfaceController.setStatusMessage.mock.calls.map((call) => call[1]);
    expect(said.filter((key) => key === 'player_outofstorage')).toHaveLength(1);
  });

  it('keeps nothing ahead with a budget of 0, and has no limit with an empty field', () => {
    const none = clientWithVideo({bufferToDisk: false, ramBudget: 0});
    none.updateHasDownloadSpace();
    expect(none.hasDownloadSpace).toBe(false);
    expect(none.state.bufferAhead).toBe(0);

    const unlimited = clientWithVideo({bufferToDisk: false, ramBudget: -1});
    unlimited.updateHasDownloadSpace();
    expect(unlimited.hasDownloadSpace).toBe(true);
    expect(unlimited.state.bufferAhead).toBeGreaterThanOrEqual(300);
  });

  it('fits "Buffer ahead" in a small budget without predownload too, whatever is kept behind', () => {
    // 300 s at 5 Mbit/s is 188 MB: in a 100 MB budget it went round and round.
    const client = clientWithVideo({bufferToDisk: false, ramBudget: 100 * MB, downloadAll: false});
    client.updateHasDownloadSpace();
    expect(client.state.bufferAhead).toBe(fits(100 * MB));
    // Behind is what the budget lets go of first: 1000 s of it left nothing ahead.
    for (const behind of [1000, Infinity]) {
      client.state.bufferBehind = behind;
      client.updateHasDownloadSpace();
      expect(client.state.bufferAhead, String(behind)).toBe(fits(100 * MB));
    }
  });

  it('fits in this player\'s share when another one holds RAM too', () => {
    // Two players with 2 GB: each counted on all of it, and together they went round again.
    const client = clientWithVideo({bufferToDisk: false, ramBudget: 2 * GB});
    client.state.playing = true;
    client.peers = {visible: () => true, livePeers: () => [{ramBytes: 1.5 * GB, visible: true, playing: true}]};
    client.updateHasDownloadSpace();
    // Its share: half of 2 GB (equal weights), 1 GB; 875 MB is more than 75 % of it.
    expect(client.hasDownloadSpace).toBe(false);
    expect(client.state.bufferAhead).toBe(fits(1 * GB) - 20);

    // Alone, the same video fits.
    const alone = clientWithVideo({bufferToDisk: false, ramBudget: 2 * GB});
    alone.updateHasDownloadSpace();
    expect(alone.hasDownloadSpace).toBe(true);
  });

  it('counts the RAM budget as room beside a small disk quota, as Firefox for Android gives one', () => {
    // An emulator's 6.2 GB of storage: its quota is a tenth, 623 MB; 60 % of it held no 875 MB video.
    const client = clientWithVideo({bufferToDisk: true, ramBudget: 2 * GB});
    client.storageAvailable = 623 * MB;
    client.updateHasDownloadSpace();
    expect(client.hasDownloadSpace).toBe(true);
    expect(client.interfaceController.setStatusMessage).not.toHaveBeenCalled();

    const unlimited = clientWithVideo({bufferToDisk: true, ramBudget: -1});
    unlimited.storageAvailable = 10 * MB;
    unlimited.updateHasDownloadSpace();
    expect(unlimited.hasDownloadSpace).toBe(true);

    // Neither holds it, nor both together: what fits in both, and the warning.
    const small = clientWithVideo({bufferToDisk: true, ramBudget: 500 * MB});
    small.storageAvailable = 300 * MB;
    small.updateHasDownloadSpace();
    expect(small.hasDownloadSpace).toBe(false);
    expect(small.state.bufferAhead).toBe(Math.floor((500 * MB * 0.75 + 300 * MB * 0.6) * 8 / 5e6 / 1.1) - 20);
    expect(small.interfaceController.setStatusMessage.mock.calls.map((call) => call[1])).toEqual(['player_buffer_storage_warning']);
  });

  it('does not let the disk\'s free space limit what is kept in RAM', () => {
    const client = clientWithVideo({bufferToDisk: false, ramBudget: 2 * GB});
    client.storageAvailable = 100 * MB;
    client.updateHasDownloadSpace();
    expect(client.hasDownloadSpace).toBe(true);
  });

  it('keeps nothing ahead at 0 when the bitrate is not known yet, and reads a broken setting as 2 GB', () => {
    const client = clientWithVideo({bufferToDisk: false, ramBudget: 0});
    client.player.getVideoLevels = () => new Map([['video-1', {}]]);
    client.updateHasDownloadSpace();
    expect(client.state.bufferAhead).toBe(0);

    const broken = clientWithVideo({bufferToDisk: false, ramBudget: NaN});
    broken.updateHasDownloadSpace();
    expect(broken.hasDownloadSpace).toBe(true);
    const small = clientWithVideo({bufferToDisk: false, ramBudget: NaN, downloadAll: false});
    small.player.getVideoLevels = () => new Map([['video-1', {bitrate: 1e8}]]);
    small.updateHasDownloadSpace();
    expect(small.state.bufferAhead).toBe(Math.floor(2 * GB * 8 * 0.75 / 1e8 / 1.1));
  });

  it('fits a private window\'s buffer in the budget too, whatever the switch says', () => {
    vi.spyOn(EnvUtils, 'isIncognito').mockReturnValue(true);
    const client = clientWithVideo({bufferToDisk: true, ramBudget: 100 * MB});
    client.updateHasDownloadSpace();
    expect(client.hasDownloadSpace).toBe(false);
    expect(client.state.bufferAhead).toBe(fits(100 * MB));
  });

  it('predownloads in a private window what fits in its share, as with the disk off, and says so when it does not', () => {
    vi.spyOn(EnvUtils, 'isIncognito').mockReturnValue(true);
    const fits875 = clientWithVideo({bufferToDisk: true, ramBudget: 2 * GB});
    fits875.updateHasDownloadSpace();
    expect(fits875.hasDownloadSpace).toBe(true);
    expect(fits875.interfaceController.setStatusMessage).not.toHaveBeenCalled();

    const client = clientWithVideo({bufferToDisk: true, ramBudget: 500 * MB});
    client.updateHasDownloadSpace();
    client.updateHasDownloadSpace();
    expect(client.hasDownloadSpace).toBe(false);
    expect(client.state.bufferAhead).toBe(fits(500 * MB) - 20);
    const said = client.interfaceController.setStatusMessage.mock.calls.map((call) => call[1]);
    expect(said).toEqual(['player_buffer_incognito_warning']);
  });

  it('fits the video and its separate audio track together', () => {
    // 14 000 s of 800 kbit/s video fit 1.5 GB alone; with 256 kbit/s audio beside it, 1.85 GB, they did not, and the
    // budget let go of what predownload fetched again, round and round.
    vi.spyOn(EnvUtils, 'isIncognito').mockReturnValue(true);
    const withAudio = (audio) => {
      const client = clientWithVideo({ramBudget: 2 * GB});
      client.player.duration = 14000;
      client.player.getVideoLevels = () => new Map([['video-1', {bitrate: 8e5}]]);
      if (audio) {
        client.player.audioLevel = 'audio-1';
        client.player.getAudioLevels = () => new Map([['audio-1', {bitrate: 2.56e5}]]);
        client.fragmentsStore['audio-1'] = [];
      }
      client.updateHasDownloadSpace();
      return client;
    };
    expect(withAudio(true).hasDownloadSpace).toBe(false);
    expect(withAudio(false).hasDownloadSpace).toBe(true);
  });

  it('gives a private window\'s buffer back when its share grows again, and takes a new "Buffer ahead"', () => {
    // the fit to a share rises again, not only lowers
    vi.spyOn(EnvUtils, 'isIncognito').mockReturnValue(true);
    const client = clientWithVideo({ramBudget: 2 * GB, bufferAhead: 1200, downloadAll: false});
    client.state.playing = true;
    client.peers = {visible: () => true, livePeers: () => [{ramBytes: 1.9 * GB, visible: true, playing: true}]};
    client.updateHasDownloadSpace();
    const shared = client.state.bufferAhead;
    expect(shared).toBe(fits(1 * GB));
    client.peers = {visible: () => true, livePeers: () => []};
    client.updateHasDownloadSpace();
    // Alone, all of "Buffer ahead" fits again.
    expect(fits(2 * GB)).toBeGreaterThan(1200);
    expect(client.state.bufferAhead).toBe(1200);
    client.options.bufferAhead = 600;
    client.updateHasDownloadSpace();
    expect(client.state.bufferAhead).toBe(600);
  });

  it('takes a new "Buffer ahead" during a live stream with nothing on disk', () => {
    const client = clientWithVideo({bufferToDisk: false, ramBudget: 2 * GB});
    client.player.duration = Infinity;
    client.updateHasDownloadSpace();
    expect(client.state.bufferAhead).toBe(300);
    client.options.bufferAhead = 60;
    client.updateHasDownloadSpace();
    expect(client.state.bufferAhead).toBe(60);
    client.options.bufferAhead = 120;
    client.updateHasDownloadSpace();
    expect(client.state.bufferAhead).toBe(120);
  });
});

describe('FastStreamClient, limits of 0 and no limit', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A finite video, 1400 s at 0.5 Mbit/s (88 MB), on a disk with room to spare. */
  function clientWithVideo(options) {
    const client = makeClient(options);
    const player = new FakePlayer(makeSource('http://127.0.0.1/episode.mp4'));
    player.duration = 1400;
    player.videoLevel = 'video-1';
    player.getVideoLevels = () => new Map([['video-1', {bitrate: 5e5}]]);
    client.player = player;
    client.hasDownloadSpace = true;
    client.storageAvailable = 1e12;
    return client;
  }

  it('predownloads nothing with a maximum size of 0, and all of it with no limit', () => {
    const none = clientWithVideo({downloadAll: true, maxVideoSize: 0});
    none.updateHasDownloadSpace();
    expect(none.hasDownloadSpace).toBe(false);
    expect(none.shouldDownloadAll()).toBeFalsy();

    const unlimited = clientWithVideo({downloadAll: true, maxVideoSize: -1});
    unlimited.updateHasDownloadSpace();
    expect(unlimited.hasDownloadSpace).toBe(true);
  });

  /**
   * Runs the predownloader once, with one fragment waiting to be downloaded.
   * @return {number} How many downloads it started.
   */
  function predownloadOnce({maxSpeed, speed}) {
    vi.stubGlobal('navigator', {onLine: true});
    const client = makeClient({maxSpeed});
    const fragment = {start: 1, end: 2, canFree: () => true, getContext: () => ({})};
    let waiting = [fragment];
    client.getNextToDownload = () => waiting.shift() || null;
    client.getVideoAhead = () => 120;
    client.needsUserInteraction = () => false;
    client.videoAnalyzer = {isRunning: () => false};
    client.interfaceController.saveManager = {makingDownload: false};
    client.downloadManager = {yielding: false, memoryFull: false, holdTest: vi.fn(), getSpeed: () => speed,
      canGetFile: () => true, activeCount: () => 0};
    client.player = {getVideo: () => null, downloadFragment: vi.fn(() => Promise.resolve())};
    client.predownloadFragments();
    waiting = [];
    return client.player.downloadFragment.mock.calls.length;
  }

  it('downloads nothing ahead at a speed limit of 0, also while nothing downloads', () => {
    // Held back only while something downloaded, a limit of 0 still read ahead in bursts.
    expect(predownloadOnce({maxSpeed: 0, speed: 0})).toBe(0);
    expect(predownloadOnce({maxSpeed: 0, speed: 5e5})).toBe(0);
  });

  it('short of video, runs as many downloads at once as the download manager allows', () => {
    // Two at most (PlayheadFirst's URGENT_PARALLEL), whatever the speed test had found: on a
    // server that limits each connection, a player short of video stayed on two.
    const started = (urgentParallel) => {
      vi.stubGlobal('navigator', {onLine: true});
      const client = makeClient({maxSpeed: -1});
      const waiting = Array.from({length: 8}, (_, i) => ({start: i * 4, end: i * 4 + 4, canFree: () => true, getContext: () => ({})}));
      client.getNextToDownload = () => waiting.shift() || null;
      client.getVideoAhead = () => 2;
      client.concentrating = true;
      client.needsUserInteraction = () => false;
      client.interfaceController.saveManager = {makingDownload: false};
      let running = 0;
      client.downloadManager = {yielding: false, memoryFull: false, holdTest: vi.fn(), getSpeed: () => 0,
        canGetFile: () => true, activeCount: () => running, urgentParallel: () => urgentParallel};
      client.player = {duration: 1400, getVideo: () => null, downloadFragment: vi.fn(() => {
        running++;
        return Promise.resolve();
      })};
      client.predownloadFragments();
      return running;
    };
    expect(started(2)).toBe(2);
    expect(started(5)).toBe(5);
  });

  describe('while the video waits', () => {
    // Each has played (its played ranges): the start is left as it was.
    const PLAYED = {length: 1};
    const SEEKING = {seeking: true, paused: false, readyState: 1, played: PLAYED};
    /**
     * Runs the predownloader once at 10.5 s, short of video, with the fragments of a video
     * track (2 s each, 10-16 s) and of an audio track (the same), the nearest first.
     * @param {{sharesLine: boolean, video?: {seeking: boolean, paused: boolean, readyState: number, played: {length: number}},
     *   asked?: boolean, live?: boolean, untimed?: boolean, from?: number, testing?: boolean,
     *   held?: boolean[]}} line - asked: playback has a request running; from: where the first
     *   waiting fragment starts; testing: the speed test still runs; held: gets what
     *   holdTest was told; running: fragments already downloading, as track:start, or
     *   track:start:saved for one a save holds;
     *   cancelled: gets those cancelIfCheap was asked for.
     * @return {string[]} The fragments it started, as track:start.
     */
    const startedAt = ({sharesLine, video = SEEKING, asked = false, live = false, untimed = false, from = 10,
      testing = false, held = [], running = [], cancelled = []}) => {
      vi.stubGlobal('navigator', {onLine: true});
      const client = makeClient({maxSpeed: -1});
      const make = (track, start) => ({track, start: untimed ? -1 : start, end: untimed ? -1 : start + 2,
        canFree: () => true, getContext: () => ({})});
      const waiting = [];
      for (let start = from; start < 16; start += 2) waiting.push(make('video', start), make('audio', start));
      const downloading = running.map((name) => {
        // saved: a save holds it (canFree false).
        const [track, start, saved] = name.split(':');
        return {...make(track, Number(start)), status: DownloadStatus.DOWNLOAD_INITIATED, getContext: () => ({name}),
          canFree: () => !saved};
      });
      Object.defineProperty(client, 'fragments', {value: downloading.filter((fragment) => fragment.track === 'video')});
      Object.defineProperty(client, 'audioFragments', {value: downloading.filter((fragment) => fragment.track === 'audio')});
      client.state.currentTime = 10.5;
      client.getNextToDownload = () => waiting.shift() || null;
      client.getVideoAhead = () => 0;
      client.concentrating = true;
      client.isLive = () => live;
      client.needsUserInteraction = () => false;
      client.interfaceController.saveManager = {makingDownload: false};
      const started = [];
      client.downloadManager = {yielding: false, memoryFull: false, getSpeed: () => 0,
        canGetFile: () => true, activeCount: () => started.length, urgentParallel: () => 6,
        sharesLine: () => sharesLine, playbackAsked: () => asked, testing,
        cancelIfCheap: (/** @type {{name: string}} */ details) => cancelled.push(details.name),
        holdTest: (/** @type {boolean} */ hold) => held.push(hold)};
      client.player = {duration: 1400, getVideo: () => video, downloadFragment: vi.fn((fragment) => {
        started.push(`${fragment.track}:${fragment.start}`);
        return Promise.resolve();
      })};
      client.predownloadFragments();
      return started;
    };

    it('on a line the downloads share, downloads only the fragments the playhead is in', () => {
      // a seek's segment does not share the line with the next one
      expect(startedAt({sharesLine: true})).toEqual(['video:10', 'audio:10']);
      // Not one behind it, where the next waiting is one that ended before the playhead.
      expect(startedAt({sharesLine: true, from: 8})).toEqual([]);
      // Playing with nothing ahead (a stall) is waiting too.
      expect(startedAt({sharesLine: true, video: {seeking: false, paused: false, readyState: 2, played: PLAYED}})).toEqual(['video:10', 'audio:10']);
    });

    it('on a line the downloads share, nothing beside what playback asked for', () => {
      // At a fragment's edge hls.js asked for the one before the playhead, and the store's own
      // downloads ahead shared the line with it.
      expect(startedAt({sharesLine: true, asked: true})).toEqual([]);
    });

    it('where the speed test found that each connection has its own speed, downloads ahead as before', () => {
      expect(startedAt({sharesLine: false})).toHaveLength(6);
      expect(startedAt({sharesLine: false, asked: true})).toHaveLength(6);
    });

    it('while the speed test runs, a seek as on a line the downloads share, and the test waits (holdTest)', () => {
      // A seek in the first seconds shared the line with every download of the test: an HLS seek
      // on a 6 Mbit/s line took 3.1 s where alone it takes 1.2 s.
      const held = [];
      expect(startedAt({sharesLine: false, testing: true, held})).toEqual(['video:10', 'audio:10']);
      expect(startedAt({sharesLine: false, testing: true, asked: true})).toEqual([]);
      expect(held).toEqual([true]);
      // The video plays on: the test goes on, and so do the downloads ahead.
      const playing = [];
      expect(startedAt({sharesLine: false, testing: true, held: playing,
        video: {seeking: false, paused: false, readyState: 4, played: PLAYED}})).toHaveLength(6);
      expect(playing).toEqual([false]);
      // A stall while the speed test runs leaves the test as it was (on a slow line it would never
      // end).
      const stalled = [];
      expect(startedAt({sharesLine: false, testing: true, held: stalled,
        video: {seeking: false, paused: false, readyState: 2, played: PLAYED}})).toHaveLength(6);
      expect(stalled).toEqual([false]);
      // The start (nothing played yet) is left as it was, test and all.
      const start = [];
      expect(startedAt({sharesLine: false, testing: true, held: start,
        video: {seeking: false, paused: false, readyState: 1, played: {length: 0}}})).toHaveLength(6);
      expect(start).toEqual([false]);
    });

    it('at a seek, cancels the downloads ahead running beside the fragments the playhead is in', () => {
      // Started before the seek, inside the new place's window: on a 3 Mbit/s line the next
      // fragment kept half the line from the seek's own, an MP4 seek 3.6 -> 4.6 s.
      const running = ['video:10', 'video:12', 'audio:10', 'audio:14', 'video:6'];
      const cancelled = [];
      startedAt({sharesLine: true, asked: true, running, cancelled});
      expect(cancelled).toEqual(['video:12', 'video:6', 'audio:14']);
      // Not one a save holds, nor one without times (start -1, nothing to place it by).
      const kept = [];
      startedAt({sharesLine: true, asked: true, running: ['video:12:saved', 'video:-1'], cancelled: kept});
      expect(kept).toEqual([]);
      // While the speed test runs, the same.
      const testing = [];
      startedAt({sharesLine: false, testing: true, asked: true, running, cancelled: testing});
      expect(testing).toEqual(['video:12', 'video:6', 'audio:14']);
      // A stall, or where each connection has its own speed, or playing on: they run on.
      for (const line of [{sharesLine: true, video: {seeking: false, paused: false, readyState: 2, played: PLAYED}},
        {sharesLine: false}, {sharesLine: true, video: {seeking: false, paused: false, readyState: 4, played: PLAYED}}]) {
        const left = [];
        startedAt({...line, asked: true, running, cancelled: left});
        expect(left).toEqual([]);
      }
    });

    it('not waiting - playing on, or paused - downloads ahead as before', () => {
      expect(startedAt({sharesLine: true, asked: true, video: {seeking: false, paused: false, readyState: 4, played: PLAYED}})).toHaveLength(6);
      expect(startedAt({sharesLine: true, asked: true, video: {seeking: false, paused: true, readyState: 1, played: PLAYED}})).toHaveLength(6);
    });

    it('before the video has played (the start), downloads ahead as before', () => {
      // not held back while playback has a request running
      expect(startedAt({sharesLine: true, asked: true, video: {seeking: false, paused: false, readyState: 1, played: {length: 0}}})).toHaveLength(6);
    });

    it('on a live stream (its own clock), and for fragments without times, as before', () => {
      expect(startedAt({sharesLine: true, live: true})).toHaveLength(6);
      expect(startedAt({sharesLine: true, untimed: true})).toHaveLength(6);
    });
  });

  it('downloads ahead with no speed limit, and under a limit it has not reached', () => {
    expect(predownloadOnce({maxSpeed: -1, speed: 1e9})).toBe(1);
    expect(predownloadOnce({maxSpeed: 125000, speed: 1000})).toBe(1);
    expect(predownloadOnce({maxSpeed: 125000, speed: 200000})).toBe(0);
  });

  it('wants the network for a fragment without times that it would download', () => {
    // A fragmented MP4's unparsed ranges (times -1) are placed by windowSpan, not taken as behind
    // the playhead.
    vi.stubGlobal('navigator', {onLine: true});
    const client = makeClient({maxSpeed: -1});
    const fragment = (sn, start, end) => ({level: 'video-1', sn, start, end, canFree: () => true});
    const fragments = [fragment(0, 0, 10), fragment(1, 10, 20), fragment(2, 20, 600), fragment(3, -1, -1)];
    client.player = {};
    client.getFragments = () => fragments;
    client.getNextToDownload = () => fragments[3];
    client.needsUserInteraction = () => false;
    client.isLive = () => false;
    client.downloadManager = {downloaders: [], paused: false, memoryFull: false, activeCount: () => 0};
    client.state.currentTime = 35;
    expect(client.wantsNetwork()).toBe(true);
    // Placed far ahead of what it keeps ahead: not wanted, as predownloadFragments would not start it.
    client.state.bufferAhead = 2;
    client.state.currentTime = 1;
    expect(client.wantsNetwork()).toBe(false);
  });

  /** Whether the RAM budget counts this player full, holding this many bytes in RAM. */
  function ramFull(ramBudget, held, toDisk = true) {
    const client = makeClient({ramBudget});
    client.state.playing = true;
    client.peers = {visible: () => true, livePeers: () => []};
    client.downloadManager = {blobStore: {}, memoryFull: false, ramBytes: () => held,
      spillingBytes: () => 0, canSpill: () => toDisk, ramBytesOf: () => 0};
    client.keepWithinMemoryBudget();
    return client.downloadManager.memoryFull;
  }

  it('downloads ahead to disk with a RAM budget of 0, and has no bound with no limit', () => {
    // 0 is straight to disk, not nothing ahead
    expect(ramFull(0, 0)).toBe(false);
    expect(ramFull(0, 10e6)).toBe(false);
    expect(ramFull(0, DISK_ONLY_ROOM_BYTES)).toBe(true);
    // A private window keeps nothing on disk: nothing ahead there.
    expect(ramFull(0, 0, false)).toBe(true);
    expect(ramFull(0, 1e6, false)).toBe(true);
    // 0 and the empty field are not the 2 GB default
    expect(ramFull(-1, 50e9)).toBe(false);
    // A budget the options never set is the default, 2 GB.
    expect(ramFull(undefined, 1e9)).toBe(false);
    expect(ramFull(undefined, 3e9)).toBe(true);
    expect(ramFull(1e9, 3e9)).toBe(true);
  });
});

// A fragment whose disk write outlasts a tick is not chosen again and let go of (FSBlob.spill
// answers false).
describe('FastStreamClient, the RAM budget while writes to disk are slow', () => {
  const BYTES = 300e3;

  /**
   * A player at the start of a two-minute stream of 2 s fragments, the first 40 downloaded
   * and held in RAM, on a disk whose writes do not finish until told to.
   * @param {number} ramBudget
   * @return {Object} The client, its fake download manager, the fragments, arrive(from, to)
   *     to have more downloaded, and finishWrites().
   */
  function clientWithSlowDisk(ramBudget) {
    const client = makeClient({ramBudget});
    client.peers = {visible: () => true, livePeers: () => []};
    const fragments = [];
    for (let sn = 0; sn < 60; sn++) {
      const fragment = new Fragment('0:0', sn);
      fragment.start = sn * 2;
      fragment.end = sn * 2 + 2;
      fragment.getContext = () => ({url: `http://127.0.0.1/${sn}.ts`});
      fragments.push(fragment);
    }
    client.fragmentsStore['0:0'] = fragments;
    const inRam = new Set();
    // url -> what finishes its write.
    const writing = new Map();
    const manager = {
      blobStore: {}, memoryFull: false,
      ramBytes: () => inRam.size * BYTES,
      spillingBytes: () => writing.size * BYTES,
      canSpill: () => true,
      ramBytesOf: ({url}) => inRam.has(url) ? BYTES : 0,
      isSpilling: ({url}) => writing.has(url),
      // As FSBlob.spill: false for one already on its way, and its write goes on.
      spill: vi.fn(({url}) => {
        if (!inRam.has(url) || writing.has(url)) return Promise.resolve(false);
        return new Promise((resolve) => writing.set(url, () => {
          writing.delete(url);
          inRam.delete(url);
          resolve(true);
        }));
      }),
      removeFile: vi.fn(({url}) => inRam.delete(url)),
    };
    client.downloadManager = manager;
    const arrive = (from, to) => {
      for (const fragment of fragments.slice(from, to)) {
        fragment.status = DownloadStatus.DOWNLOAD_COMPLETE;
        inRam.add(fragment.getContext().url);
      }
    };
    arrive(0, 40);
    const finishWrites = () => [...writing.values()].forEach((finish) => finish());
    return {client, manager, fragments, arrive, finishWrites};
  }

  it('lets go of nothing still being written, and writes each fragment once', async () => {
    for (const ramBudget of [0, 2e6]) {
      const {client, manager, fragments, arrive, finishWrites} = clientWithSlowDisk(ramBudget);
      client.keepWithinMemoryBudget();
      await settle();
      // All but the next 10 s.
      expect(manager.spill, String(ramBudget)).toHaveBeenCalledTimes(34);

      // The downloads that were running come in; the writes have not finished.
      arrive(40, 50);
      client.keepWithinMemoryBudget();
      await settle();
      client.keepWithinMemoryBudget();
      await settle();
      finishWrites();
      await settle();

      expect(manager.removeFile, String(ramBudget)).not.toHaveBeenCalled();
      expect(fragments.slice(0, 50).every((fragment) => fragment.status === DownloadStatus.DOWNLOAD_COMPLETE), String(ramBudget)).toBe(true);
      const urls = manager.spill.mock.calls.map(([{url}]) => url);
      expect(new Set(urls).size, String(ramBudget)).toBe(urls.length);
      // The 34 of the first tick (fragments 6-39: the first 10 s stay), and the 10 that came.
      expect(urls, String(ramBudget)).toHaveLength(44);
    }
  });

  it('downloads ahead again when the downloads running as it let go come in after', async () => {
    // 40 held of a budget of 40: full (over HIGH), it writes 10 to disk, down to LOW (30).
    const {client, manager, arrive, finishWrites} = clientWithSlowDisk(40 * BYTES);
    client.keepWithinMemoryBudget();
    expect(manager.memoryFull).toBe(true);
    expect(manager.spill).toHaveBeenCalledTimes(10);
    // Two that were downloading come in, then the writes finish: 32 held, over LOW, under HIGH.
    arrive(40, 42);
    client.keepWithinMemoryBudget();
    finishWrites();
    await settle();
    for (let tick = 0; tick < 3; tick++) {
      client.keepWithinMemoryBudget();
      finishWrites();
      await settle();
    }
    // Before: nothing more let go of, full for good, and no download ahead again.
    expect(manager.spill).toHaveBeenCalledTimes(12);
    client.keepWithinMemoryBudget();
    expect(manager.memoryFull).toBe(false);
  });

  it('writes what was kept for good when the room ran out to disk, and deletes none of it', async () => {
    // updateHasDownloadSpace pins every downloaded fragment (GRANDFATHERED). The budget left
    // them out, and those held in RAM never left it: full for good.
    const {client, manager, fragments, finishWrites} = clientWithSlowDisk(40 * BYTES);
    for (const fragment of fragments) fragment.addReference(ReferenceTypes.GRANDFATHERED);
    client.keepWithinMemoryBudget();
    expect(manager.spill).toHaveBeenCalledTimes(10);
    finishWrites();
    await settle();
    client.keepWithinMemoryBudget();
    expect(manager.memoryFull).toBe(false);
    expect(manager.removeFile).not.toHaveBeenCalled();
    expect(fragments.every((fragment) => !fragment.canFree())).toBe(true);
  });

  it('lets go of what was kept for good when the disk is full, or RAM stays full for good', async () => {
    // A RAM share that shrank, beside a small disk quota, ends the room mid-video (updateHasDownloadSpace): every
    // downloaded fragment is pinned, and the disk takes none of them.
    const {client, manager, fragments} = clientWithSlowDisk(40 * BYTES);
    for (const fragment of fragments) fragment.addReference(ReferenceTypes.GRANDFATHERED);
    manager.spill = vi.fn(() => Promise.resolve(false));
    client.keepWithinMemoryBudget();
    expect(manager.memoryFull).toBe(true);
    await settle();
    expect(manager.removeFile).toHaveBeenCalledTimes(10);
    client.keepWithinMemoryBudget();
    expect(manager.memoryFull).toBe(false);

    // A save's hold stays, disk full or not.
    const saved = clientWithSlowDisk(40 * BYTES);
    for (const fragment of saved.fragments) {
      fragment.addReference(ReferenceTypes.GRANDFATHERED);
      fragment.addReference(ReferenceTypes.SAVER);
    }
    saved.manager.spill = vi.fn(() => Promise.resolve(false));
    saved.client.keepWithinMemoryBudget();
    await settle();
    expect(saved.manager.removeFile).not.toHaveBeenCalled();
  });

  it('control: keeps a fragment a save holds in RAM', () => {
    const {client, manager, fragments} = clientWithSlowDisk(40 * BYTES);
    for (const fragment of fragments) fragment.addReference(ReferenceTypes.SAVER);
    client.keepWithinMemoryBudget();
    expect(manager.spill).not.toHaveBeenCalled();
  });
});

describe('FastStreamClient, "Buffer behind" changed while a video plays', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies at once, not only from the next video', () => {
    vi.stubGlobal('document', {body: {dataset: {}}, getElementById: () => null});
    vi.stubGlobal('localStorage', {setItem: () => {}, getItem: () => null});
    vi.stubGlobal('sessionStorage', {setItem: () => {}, getItem: () => null});
    const client = makeClient();
    client.videoAnalyzer.disable = vi.fn();
    client.interfaceController.updateAutoNextIndicator = vi.fn();
    client.loadProgressData = vi.fn(async () => {});
    expect(client.state.bufferBehind).toBe(20);

    client.setOptions({bufferBehind: 120});
    expect(client.state.bufferBehind).toBe(120);
  });

  it('hands "Keep video on disk" to the download manager at once, on unless it is off', () => {
    // Only the buffer: watch progress and saving keep their storage.
    vi.stubGlobal('document', {body: {dataset: {}}, getElementById: () => null});
    vi.stubGlobal('localStorage', {setItem: () => {}, getItem: () => null});
    vi.stubGlobal('sessionStorage', {setItem: () => {}, getItem: () => null});
    const client = makeClient();
    client.videoAnalyzer.disable = vi.fn();
    client.interfaceController.updateAutoNextIndicator = vi.fn();
    client.loadProgressData = vi.fn(async () => {});

    client.setOptions({bufferToDisk: false});
    expect(client.options.bufferToDisk).toBe(false);
    expect(client.downloadManager.setBufferToDisk).toHaveBeenLastCalledWith(false);
    // Options saved before the switch existed have no value: on, as it was.
    client.setOptions({});
    expect(client.options.bufferToDisk).toBe(true);
    expect(client.downloadManager.setBufferToDisk).toHaveBeenLastCalledWith(true);
  });

  // An empty field is no limit (-1), 0 is none.
  it('takes an empty field as no limit, and 0 as none', () => {
    vi.stubGlobal('document', {body: {dataset: {}}, getElementById: () => null});
    vi.stubGlobal('localStorage', {setItem: () => {}, getItem: () => null});
    vi.stubGlobal('sessionStorage', {setItem: () => {}, getItem: () => null});
    const client = makeClient();
    client.videoAnalyzer.disable = vi.fn();
    client.interfaceController.updateAutoNextIndicator = vi.fn();
    client.loadProgressData = vi.fn(async () => {});

    client.setOptions({bufferAhead: -1, bufferBehind: -1});
    expect([client.options.bufferAhead, client.options.bufferBehind, client.state.bufferBehind]).toEqual([Infinity, Infinity, Infinity]);
    client.setOptions({bufferAhead: 0, bufferBehind: 0});
    expect([client.options.bufferAhead, client.options.bufferBehind, client.state.bufferBehind]).toEqual([0, 0, 0]);
  });
});

describe('FastStreamClient, the qualities a page\'s player offers its file in', () => {
  // a film site's hoster: one MP4 per quality (page-qualities.js lists them). The quality
  // menu offers them; the player's own levels, which the analyzers and downloads go by, stay.
  const QUALITIES = [
    {url: 'https://h.test/1_360p.mp4/', label: '360p', height: 360},
    {url: 'https://h.test/1_720p.mp4/', label: '720p', height: 720},
    {url: 'https://h.test/1.mp4/', label: '1080p', height: 1080},
  ];

  /**
   * A client playing one of the page's files.
   * @param {string} url - The one playing.
   * @return {Promise<{client: FastStreamClient, player: FakePlayer}>}
   */
  async function playing(url) {
    const client = makeClient();
    client.recoveries = {url: null, times: []};
    const player = await setSource(client, makeSource(url, {qualities: QUALITIES}), (made) => {
      made.duration = 7200;
      made.getVideoLevels = () => new Map([['0:0', {id: '0:0', width: 1920, height: 816}]]);
      made.getCurrentVideoLevelID = () => '0:0';
      made.video.videoWidth = 1920;
      made.video.videoHeight = 816;
    });
    return {client, player};
  }

  it('offers them in the menu, the one playing with its own size', async () => {
    const {client} = await playing(QUALITIES[2].url);
    const levels = Array.from(client.getMenuVideoLevels().values());
    expect(levels.map((level) => [level.id, level.label, level.width, level.height])).toEqual([
      ['page-quality:0', '360p', 0, 360],
      ['page-quality:1', '720p', 0, 720],
      ['page-quality:2', '1080p', 1920, 816],
    ]);
    expect(client.getMenuVideoLevelID()).toBe('page-quality:2');
    // The player's own.
    expect(Array.from(client.getVideoLevels().keys())).toEqual(['0:0']);
    expect(client.getCurrentVideoLevelID()).toBe('0:0');
  });

  it('leaves the menu to a player with qualities of its own', async () => {
    const {client, player} = await playing(QUALITIES[2].url);
    player.getVideoLevels = () => new Map([['a', {id: 'a'}], ['b', {id: 'b'}]]);
    expect(Array.from(client.getMenuVideoLevels().keys())).toEqual(['a', 'b']);
  });

  it('plays the one picked in the menu from where it was, on playing as it played', async () => {
    const {client, player} = await playing(QUALITIES[2].url);
    player._currentTime = 600.7;
    player.paused = false;
    let made = null;
    client.playerLoader.createPlayer = vi.fn(async () => {
      made = new FakePlayer(null);
      made.duration = 7200;
      return made;
    });
    const plays = [];
    client.play = vi.fn(async () => {
      plays.push(client.player.currentTime);
    });

    client.setCurrentVideoLevelID('page-quality:1');
    await client.sourceChange;
    await settle();

    expect(client.source.url).toBe(QUALITIES[1].url);
    expect(client.source.qualities.map((entry) => entry.url)).toEqual(QUALITIES.map((entry) => entry.url));
    expect(made.seeks).toContain(600);
    expect(plays).toEqual([600]);
    expect(client.getMenuVideoLevelID()).toBe('page-quality:1');
  });

  it('does nothing for the one playing', async () => {
    const {client} = await playing(QUALITIES[2].url);
    const setSource = vi.spyOn(client, 'setSource');
    client.setCurrentVideoLevelID('page-quality:2');
    expect(setSource).not.toHaveBeenCalled();
  });
});

describe('FastStreamClient, the page\'s qualities with a query of their own', () => {
  it('knows which plays after a switch, though the time came and went in the query', async () => {
    // Taking faststream-timestamp off a URL keeps its query as written ("a b", not "a+b").
    const qualities = [
      {url: 'https://h.test/v?q=360&t=a%20b', label: '360p', height: 360},
      {url: 'https://h.test/v?q=720&t=a%20b', label: '720p', height: 720},
    ];
    const client = makeClient();
    client.recoveries = {url: null, times: []};
    const player = await setSource(client, makeSource(qualities[1].url, {qualities}), (made) => {
      made.duration = 7200;
    });
    player._currentTime = 30;
    client.playerLoader.createPlayer = vi.fn(async () => {
      const made = new FakePlayer(null);
      made.duration = 7200;
      return made;
    });
    client.play = vi.fn(async () => {});

    client.setCurrentVideoLevelID('page-quality:0');
    await client.sourceChange;
    await settle();

    // The time comes and goes without the query written anew (URLUtils.withTimestamp): the
    // file played is the entry's, byte for byte.
    expect(client.source.url).toBe(qualities[0].url);
    expect(client.getMenuVideoLevelID()).toBe('page-quality:0');
    expect(client.getMenuVideoLevels().size).toBe(2);
  });
});

describe('FastStreamClient, the seek preview\'s player', () => {
  it('is destroyed when building it fails', async () => {
    // Nothing else held it: its video and its loader, which may go on fetching, lived on for
    // the page's life, one for each failed build.
    const client = makeClient({previewEnabled: true});
    const preview = {
      setup: vi.fn(async () => {}),
      setSource: vi.fn(async () => {
        throw new Error('level load failed');
      }),
      destroy: vi.fn(),
    };
    client.player = {getSource: () => ({mode: 'hls', url: 'https://cdn.test/x.m3u8'})};
    client.playerLoader.createPlayer = vi.fn(async () => preview);
    client.bindPreviewPlayer = vi.fn();
    await expect(client.buildPreviewPlayer()).rejects.toThrow('level load failed');
    expect(preview.destroy).toHaveBeenCalledTimes(1);
    expect(client.previewPlayer).toBeNull();
  });

  /** A preview player: an emitter whose contexts can be counted. */
  const previewOf = (setSource) => Object.assign(new EventEmitter(), {
    setup: async () => {}, setSource, destroy: vi.fn(), getVideo: () => ({}),
  });

  it('keeps its listeners only on a build that is shown', async () => {
    // A build for a replaced video lets go of its context: only the shown preview's stays.
    const client = makeClient({previewEnabled: true});
    let playing = {mode: 'hls', url: 'https://cdn.test/a.m3u8'};
    client.player = {getSource: () => playing};
    const stale = previewOf(async () => {
      playing = {mode: 'hls', url: 'https://cdn.test/b.m3u8'};
    });
    client.playerLoader.createPlayer = vi.fn(async () => stale);
    await client.buildPreviewPlayer();
    expect(stale.destroy).toHaveBeenCalledTimes(1);
    expect(stale.contexts).toHaveLength(1);
    expect(client.previewContext).toBeNull();

    const shown = previewOf(async () => {});
    client.playerLoader.createPlayer = vi.fn(async () => shown);
    client.interfaceController.addPreviewVideo = vi.fn();
    client.updateVideoTransform = vi.fn();
    await client.buildPreviewPlayer();
    expect(client.previewPlayer).toBe(shown);
    expect(shown.contexts).toContain(client.previewContext);
  });

  it('lets the shown preview be when another one fails', () => {
    const client = makeClient({previewEnabled: true});
    client.interfaceController.resetPreviewVideo = vi.fn();
    client.setupPreviewPlayer = vi.fn(async () => {});
    const shown = previewOf(async () => {});
    client.previewPlayer = shown;
    client.previewContext = client.bindPreviewPlayer(shown);
    const stale = previewOf(async () => {});
    client.bindPreviewPlayer(stale);
    stale.emit(DefaultPlayerEvents.ERROR, new Error('the old video\'s level failed'));
    expect(shown.destroy).not.toHaveBeenCalled();
    expect(client.previewPlayer).toBe(shown);
    expect(client.setupPreviewPlayer).not.toHaveBeenCalled();

    // Its own error lets go of it and of its listeners, and builds it again.
    shown.emit(DefaultPlayerEvents.ERROR, new Error('segment expired'));
    expect(shown.destroy).toHaveBeenCalledTimes(1);
    expect(shown.contexts).toHaveLength(1);
    expect(client.previewContext).toBeNull();
    expect(client.setupPreviewPlayer).toHaveBeenCalledTimes(1);
  });

  it('lets go of its listeners when the preview is switched off', () => {
    // switched on again, the old context is destroyed
    vi.stubGlobal('document', {body: {dataset: {}}, getElementById: () => null});
    vi.stubGlobal('localStorage', {setItem: () => {}, getItem: () => null});
    vi.stubGlobal('sessionStorage', {setItem: () => {}, getItem: () => null});
    try {
      const client = makeClient({previewEnabled: true});
      client.videoAnalyzer.disable = vi.fn();
      client.interfaceController.updateAutoNextIndicator = vi.fn();
      client.interfaceController.resetPreviewVideo = vi.fn();
      client.loadProgressData = vi.fn(async () => {});
      const shown = previewOf(async () => {});
      client.previewPlayer = shown;
      client.previewContext = client.bindPreviewPlayer(shown);
      client.setOptions({previewEnabled: false});
      expect(shown.destroy).toHaveBeenCalledTimes(1);
      // Its main context stays.
      expect(shown.contexts).toHaveLength(1);
      expect(client.previewContext).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('FastStreamClient, a player that fails to set up', () => {
  it('is destroyed, and is not left as the player', async () => {
    // A load that ends in an error leaves no player in client.player, ticked by the main loop.
    const client = makeClient();
    let made = null;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = await setSource(client, makeSource('https://cdn.test/x.m3u8'), (player) => {
      made = player;
      player.setup = vi.fn(async () => {
        throw new Error('no MediaSource');
      });
      vi.spyOn(player, 'destroy');
    });
    expect(failing).toBe(made);
    expect(made.destroy).toHaveBeenCalledTimes(1);
    expect(client.player).toBeNull();
  });

  it('leaves no listeners and no wait for a picture when it could not take the source', async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const made = await setSource(client, makeSource('https://cdn.test/z.m3u8'), (player) => {
        player.setSource = vi.fn(async () => {
          throw new Error('no level');
        });
      });
      expect(client.player).toBeNull();
      expect(client.context).toBeNull();
      expect(made.contexts).toHaveLength(1);
      expect(client.initPromise).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not destroyed once it has taken the source', async () => {
    const client = makeClient();
    const player = await setSource(client, makeSource('https://cdn.test/y.m3u8'), (made) => {
      vi.spyOn(made, 'destroy');
    });
    expect(player.destroy).not.toHaveBeenCalled();
    expect(client.player).toBe(player);
  });
});

describe('FastStreamClient, a seek preview that keeps failing', () => {
  /**
   * A client whose seek preview is bound, with its rebuild counted.
   * @return {{client: Object, context: EventEmitter}}
   */
  function previewFailing() {
    const client = makeClient({previewEnabled: true});
    client.interfaceController.resetPreviewVideo = vi.fn();
    const context = new EventEmitter();
    // A preview that was built, and is built again the same way after each error.
    const preview = {createContext: () => context, destroy() {}};
    client.previewPlayer = preview;
    client.setupPreviewPlayer = vi.fn(async () => {
      client.previewPlayer = preview;
    });
    client.bindPreviewPlayer(preview);
    return {client, context, preview};
  }

  it('is built again at most three times in two minutes', () => {
    // A preview that fails each time is rebuilt at a capped rate, as the main player.
    vi.useFakeTimers();
    try {
      const {client, context, preview} = previewFailing();
      // Each error from a preview that was built (one still being built is its build's).
      const fail = () => {
        client.previewPlayer = preview;
        context.emit(DefaultPlayerEvents.ERROR, new Error('preview failed'));
      };
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(2000);
        fail();
      }
      expect(client.setupPreviewPlayer).toHaveBeenCalledTimes(3);
      // ... and again once those two minutes are over, as recoverPlayer is.
      vi.advanceTimersByTime(120000);
      fail();
      expect(client.setupPreviewPlayer).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is built again after each of a long video\'s rare errors', () => {
    // the cap is per window of time, not for the whole video
    vi.useFakeTimers();
    try {
      const {client, context} = previewFailing();
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(10 * 60000);
        context.emit(DefaultPlayerEvents.ERROR, new Error('segment expired'));
      }
      expect(client.setupPreviewPlayer).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});

// A source's headers hold the page's Cookie and Authorization, and a console shown to
// someone (a screenshot, a bug report) handed the session on with them.
describe('addSource', () => {
  it('logs the source without its headers', async () => {
    const client = makeClient();
    client.sourcesBrowser = {addSource: (s) => s, updateSources() {}};
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const source = {url: 'https://cdn.example/a.m3u8', mode: 'hls', headers: {Cookie: 'session=SECRET'}};
    source.copy = () => source;
    try {
      await client.addSource(source);
      expect(log).toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
    } finally {
      log.mockRestore();
    }
  });
});

describe('tryNextSource', () => {
  it('logs the next stream without its headers', () => {
    // It logged the whole source, the page's Cookie in its headers.
    const client = makeClient();
    client.sourcesBrowser = {updateSources() {}};
    client.setSource = vi.fn(async () => {});
    const next = {url: 'https://cdn.example/b.m3u8', mode: 'hls', headers: {Cookie: 'session=SECRET'}};
    client.fallbacks = {request: client.sourceRequests, sources: [next]};
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(client.tryNextSource()).toBe(true);
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('FastStreamClient, the media overlay\'s picture', () => {
  // A frame of the video at once, and one ARTWORK_AFTER_S in, past a black start (takeArtwork).

  /**
   * A client whose video is at `time`, with the overlay's keys stood in for.
   * @param {number} duration
   * @return {{client: FastStreamClient, at: (time: number) => void, setArtwork: Function}}
   */
  function overlay(duration = 60) {
    const client = makeClient();
    const player = new FakePlayer(makeSource('http://127.0.0.1/a.mp4'));
    player.duration = duration;
    Object.assign(player.video, {readyState: 2, currentTime: 0});
    client.player = player;
    client.artworkTaken = false;
    client.artworkAt = null;
    const setArtwork = vi.fn();
    client.interfaceController.toolManager = {mediaKeys: {setArtwork}};
    return {
      client, setArtwork, at: (time) => {
        player.video.currentTime = time;
        client.takeArtwork();
      },
    };
  }

  it('takes the first frame, and one 5 s in, then no more', () => {
    const {at, setArtwork} = overlay();
    at(0);
    at(1);
    at(4.9);
    expect(setArtwork).toHaveBeenCalledTimes(1);
    at(5.2);
    expect(setArtwork).toHaveBeenCalledTimes(2);
    at(30);
    expect(setArtwork).toHaveBeenCalledTimes(2);
  });

  it('takes the second halfway into a video shorter than 10 s', () => {
    // A 3 s video never got its frame 5 s in: the black first one stayed.
    const {at, setArtwork} = overlay(3);
    at(0);
    at(1.4);
    expect(setArtwork).toHaveBeenCalledTimes(1);
    at(1.6);
    expect(setArtwork).toHaveBeenCalledTimes(2);
  });

  it('waits again after a loop back to the start, not taking its first frame as the last', () => {
    const {at, setArtwork} = overlay();
    at(55);
    at(0.2);
    expect(setArtwork).toHaveBeenCalledTimes(1);
    at(5.3);
    expect(setArtwork).toHaveBeenCalledTimes(2);
  });

  it('waits 5 s into a live stream, which has no length', () => {
    const {at, setArtwork} = overlay(Infinity);
    at(100);
    at(102);
    expect(setArtwork).toHaveBeenCalledTimes(1);
    at(105.5);
    expect(setArtwork).toHaveBeenCalledTimes(2);
  });
});

describe('FastStreamClient, frames this computer drops', () => {
  // A quality that drops frames steps down, and the player says so each time.
  const LEVELS = [
    {id: '1080', height: 1080, width: 1920, bitrate: 5e6},
    {id: '720', height: 720, width: 1280, bitrate: 2.5e6},
  ];

  /**
   * A client playing the 1080p version of a two-version stream, whose video reports the
   * frames counted so far.
   * @param {Object} [options]
   * @return {{client: FastStreamClient, player: FakePlayer, counts: {total: number, dropped: number}}}
   */
  function playing(options = {}) {
    const client = makeClient({lowerOnDroppedFrames: true, ...options});
    const player = new FakePlayer(makeSource('http://127.0.0.1/a.m3u8'));
    const counts = {total: 0, dropped: 0};
    Object.assign(player.video, {
      paused: false, seeking: false, readyState: 4,
      getVideoPlaybackQuality: () => ({totalVideoFrames: counts.total, droppedVideoFrames: counts.dropped}),
    });
    player.getVideoLevels = () => new Map(LEVELS.map((level) => [level.id, level]));
    player.videoLevel = '1080';
    player.setCurrentVideoLevelID = vi.fn((id) => {
      player.videoLevel = id;
    });
    client.player = player;
    client.droppedFrameWatch = new DroppedFrameWatch();
    client.droppedSampledAt = 0;
    return {client, player, counts};
  }

  /**
   * Plays `seconds` at 30 frames a second, of which a share is dropped, with the client's
   * time updates four times a second.
   */
  function play({client, counts}, seconds, dropRatio = 0.3) {
    for (let i = 0; i < seconds * 4; i++) {
      vi.advanceTimersByTime(250);
      counts.total += 7.5;
      counts.dropped += 7.5 * dropRatio;
      client.watchDroppedFrames();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(1_000_000);
    vi.stubGlobal('document', {visibilityState: 'visible'});
  });

  it('steps down a quality and says so, naming the version to choose again', () => {
    const playback = playing();
    const message = vi.spyOn(Localize, 'getMessage');
    play(playback, 20);
    expect(playback.player.setCurrentVideoLevelID).toHaveBeenCalledTimes(1);
    expect(playback.player.setCurrentVideoLevelID).toHaveBeenCalledWith('720');
    expect(message).toHaveBeenCalledWith('player_quality_lowered', ['720p', '30', '1080p']);
    expect(playback.client.interfaceController.setStatusMessage)
        .toHaveBeenCalledWith('quality', 'player_quality_lowered', 'warning', 15000);
  });

  it('keeps the version a computer shows well enough', () => {
    const playback = playing();
    play(playback, 60, 0.1);
    expect(playback.player.setCurrentVideoLevelID).not.toHaveBeenCalled();
    expect(playback.client.interfaceController.setStatusMessage).not.toHaveBeenCalled();
  });

  it('does nothing with the setting off', () => {
    const playback = playing({lowerOnDroppedFrames: false});
    play(playback, 60);
    expect(playback.player.setCurrentVideoLevelID).not.toHaveBeenCalled();
  });

  it('does not count a fast speed, which drops frames by design', () => {
    const playback = playing();
    playback.player.playbackRate = 2;
    play(playback, 60);
    expect(playback.player.setCurrentVideoLevelID).not.toHaveBeenCalled();
  });

  it('does not count a hidden tab, which shows no frames', () => {
    const playback = playing();
    vi.stubGlobal('document', {visibilityState: 'hidden'});
    play(playback, 60);
    expect(playback.player.setCurrentVideoLevelID).not.toHaveBeenCalled();
  });

  it('counts a hidden tab whose video plays in picture-in-picture', () => {
    const playback = playing();
    vi.stubGlobal('document', {visibilityState: 'hidden'});
    playback.client.interfaceController.isInPip = () => true;
    play(playback, 20);
    expect(playback.player.setCurrentVideoLevelID).toHaveBeenCalledWith('720');
  });

  it('starts the stretch again at a seek, a change of speed and a stall', async () => {
    // Firefox's counts run on through them: one between two samples would be counted.
    const client = makeClient();
    const player = await setSource(client, makeSource('http://127.0.0.1/a.m3u8'));
    const interrupt = vi.spyOn(client.droppedFrameWatch, 'interrupt');
    for (const event of [DefaultPlayerEvents.SEEKING, DefaultPlayerEvents.SEEKED, DefaultPlayerEvents.RATECHANGE,
      DefaultPlayerEvents.WAITING, DefaultPlayerEvents.PLAYING]) {
      interrupt.mockClear();
      player.emit(event);
      expect(interrupt, event).toHaveBeenCalledTimes(1);
    }
  });

  it('does not count a paused or a seeking video', () => {
    const paused = playing();
    paused.player.video.paused = true;
    play(paused, 60);
    expect(paused.player.setCurrentVideoLevelID).not.toHaveBeenCalled();
    const seeking = playing();
    seeking.player.video.seeking = true;
    play(seeking, 60);
    expect(seeking.player.setCurrentVideoLevelID).not.toHaveBeenCalled();
  });

  it('says nothing and changes nothing with no lower version', () => {
    const playback = playing();
    playback.player.videoLevel = '720';
    play(playback, 60);
    expect(playback.player.setCurrentVideoLevelID).not.toHaveBeenCalled();
    expect(playback.client.interfaceController.setStatusMessage).not.toHaveBeenCalled();
  });

  it('leaves a version the user chose by hand, however many frames it drops', () => {
    const playback = playing();
    playback.client.droppedFrameWatch.userChose('1080');
    play(playback, 60);
    expect(playback.player.setCurrentVideoLevelID).not.toHaveBeenCalled();
  });

  it('keeps a version picked by hand when the player plays another of the page\'s files', async () => {
    // a page quality played in a rebuilt player keeps the pick
    const playback = playing();
    const {client} = playback;
    client.source = makeSource('http://127.0.0.1/720.mp4', {qualities: [
      {url: 'http://127.0.0.1/360.mp4', height: 360}, {url: 'http://127.0.0.1/720.mp4', height: 720},
    ]});
    client.setSource = vi.fn(async () => {});
    client.playPageQuality(0);
    await settle();
    expect(client.setSource).toHaveBeenCalledTimes(1);
    expect(client.setSource.mock.calls[0][2]).toMatchObject({keepChoice: true});
  });

  it('keeps the version picked by hand over the reset of a source set with keepChoice', async () => {
    const client = makeClient();
    client.droppedFrameWatch.userChose('page-quality:0');
    await setSourceStarting(client, makeSource('http://127.0.0.1/360.mp4'), {keepChoice: true});
    expect(client.droppedFrameWatch.chosen).toBe('page-quality:0');
    await setSourceStarting(client, makeSource('http://127.0.0.1/other.mp4'), {});
    expect(client.droppedFrameWatch.chosen).toBe(null);
  });

  it('starts over with the next video', async () => {
    const playback = playing();
    playback.client.droppedFrameWatch.userChose('1080');
    await playback.client.resetPlayer();
    playback.client.player = playback.player;
    play(playback, 20);
    expect(playback.player.setCurrentVideoLevelID).toHaveBeenCalledWith('720');
  });
});

describe('FastStreamClient, a link the server refuses', () => {
  // vidmoly's shape: a signature that ends in '=', which the server refuses written as %3D.
  const OLD = 'https://prx-1.vmget.online/hls2/v_,n,.urlset/master.m3u8?t=old+sig/1=&s=1793113399&e=43200';
  const NEW = 'https://prx-1.vmget.online/hls2/v_,n,.urlset/master.m3u8?t=new+sig/2=&s=1793116532&e=43200';
  const asked = () => chrome.runtime.sendMessage.mock.calls
      .filter(([message]) => message.type === MessageTypes.REQUEST_FRESH_LINK);
  // makeClient sets none of the constructor's state for this.
  const withRenewals = (client) => {
    client.linkRenewals = {identifier: null, times: [], asking: false};
    return client;
  };
  const recordPlays = (client) => {
    const plays = [];
    client.play = vi.fn(async () => {
      plays.push(client.player.currentTime);
    });
    return plays;
  };

  it('gets the link anew from its page, and plays on with it at its time', async () => {
    // A hoster's link that runs out (and Back's cached old one) is renewed, not a spinner.
    const client = withRenewals(makeClient());
    client.downloadManager.keepStorageOnce = vi.fn();
    client.downloadManager.relink = vi.fn();
    const first = await setSource(client, makeSource(OLD), (made) => {
      made.duration = 1440;
    });
    client.playedSource = client.source;
    first._currentTime = 300.6;
    first.paused = false;
    let made = null;
    client.playerLoader.createPlayer = vi.fn(async () => {
      made = new FakePlayer(null);
      made.duration = 1440;
      made.video.readyState = 0;
      return made;
    });
    chrome.runtime.sendMessage.mockImplementation(async (message) =>
      (message.type === MessageTypes.REQUEST_FRESH_LINK ? NEW : undefined));
    const plays = recordPlays(client);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // A burst of refused segments asks once.
    client.linkRefused(403, OLD + '&seg=40');
    client.linkRefused(403, OLD + '&seg=41');
    await settle();
    await client.sourceChange;
    await settle();

    expect(asked()).toEqual([[{type: MessageTypes.REQUEST_FRESH_LINK, url: OLD}]]);
    // Byte for byte: the time came and went without the query written anew.
    expect(client.source.url).toBe(NEW);
    // The old link's downloads are kept, and found under the new link (DownloadManager.relink):
    // kept by their URL alone, the new player asked for every one again.
    expect(client.downloadManager.keepStorageOnce).toHaveBeenCalledTimes(1);
    expect(client.downloadManager.relink).toHaveBeenCalledExactlyOnceWith(OLD, NEW);
    made.video.readyState = 1;
    made.emit(DefaultPlayerEvents.LOADEDMETADATA);
    await settle();
    expect(made.seeks).toContain(300);
    expect(plays).toEqual([300]);
  });

  it('changes nothing without a new link, and asks at most twice in five minutes', async () => {
    const client = withRenewals(makeClient());
    await setSource(client, makeSource(OLD), (made) => {
      made.duration = 1440;
    });
    const built = vi.fn();
    client.playerLoader.createPlayer = built;
    chrome.runtime.sendMessage.mockImplementation(async () => null);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    for (let i = 0; i < 3; i++) {
      client.linkRefused(403, OLD);
      await settle();
    }
    expect(asked()).toHaveLength(2);
    expect(client.source.url).toBe(OLD);
    expect(built).not.toHaveBeenCalled();

    now.mockReturnValue(1_000_000 + 300_001);
    client.linkRefused(410, OLD);
    await settle();
    expect(asked()).toHaveLength(3);
  });
});

// A failure of the last source's player while the next source is on its way is not taken for the
// new one's.
describe('FastStreamClient, the last source\'s player failing while the next source is on its way in', () => {
  const nextSourceAskedFor = (client) => {
    client.sourceRequests++;
  };

  it('does not hand the last source to Firefox\'s own player', async () => {
    const client = makeClient();
    const old = await setSource(client, makeSource('https://cdn.example/old.mp4', {mode: 'accelerated_mp4'}));
    const set = vi.spyOn(client, 'setSource');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    nextSourceAskedFor(client);

    old.emit(DefaultPlayerEvents.PLAY_DIRECTLY, 'The file is not an MP4 file');
    await settle();

    expect(set).not.toHaveBeenCalled();
    expect(client.interfaceController.failedToLoad).not.toHaveBeenCalled();
  });

  it('shows no load error for its error, nor for a key it lacks', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient();
    const old = await setSource(client, makeSource('https://cdn.example/old.m3u8'));
    nextSourceAskedFor(client);

    old.emit(DefaultPlayerEvents.ERROR, {});
    old.emit(DefaultPlayerEvents.NEED_KEY);
    await settle();

    expect(client.interfaceController.failedToLoad).not.toHaveBeenCalled();
  });

  it('still fails as before while its source is the one being played', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient();
    const current = await setSource(client, makeSource('https://cdn.example/a.m3u8'));

    current.emit(DefaultPlayerEvents.NEED_KEY);
    await settle();

    expect(client.interfaceController.failedToLoad).toHaveBeenCalledExactlyOnceWith('player_error_drm');
  });

  it('does not ask for the last source\'s link anew, nor rebuild it with one that comes late', async () => {
    const OLD = 'https://cdn.example/hls/master.m3u8?sig=old';
    const client = makeClient();
    client.linkRenewals = {identifier: null, times: [], asking: false};
    client.downloadManager.keepStorageOnce = vi.fn();
    client.downloadManager.relink = vi.fn();
    await setSource(client, makeSource(OLD));
    const built = vi.fn();
    client.playerLoader.createPlayer = built;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const asked = () => chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.type === MessageTypes.REQUEST_FRESH_LINK);

    nextSourceAskedFor(client);
    client.linkRefused(403, OLD);
    await settle();
    expect(asked()).toEqual([]);

    // Refused while it was the source; the next one asked for before the new link came.
    client.fallbacks.request = client.sourceRequests;
    let answer;
    chrome.runtime.sendMessage.mockImplementation((message) => (message.type === MessageTypes.REQUEST_FRESH_LINK ?
      new Promise((resolve) => {
        answer = resolve;
      }) : Promise.resolve()));
    client.linkRefused(403, OLD);
    await settle();
    expect(asked()).toHaveLength(1);
    nextSourceAskedFor(client);
    answer('https://cdn.example/hls/master.m3u8?sig=new');
    await settle();
    // A rebuild would be under way there (the first case's wait).
    await client.sourceChange;
    await settle();
    expect(built).not.toHaveBeenCalled();
    expect(client.source.url).toBe(OLD);
  });
});

// An unreadable MP4 plays in Firefox's own player inside FastStream; the error tells the site's
// way. Never steps aside.
describe('FastStreamClient, a video its player cannot read', () => {
  const mp4 = () => makeSource('https://cdn.example/a.mp4', {mode: 'accelerated_mp4'});
  const quiet = () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  };

  it('tries an MP4 file in Firefox\'s own player before the load error', async () => {
    quiet();
    const client = makeClient();
    const player = await setSource(client, mp4());
    const set = vi.spyOn(client, 'setSource').mockImplementation(async () => {});

    player.emit(DefaultPlayerEvents.ERROR, 'Invalid data found while parsing box');
    await settle();

    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0].mode).toBe('direct');
    expect(client.interfaceController.failedToLoad).not.toHaveBeenCalled();
  });

  it('shows the error for a refused range, which Firefox\'s own player would be refused too', async () => {
    quiet();
    const client = makeClient();
    const player = await setSource(client, mp4());
    const set = vi.spyOn(client, 'setSource').mockImplementation(async () => {});

    player.emit(DefaultPlayerEvents.ERROR, 'Range 3 failed to load');
    await settle();

    expect(set).not.toHaveBeenCalled();
    expect(client.interfaceController.failedToLoad).toHaveBeenCalledTimes(1);
  });

  it('rebuilds a video that showed a picture first, and plays it in Firefox\'s own player when that is no way out', async () => {
    quiet();
    const client = makeClient();
    const player = await setSource(client, mp4());
    player.emit(DefaultPlayerEvents.LOADEDDATA);
    await settle();
    const recover = vi.spyOn(client, 'recoverPlayer').mockReturnValue(true);
    const set = vi.spyOn(client, 'setSource').mockImplementation(async () => {});

    player.emit(DefaultPlayerEvents.ERROR, 'Invalid data found while parsing box');
    await settle();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();

    // Its rebuilds used up (RECOVERY_LIMIT).
    recover.mockReturnValue(false);
    player.emit(DefaultPlayerEvents.ERROR, 'Invalid data found while parsing box');
    await settle();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0].mode).toBe('direct');
    expect(client.interfaceController.failedToLoad).not.toHaveBeenCalled();
  });

  it('shows the error when Firefox\'s own player cannot play the file either', async () => {
    quiet();
    const client = makeClient();
    const player = await setSource(client, mp4());
    client.playedDirectly = client.recoverySourceURL(client.source.url);

    player.emit(DefaultPlayerEvents.ERROR, 'Invalid data found while parsing box');
    await settle();

    expect(client.interfaceController.failedToLoad).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/^player_error_load \(Invalid data found while parsing box\)/));
  });

  it('tells how to watch the video in the site\'s own player, in a page only', () => {
    const client = makeClient();
    const own = {};
    own.top = own;
    const before = Object.getOwnPropertyDescriptor(globalThis, 'window');
    try {
      globalThis.window = {top: {}};
      expect(client.loadErrorMessage('404')).toBe('player_error_load (404) player_error_turn_off');
      globalThis.window = own;
      expect(client.loadErrorMessage('404')).toBe('player_error_load (404)');
      expect(client.loadErrorMessage()).toBe('player_error_load');
    } finally {
      delete globalThis.window;
      if (before) Object.defineProperty(globalThis, 'window', before);
    }
  });
});

describe('FastStreamClient, going while its buffer is on the disk', () => {
  // destroy() awaits the reset: the OPFS worker gets 'clear' before 'destroy', and buffers handed
  // over stay.

  /**
   * A client whose download manager is the real one, its store's OPFS worker a stand-in that
   * records each call and answers them in order, a task later, as the worker's queue does.
   * @return {Promise<{client: FastStreamClient, manager: Object, ops: string[]}>}
   */
  async function goingClient() {
    vi.useFakeTimers();
    vi.stubGlobal('document', {removeEventListener: vi.fn()});
    // IndexedDBManager, which the store imports, listens on the window as it loads.
    vi.stubGlobal('window', {...window, addEventListener: vi.fn()});
    const {DownloadManager} = await vi.importActual('../../chrome/player/network/DownloadManager.mjs');
    const {OPFSManager} = await import('../../chrome/player/network/OPFSManager.mjs');
    const {DownloadEntry} = await import('../../chrome/player/network/DownloadEntry.mjs');
    const client = makeClient();
    client.peers = {stop: vi.fn()};
    client.interfaceController.destroy = vi.fn();
    const manager = new DownloadManager(client);
    client.downloadManager = manager;
    const ops = [];
    const opfs = new OPFSManager();
    opfs.sessionName = 'fsblob-1-1';
    opfs.worker = {
      postMessage: ({id, op}) => {
        ops.push(op);
        setTimeout(() => opfs.handleMessage({id, ok: true}));
      },
      terminate: () => ops.push('terminated'),
    };
    Object.assign(manager.blobStore, {opfsManager: opfs, setupPromise: Promise.resolve()});

    // A finished segment, written to the disk since: a file in the session, no longer in RAM.
    const url = 'https://cdn.test/v/master.m3u8';
    const entry = new DownloadEntry({url: 'https://cdn.test/v/seg-1.ts', responseType: 'arraybuffer'});
    entry.status = DownloadStatus.DOWNLOAD_COMPLETE;
    entry.data = new Blob(['segment']);
    await manager.archiveEntryData(entry);
    const id = manager.getIdentifier(entry);
    manager.keepEntry(entry, id);
    opfs.fileName(id, true);
    manager.blobStore.inRam.delete(id);

    client.source = makeSource(url);
    client.bufferPage = {page: 'https://site.test/watch', identifier: url};
    return {client, manager, ops};
  }

  it('leaves the files it handed over on the disk', async () => {
    const {client, ops} = await goingClient();
    chrome.runtime.sendMessage = vi.fn(async () => {});
    client.handOffBuffer();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: MessageTypes.BUFFER_STASH, session: 'fsblob-1-1', entries: [expect.objectContaining({file: 'f0'})]}));
    client.destroy();
    await vi.runAllTimersAsync();

    expect(ops).toEqual(['destroy', 'terminated']);
  });

  it('deletes its files on the disk before it closes its store, with nothing handed over', async () => {
    const {client, manager, ops} = await goingClient();
    client.destroy();
    await vi.runAllTimersAsync();

    expect(ops).toEqual(['clear', 'destroy', 'terminated']);
    expect(manager.blobStore).toBe(null);
  });

  it('goes the same way while a save runs', async () => {
    const {client, manager, ops} = await goingClient();
    let saveEnded;
    client.interfaceController.saveManager = {
      makingDownload: true,
      downloadCancel: vi.fn(),
      pendingSave: new Promise((resolve) => {
        saveEnded = resolve;
      }),
      resetMpvContentType: vi.fn(),
    };
    client.destroy();
    expect(client.interfaceController.saveManager.downloadCancel).toHaveBeenCalled();
    setTimeout(saveEnded, 100);
    await vi.runAllTimersAsync();

    expect(ops).toEqual(['clear', 'destroy', 'terminated']);
    expect(manager.downloaders).toBe(null);
  });
});

describe('FastStreamClient, the seek preview shown', () => {
  /**
   * A client whose seek preview's element is at 9 s with its frame there, the preview's
   * player pointed at `time`.
   * @param {number} time
   * @return {Object}
   */
  function previewAt(time) {
    const client = makeClient({previewEnabled: true});
    client.previewPlayer = {
      getVideo: () => ({readyState: 2, currentTime: 9, style: {}}),
      currentTime: time,
      buffered: {length: 1, start: () => 0, end: () => 9},
    };
    vi.spyOn(client, 'showPreview').mockImplementation(() => {});
    vi.spyOn(client, 'hidePreview').mockImplementation(() => {});
    return client;
  }

  it('is hidden while its player holds a place its element is not at yet', () => {
    // an MP4 preview past the known duration still shows the frame before
    const client = previewAt(120);
    client.updatePreview();
    expect(client.hidePreview).toHaveBeenCalledTimes(1);
    expect(client.showPreview).not.toHaveBeenCalled();
  });

  it('is shown once its element has a frame at the place', () => {
    const client = previewAt(9);
    client.updatePreview();
    expect(client.showPreview).toHaveBeenCalledTimes(1);
    expect(client.hidePreview).not.toHaveBeenCalled();
  });
});

// Unparsed fMP4 ranges (start/end -1) in a download window are not taken for ranges long behind.
describe('FastStreamClient, a fragmented MP4\'s ranges not parsed yet, in a download window', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * A 600 s file in ten ranges of 60 s: the first four parsed, the next two downloaded
   * ahead of the parser, the last four waiting.
   * @param {number} time - Where it plays.
   * @param {Object} [options]
   * @return {{client: Object, frags: Array<Object>}}
   */
  function windowed(time, options = {}) {
    vi.stubGlobal('navigator', {onLine: true});
    const client = makeClient({downloadAll: false, maxSpeed: -1, ...options});
    const frags = [];
    for (let i = 0; i < 10; i++) {
      const fragment = new Fragment('L', i);
      fragment.getContext = () => ({url: 'u', rangeStart: i * 1e6, rangeEnd: (i + 1) * 1e6});
      if (i <= 3) {
        fragment.start = i * 60;
        fragment.end = i === 3 ? 600 : (i + 1) * 60;
        fragment.status = DownloadStatus.DOWNLOAD_COMPLETE;
        fragment.addReference(ReferenceTypes.MP4PLAYER);
      } else if (i <= 5) {
        fragment.status = DownloadStatus.DOWNLOAD_COMPLETE;
      }
      frags.push(fragment);
    }
    client.fragmentsStore = {L: frags};
    client.state.currentTime = time;
    client.state.bufferAhead = options.bufferAhead ?? 300;
    client.state.bufferBehind = 20;
    client.getVideoAhead = () => 120;
    client.needsUserInteraction = () => false;
    client.interfaceController.saveManager = {makingDownload: false};
    client.downloadManager = {yielding: false, waiting: false, memoryFull: false, holdTest: vi.fn(), getSpeed: () => 0, removeFile: vi.fn(),
      canGetFile: () => true, activeCount: () => 0, urgentParallel: () => 6};
    client.player = {duration: 600, getVideo: () => null, currentFragment: frags[Math.min(3, Math.floor(time / 60))], currentAudioFragment: null,
      getCurrentVideoLevelID: () => 'L', getCurrentAudioLevelID: () => null,
      downloadFragment: vi.fn((fragment) => {
        fragment.status = DownloadStatus.DOWNLOAD_INITIATED;
        return Promise.resolve();
      })};
    return {client, frags};
  }

  const started = (client) => client.player.downloadFragment.mock.calls.map(([fragment]) => fragment.sn);

  it('goes on downloading them ahead past 19 s, as far as the window reaches', () => {
    const {client} = windowed(25);
    expect(client.shouldDownloadAll()).toBeFalsy();
    client.predownloadFragments();
    // 300 s ahead of 25 s: the ranges that start, about, at 360 s and after wait.
    expect(started(client)).toEqual([]);
    const far = windowed(100);
    far.client.predownloadFragments();
    expect(started(far.client)).toEqual([6]);
    const farther = windowed(200);
    farther.client.predownloadFragments();
    expect(started(farther.client)).toEqual([6, 7, 8]);
  });

  it('keeps the ones it downloaded ahead, and lets go of those the window has passed', () => {
    const {client, frags} = windowed(25);
    client.freeFragments(frags);
    expect(client.downloadManager.removeFile).not.toHaveBeenCalled();
    expect(frags[4].status).toBe(DownloadStatus.DOWNLOAD_COMPLETE);

    // Sought back to the start with a short window: they lie past it now.
    const short = windowed(5, {bufferAhead: 120});
    short.client.freeFragments(short.frags);
    expect(short.frags[4].status).toBe(DownloadStatus.WAITING);
    expect(short.frags[5].status).toBe(DownloadStatus.WAITING);
  });

  it('downloads them, and keeps them, while nothing tells where they lie', () => {
    // Only the first range parsed: no pace to place the others by.
    const {client, frags} = windowed(25);
    for (const fragment of frags.slice(1, 4)) {
      fragment.start = -1;
      fragment.end = -1;
    }
    client.freeFragments(frags);
    expect(client.downloadManager.removeFile).not.toHaveBeenCalled();
    client.predownloadFragments();
    expect(started(client)).toEqual([6, 7, 8, 9]);
  });
});

describe('FastStreamClient, what the other players hear (peerState)', () => {
  // perConnection set during the speed test and taken back after: a background player keeps waiting
  // its turn.
  const shared = (manager) => {
    const client = makeClient();
    client.downloadManager = manager;
    client.getVideoAhead = () => 0;
    client.isLive = () => false;
    client.wantsNetwork = () => true;
    client.videoRate = () => 0;
    return client.peerState().shared;
  };

  it('says a server limits each connection only once the speed test says so', () => {
    expect(shared({perConnection: true, testing: true, limitedPerConnection: () => false})).toBe(true);
    expect(shared({perConnection: true, testing: false, limitedPerConnection: () => true})).toBe(false);
    expect(shared(null)).toBe(true);
  });
});

// The player-core audit: each case failed before its fix.
describe('FastStreamClient, the player-core audit', () => {
  /**
   * Records what the client plays, and at which time of its player.
   * @param {FastStreamClient} client
   * @return {Array<number>}
   */
  function recordPlays(client) {
    const plays = [];
    client.play = vi.fn(async () => {
      plays.push(client.player.currentTime);
    });
    return plays;
  }

  it('skips a source change that a later one replaced while it waited its turn', async () => {
    const client = makeClient();
    const built = [];
    client.playerLoader.createPlayer = vi.fn(async () => {
      const player = new FakePlayer(null);
      built.push(player);
      return player;
    });
    const changes = [
      client.setSource(makeSource('https://a.test/a.m3u8')),
      client.setSource(makeSource('https://a.test/b.m3u8')),
      client.setSource(makeSource('https://a.test/c.m3u8')),
    ];
    await Promise.all(changes);
    await settle();
    // a started at once; b was replaced by c before its turn.
    expect(built.length).toBe(2);
    expect(client.source.url).toBe('https://a.test/c.m3u8');
  });

  it('does not play again after the user paused an autoplay that started during the setup', async () => {
    const client = makeClient({autoPlay: true});
    const plays = recordPlays(client);
    client.setupPreviewPlayer = vi.fn(async () => {
      await settle();
    });
    await setSource(client, makeSource('http://127.0.0.1/film.mp4'), (made) => {
      made.setSource = async () => {
        made.emit(DefaultPlayerEvents.CANPLAY);
      };
    });
    expect(plays.length).toBe(1);
  });

  it('autoplays a source with a remembered time only once that time is applied', async () => {
    const client = makeClient({autoPlay: true, storeProgress: true});
    client.progressMemory = makeProgressMemory({lastTime: 1200});
    const plays = recordPlays(client);
    const player = await setSource(client, makeSource('http://127.0.0.1/film.mp4'), (made) => {
      made.duration = 7200;
      made.setSource = async () => {
        made.emit(DefaultPlayerEvents.CANPLAY);
      };
    });
    await settle();
    expect(player.seeks).toContain(1200);
    expect(plays).toEqual([1200]);
  });

  it('autoplays without the remembered time when its lookup does not answer', async () => {
    vi.useFakeTimers();
    const client = makeClient({autoPlay: true, storeProgress: true});
    client.progressMemory = makeProgressMemory({lastTime: 1200}, new Promise(() => {}));
    const plays = recordPlays(client);
    await setSource(client, makeSource('http://127.0.0.1/film.mp4'), (made) => {
      made.duration = 7200;
    });
    expect(plays).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(plays).toEqual([0]);
  });

  it('skips the remembered time for the episode it went on to, not for a source picked later', async () => {
    const client = makeClient({storeProgress: true, disableLoadProgress: true});
    client.progressMemory = makeProgressMemory({lastTime: 30});
    const next = await setSource(client, makeSource('http://127.0.0.1/ep2.mp4'));
    expect(next.seeks).not.toContain(30);
    client.progressMemory = makeProgressMemory({lastTime: 30});
    const picked = await setSource(client, makeSource('http://127.0.0.1/other.mp4'));
    expect(picked.seeks).toContain(30);
  });

  it('loads a source again without a failed codec where it was, with what it had, playing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient();
    client.downloadManager.keepStorageOnce = vi.fn();
    const source = makeSource('https://cdn.example/film.mpd');
    const first = await setSource(client, source, (player) => {
      player.duration = 7200;
      player.takeCodecReload = () => true;
    });
    first._currentTime = 3600.7;
    first.paused = false;
    const plays = recordPlays(client);
    let second = null;
    client.playerLoader.createPlayer = vi.fn(async () => {
      second = new FakePlayer(source);
      second.duration = 7200;
      return second;
    });

    first.emit(DefaultPlayerEvents.ERROR, {}, 'decode');
    await client.sourceChange;
    await settle();

    expect(client.source.url).toBe(source.url);
    expect(second.seeks).toContain(3600);
    expect(client.downloadManager.keepStorageOnce).toHaveBeenCalled();
    expect(plays).toEqual([3600]);
  });

  it('builds a player again once more when the rebuilt one fails before its first frame', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient();
    client.downloadManager.keepStorageOnce = vi.fn();
    client.recoveries = {url: null, times: []};
    const first = await setSource(client, makeSource('http://127.0.0.1/film.mp4'), (made) => {
      made.duration = 7200;
    });
    client.playedSource = client.source;
    first._currentTime = 600;
    let rebuilt = null;
    client.playerLoader.createPlayer = vi.fn(async () => {
      rebuilt = new FakePlayer(makeSource('http://127.0.0.1/film.mp4'));
      rebuilt.duration = 7200;
      return rebuilt;
    });
    expect(client.recoverPlayer(first, 'Playback stuck at 600')).toBe(true);
    await client.sourceChange;
    await settle();
    // No LOADEDDATA from the rebuilt one: the same place fails again.
    expect(client.recoverPlayer(rebuilt, 'Playback stuck at 600')).toBe(true);
  });

  it('does not predownload a live HLS stream as a whole video, whose duration is finite', () => {
    const client = makeClient({downloadAll: true});
    const player = new FakePlayer(makeSource('http://127.0.0.1/live.m3u8'));
    player.duration = 120;
    player.isLive = true;
    player.videoLevel = 'video-1';
    player.getVideoLevels = () => new Map([['video-1', {bitrate: 5e6}]]);
    client.player = player;
    client.hasDownloadSpace = true;
    client.storageAvailable = 1e12;

    client.updateHasDownloadSpace();

    expect(client.hasDownloadSpace).toBe(false);
    expect(client.shouldDownloadAll()).toBeFalsy();
  });

  it('does not go on to the next video while a live stream waits at its live edge', async () => {
    const client = makeClient({autoplayNext: true});
    const player = new FakePlayer(makeSource('http://127.0.0.1/live.m3u8'));
    player.duration = 120;
    player.isLive = true;
    player._currentTime = 119.6;
    client.player = player;
    client.state.hasNextVideo = true;
    client.bindPlayer(player);
    player.emit(DefaultPlayerEvents.WAITING);
    await settle();
    const navigations = chrome.runtime.sendMessage.mock.calls.filter(([message]) => message.type === MessageTypes.REQUEST_PLAYLIST_NAVIGATION);
    expect(navigations.length).toBe(0);
    expect(client.interfaceController.setBuffering).toHaveBeenCalledWith(true);
  });

  it('does not show "playing" for a play that was waiting on the last source\'s player', async () => {
    const client = makeClient();
    const player = new FakePlayer(makeSource('http://127.0.0.1/a.mp4'));
    const started = Promise.withResolvers();
    player.play = () => started.promise;
    client.player = player;
    client.startAudio = vi.fn();
    const playing = client.play();
    await client.resetPlayer();
    started.resolve();
    await playing;
    expect(client.interfaceController.play).not.toHaveBeenCalled();
  });

  it('applies the rest of the options when web storage is refused', () => {
    vi.stubGlobal('document', {body: {dataset: {}}, getElementById: () => null});
    const refused = () => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('localStorage', {setItem: refused, getItem: refused});
    vi.stubGlobal('sessionStorage', {setItem: refused, getItem: refused});
    const client = makeClient();
    client.videoAnalyzer.disable = vi.fn();
    client.interfaceController.updateAutoNextIndicator = vi.fn();
    client.loadProgressData = vi.fn(async () => {});

    client.setOptions({decodingAwareQuality: false, autoplayNext: true});

    expect(client.options.decodingAwareQuality).toBe(false);
    expect(client.options.autoplayNext).toBe(true);
  });

  it('lets go of a seek preview that failed while it was built, and keeps none', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = makeClient({previewEnabled: true});
    client.interfaceController.resetPreviewVideo = vi.fn();
    client.interfaceController.addPreviewVideo = vi.fn();
    client.player = new FakePlayer(makeSource('http://127.0.0.1/film.mp4'));
    let preview = null;
    client.playerLoader.createPlayer = vi.fn(async () => {
      preview = new FakePlayer(makeSource('http://127.0.0.1/film.mp4'));
      preview.destroy = vi.fn();
      // Its source fails, and the setup still ends.
      preview.setSource = async () => {
        preview.emit(DefaultPlayerEvents.ERROR, new Error('manifest failed'));
      };
      return preview;
    });

    await client.setupPreviewPlayer().catch(() => {});
    await settle();

    expect(client.previewPlayer).toBe(null);
    expect(preview.destroy).toHaveBeenCalled();
    expect(client.interfaceController.addPreviewVideo).not.toHaveBeenCalled();
  });
});

describe('FastStreamClient, the player-core audit: its review', () => {
  it('applies a remembered time that comes after the wait, unless the user has sought', async () => {
    vi.useFakeTimers();
    const slow = Promise.withResolvers();
    const client = makeClient({storeProgress: true});
    client.progressMemory = makeProgressMemory({lastTime: 1200}, slow.promise);
    const player = await setSource(client, makeSource('http://127.0.0.1/film.mp4'), (made) => {
      made.duration = 7200;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(player.seeks).not.toContain(1200);
    slow.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(player.seeks).toContain(1200);

    const sought = Promise.withResolvers();
    client.progressMemory = makeProgressMemory({lastTime: 1200}, sought.promise);
    const next = await setSource(client, makeSource('http://127.0.0.1/other.mp4'), (made) => {
      made.duration = 7200;
    });
    await vi.advanceTimersByTimeAsync(3000);
    client.currentTime = 60;
    sought.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(next.seeks).not.toContain(1200);
  });

  it('keeps the episode\'s skip of its remembered time for the stream tried after it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient({storeProgress: true, disableLoadProgress: true});
    client.progressMemory = makeProgressMemory({lastTime: 30});
    client.sourcesBrowser = {updateSources: vi.fn()};
    let player = null;
    client.playerLoader.createPlayer = vi.fn(async () => (player = new FakePlayer(client.source)));
    client.sourceRequests++;
    const fallback = makeSource('http://127.0.0.1/ep2-b.mp4');
    await client.setSourceInternal(makeSource('http://127.0.0.1/ep2-a.mp4'), {request: client.sourceRequests, sources: [fallback]});
    await settle();
    expect(client.tryNextSource()).toBe(true);
    await client.sourceChange;
    await settle();
    expect(client.source.url).toBe(fallback.url);
    expect(player.seeks).not.toContain(30);
  });

  it('arms nothing for a rebuild that a source picked meanwhile replaced', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient();
    client.downloadManager.keepStorageOnce = vi.fn();
    client.recoveries = {url: null, times: []};
    const first = await setSource(client, makeSource('http://127.0.0.1/a.mp4'), (made) => {
      made.duration = 7200;
    });
    client.playedSource = client.source;
    first._currentTime = 600;
    client.droppedFrameWatch.userChose('720');
    // A source change still running: the rebuild and the pick wait their turn.
    const held = Promise.withResolvers();
    client.sourceChange = held.promise;
    expect(client.recoverPlayer(first, 'Playback stuck at 600')).toBe(true);
    const picked = client.setSource(makeSource('http://127.0.0.1/b.mp4'));
    held.resolve();
    await picked;
    await settle();
    expect(client.source.url).toBe('http://127.0.0.1/b.mp4');
    expect(client.downloadManager.keepStorageOnce).not.toHaveBeenCalled();
    expect(client.droppedFrameWatch.chosen).toBe(null);
  });

  it('does not build again a source picked anew that fails before its first frame', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient();
    client.recoveries = {url: null, times: []};
    await setSource(client, makeSource('http://127.0.0.1/a.mp4'));
    client.playedSource = client.source;
    await setSource(client, makeSource('http://127.0.0.1/b.mp4'));
    const again = await setSource(client, makeSource('http://127.0.0.1/a.mp4'));
    expect(client.recoverPlayer(again, 'Playback stuck at 0')).toBe(false);
  });
});

describe('FastStreamClient.currentTime, a live stream\'s end', () => {
  it('seeks nowhere for Infinity: the media element throws on it', () => {
    const client = makeClient();
    const player = new FakePlayer(makeSource('https://cdn.test/live.mpd'));
    player.duration = Infinity;
    client.player = player;
    client.currentTime = Infinity;
    expect(player.seeks).toEqual([]);
    client.currentTime = 12;
    expect(player.seeks).toEqual([12]);
  });
});
