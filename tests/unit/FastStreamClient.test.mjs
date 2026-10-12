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
const {DISK_ONLY_ROOM_BYTES} = await import('../../chrome/player/network/MemoryBudget.mjs');
const {MessageTypes} = await import('../../chrome/player/enums/MessageTypes.mjs');
const {Fragment} = await import('../../chrome/player/players/Fragment.mjs');
const {LevelManager} = await import('../../chrome/player/players/LevelManager.mjs');

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
    // Of the source it is called on, as VideoSource.copy(): a copy whose URL was changed
    // (recoverPlayer's time) is copied with that URL.
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

    // Turned on in the middle of the video: too big for the 10 MB, as a predownload that ran
    // out of room - warned once, and downloading only the buffer window.
    client.options.downloadAll = true;
    client.updateHasDownloadSpace();
    client.updateHasDownloadSpace();
    expect(client.interfaceController.setStatusMessage).toHaveBeenCalledTimes(1);
    expect(client.hasDownloadSpace).toBe(false);
    expect(client.shouldDownloadAll()).toBeFalsy();
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

describe('FastStreamClient, a source that comes with its own time', () => {
  // Autoplay, and the resume of a player built again after an error, played the new player
  // from 0 at once; its time came once the remembered-time lookup and the wait for the
  // player were done, a second or more later. A film built again an hour in played its
  // opening, then jumped back (kinoger, 2026-10-12).

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

// A limit of 0 is none, and an empty field (-1) no limit: 0 read as no limit (or as a
// trickle) surprised the user who typed it to turn a thing off (2026-10-09).
// "Keep video on disk" off (2026-10-10), as in a private window: nothing of the buffer goes
// to disk, so what is kept has to fit in the RAM budget, below where it starts letting go
// (MemoryBudget.LOW). Kept beyond it, the budget let go of the far end and the downloads
// ahead fetched it again, round and round. Every budget has to work with it: his words.
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
    client.downloadManager = {yielding: false, memoryFull: false, getSpeed: () => speed,
      canGetFile: () => true, activeCount: () => 0};
    client.player = {downloadFragment: vi.fn(() => Promise.resolve())};
    client.predownloadFragments();
    waiting = [];
    return client.player.downloadFragment.mock.calls.length;
  }

  it('downloads nothing ahead at a speed limit of 0, also while nothing downloads', () => {
    // Held back only while something downloaded, a limit of 0 still read ahead in bursts.
    expect(predownloadOnce({maxSpeed: 0, speed: 0})).toBe(0);
    expect(predownloadOnce({maxSpeed: 0, speed: 5e5})).toBe(0);
  });

  it('downloads ahead with no speed limit, and under a limit it has not reached', () => {
    expect(predownloadOnce({maxSpeed: -1, speed: 1e9})).toBe(1);
    expect(predownloadOnce({maxSpeed: 125000, speed: 1000})).toBe(1);
    expect(predownloadOnce({maxSpeed: 125000, speed: 200000})).toBe(0);
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
    // 0 was read as nothing ahead: no download ahead at all, the disk unused. Downloads ahead
    // go on while what is on its way to disk stays small.
    expect(ramFull(0, 0)).toBe(false);
    expect(ramFull(0, 10e6)).toBe(false);
    expect(ramFull(0, DISK_ONLY_ROOM_BYTES)).toBe(true);
    // A private window keeps nothing on disk: nothing ahead there.
    expect(ramFull(0, 0, false)).toBe(true);
    expect(ramFull(0, 1e6, false)).toBe(true);
    // 0 and the empty field were both read as the 2 GB default.
    expect(ramFull(-1, 50e9)).toBe(false);
    // A budget the options never set is the default, 2 GB.
    expect(ramFull(undefined, 1e9)).toBe(false);
    expect(ramFull(undefined, 3e9)).toBe(true);
    expect(ramFull(1e9, 3e9)).toBe(true);
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
    // Only the buffer: watch progress and saving keep their storage (2026-10-10).
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

  // An empty field is no limit (-1): read as -1 seconds, nothing was kept, and "only -1 s
  // buffered" made no sense. 0 is none.
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
  // kinoger's fsst hoster: one MP4 per quality (page-qualities.js lists them). The quality
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
    // Taking faststream-timestamp off a URL writes its query anew: "a b" came back "a+b", and
    // the file played matched no entry any more - the menu fell back to the player's level.
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

    expect(client.source.url).not.toBe(qualities[0].url);
    expect(client.getMenuVideoLevelID()).toBe('page-quality:0');
    expect(client.getMenuVideoLevels().size).toBe(2);
  });
});
