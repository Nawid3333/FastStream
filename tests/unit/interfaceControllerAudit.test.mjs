import fs from 'node:fs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// These modules build the player's page as they load: its elements, a document and a window
// are stand-ins, and Coloris (which needs a real DOM) is left out. Each test calls the real
// methods with a `this` of its own.
const {element} = vi.hoisted(() => ({
  element: () => ({style: {}, classList: {add() {}, remove() {}, toggle() {}, contains: () => false}, dataset: {},
    addEventListener() {}, appendChild() {}, setAttribute() {}, getAttribute: () => null, querySelector: () => null,
    querySelectorAll: () => [], getElementsByClassName: () => [], getBoundingClientRect: () => ({}),
    getContext: () => ({measureText: () => ({width: 0})}), children: []}),
}));
vi.mock('../../chrome/player/modules/coloris.mjs', () => ({Coloris: Object.assign(() => {}, {init() {}, close() {}, wrap() {}})}));
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({
  DOMElements: new Proxy({}, {get: (elements, name) => (elements[name] ??= element())}),
}));

vi.stubGlobal('document', {createElement: () => element(), addEventListener() {}, documentElement: element(), body: element(),
  querySelector: () => null, getElementById: () => element()});
vi.stubGlobal('window', {addEventListener() {}, matchMedia: () => ({matches: false, addEventListener() {}}), location: {href: ''}});

const {InterfaceController} = await import('../../chrome/player/ui/InterfaceController.mjs');
const {ProgressBar} = await import('../../chrome/player/ui/ProgressBar.mjs');
const {PlaybackRateChanger} = await import('../../chrome/player/ui/menus/PlaybackRateChanger.mjs');
const {SubtitlesManager} = await import('../../chrome/player/ui/subtitles/SubtitlesManager.mjs');
const {DOMElements} = await import('../../chrome/player/ui/DOMElements.mjs');
const {VisChangeActions} = await import('../../chrome/player/options/defaults/VisChangeActions.mjs');
const {Localize} = await import('../../chrome/player/modules/Localize.mjs');
const {EnvUtils} = await import('../../chrome/player/utils/EnvUtils.mjs');
const {WebUtils} = await import('../../chrome/player/utils/WebUtils.mjs');
const {RequestUtils} = await import('../../chrome/player/utils/RequestUtils.mjs');
const {SubtitleUtils} = await import('../../chrome/player/utils/SubtitleUtils.mjs');
const {AlertPolyfill} = await import('../../chrome/player/utils/AlertPolyfill.mjs');
const {SubtitleTrack} = await import('../../chrome/player/SubtitleTrack.mjs');
const {OptionsStore} = await import('../../chrome/player/options/OptionsStore.mjs');
const {WebStorage} = await import('../../chrome/player/utils/WebStorage.mjs');
vi.unstubAllGlobals();

/**
 * A stand-in `this` with a class's real methods bound to it.
 * @param {Function} Class
 * @param {string[]} names
 * @param {Object} self
 * @return {Object}
 */
function withMethods(Class, names, self) {
  for (const name of names) self[name] = Class.prototype[name].bind(self);
  return self;
}

beforeEach(() => {
  vi.spyOn(Localize, 'getMessage').mockImplementation((key) => key);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('InterfaceController.reset', () => {
  it('takes the last video\'s notices down: "Resumed at 0:30" stayed over a next video that starts at 0', () => {
    DOMElements.videoContainer.replaceChildren = () => {};
    const noop = () => {};
    const self = withMethods(InterfaceController, ['reset'], {
      setStatusMessage: vi.fn(), resetPreviewVideo: noop, progressBar: {reset: noop}, saveManager: {reset: noop},
      stopProgressLoop: noop, state: {}, updatePlayPauseButton: noop, showControlBar: noop, updateToolVisibility: noop,
      fineTimeControls: {reset: noop}, playbackRateChanger: {reset: noop}, loopControls: {reset: noop}, timeUpdated: noop,
    });
    self.reset();
    const cleared = self.setStatusMessage.mock.calls.filter((call) => call[1] === null).map((call) => call[0]);
    expect(cleared).toEqual(expect.arrayContaining(['resumed', 'wait', 'subtitles-hint']));
  });
});

describe('InterfaceController.updateDownloadStatus', () => {
  it('says all is buffered again after a pause, not "paused" for good', () => {
    const manager = {paused: false, getSpeed: () => 0, runningCount: () => 0};
    const status = vi.fn();
    const self = withMethods(InterfaceController, ['updateDownloadStatus'], {
      client: {downloadManager: manager},
      progressBar: {getFragmentCounts: () => ({loaded: 10, total: 10, failed: 0})},
      setStatusMessage: status, shownDownloadComplete: false, lastSpeed: 0,
    });
    self.updateDownloadStatus();
    manager.paused = true;
    self.updateDownloadStatus();
    manager.paused = false;
    self.updateDownloadStatus();
    expect(status.mock.calls.at(-1)[1]).toBe('player_fragment_allbuffered');
  });

  it('names the key that resumes a pause: the playback requests wait too, and the video stops', () => {
    Localize.getMessage.mockImplementation((key, subs) => (subs ? key + ':' + subs.join('|') : key));
    const status = vi.fn();
    const keybindMap = new Map([['PauseDownloaders', 'BracketLeft']]);
    const self = withMethods(InterfaceController, ['updateDownloadStatus'], {
      client: {downloadManager: {paused: true}, keybindManager: {keybindMap}},
      setStatusMessage: status, shownDownloadComplete: false,
    });
    self.updateDownloadStatus();
    expect(status).toHaveBeenLastCalledWith('download', 'player_download_paused_key:[', 'warning');
    // No key for it (paused another way): the old words.
    keybindMap.set('PauseDownloaders', 'None');
    self.updateDownloadStatus();
    expect(status).toHaveBeenLastCalledWith('download', 'player_download_paused', 'warning');
  });
});

/**
 * A controller whose player's play and pause answer when the test says.
 * @return {Object}
 */
function visibilityController() {
  const pending = [];
  const answer = () => {
    const step = Promise.withResolvers();
    pending.push(step);
    return step.promise;
  };
  const player = {play: vi.fn(answer), pause: vi.fn(answer)};
  const client = {needsUserInteraction: () => false, options: {visChangeAction: VisChangeActions.PLAY_PAUSE},
    state: {playing: true}, player};
  const self = withMethods(InterfaceController, ['handleVisibilityChange', 'toggleHide'],
      {client, state: {fullscreen: false}, isInPip: () => false, hidden: false});
  return {self, player, client, pending};
}

describe('InterfaceController.handleVisibilityChange', () => {
  it('acts on a change that comes while the last one\'s play or pause is answered', async () => {
    // Shown again while the pause was answered, then hidden: the hide was taken for the
    // visibility it already had, and the video played on in the hidden tab.
    const {self, player, pending} = visibilityController();
    const hidden = self.handleVisibilityChange(false);
    const shown = self.handleVisibilityChange(true);
    pending[1].resolve();
    await shown;
    pending[0].resolve();
    await hidden;
    self.client.state.playing = true;
    self.handleVisibilityChange(false);
    expect(player.pause).toHaveBeenCalledTimes(2);
  });
});

describe('InterfaceController.toggleHide', () => {
  it('plays again when shown, whatever the tab\'s visibility did meanwhile', async () => {
    const {self, player, client, pending} = visibilityController();
    self.toggleHide();
    client.state.playing = false;
    self.handleVisibilityChange(false);
    pending.at(-1).resolve();
    await Promise.resolve();
    self.handleVisibilityChange(true);
    self.toggleHide();
    expect(player.play).toHaveBeenCalledTimes(1);
  });
});

// The options page has no autoplay checkbox: the player's switch is where it is set.
describe('InterfaceController, the autoplay switch', () => {
  it('saves its choice for every tab, and the countdown\'s stop holds for this tab only', async () => {
    const saved = vi.spyOn(OptionsStore, 'set').mockResolvedValue();
    const session = new Map();
    vi.spyOn(WebStorage, 'set').mockImplementation((area, key, value) => session.set(`${area}:${key}`, value));
    vi.spyOn(WebStorage, 'remove').mockImplementation((area, key) => session.delete(`${area}:${key}`));
    const self = withMethods(InterfaceController, ['toggleAutoplayNext', 'stopAutoplayInTab'], {
      client: {options: {autoplayNext: false}}, updateAutoNextIndicator: vi.fn(),
    });

    await self.toggleAutoplayNext();
    expect(self.client.options.autoplayNext).toBe(true);
    expect(saved).toHaveBeenLastCalledWith('autoplayNext', true);
    expect([...session.keys()]).toEqual([]);

    self.stopAutoplayInTab();
    expect(self.client.options.autoplayNext).toBe(false);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(session.get('session:autoplayNext')).toBe('false');

    // Switched on again in this tab: saved, and the tab's own value is gone.
    await self.toggleAutoplayNext();
    expect(saved).toHaveBeenLastCalledWith('autoplayNext', true);
    expect([...session.keys()]).toEqual([]);
    expect(self.updateAutoNextIndicator).toHaveBeenCalledTimes(3);
  });
});

describe('InterfaceController, picture-in-picture and fullscreen refused', () => {
  it('says so on the console: no caller (a click, a key) hears a rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused = new Error('refused');
    const pip = withMethods(InterfaceController, ['pipToggle'],
        {isInPip: () => false, enterPip: () => Promise.reject(refused), exitPip: () => Promise.resolve()});
    await expect(pip.pipToggle()).resolves.toBeUndefined();
    const thrower = withMethods(InterfaceController, ['pipToggle'], {isInPip: () => false, enterPip: () => {
      throw refused;
    }});
    await expect(thrower.pipToggle()).resolves.toBeUndefined();

    vi.spyOn(EnvUtils, 'isExtension').mockReturnValue(true);
    vi.stubGlobal('document', {fullscreenEnabled: false});
    vi.stubGlobal('chrome', {runtime: {sendMessage: (message, answer) => answer('error')}});
    const fullscreen = withMethods(InterfaceController, ['fullscreenToggle', 'toggleFullscreenNow'],
        {state: {carriedFullscreen: false}, setFullscreenStatus() {}});
    await expect(fullscreen.fullscreenToggle()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe('InterfaceController.scheduleProgressFrame', () => {
  it('waits for a screen frame, not a video frame, for audio alone', () => {
    // No video frame ever comes: the per-frame loop stopped after its first round.
    const raf = vi.fn();
    vi.stubGlobal('window', {requestAnimationFrame: raf});
    const video = {videoWidth: 0, requestVideoFrameCallback: vi.fn()};
    const self = withMethods(InterfaceController, ['scheduleProgressFrame'], {client: {player: {getVideo: () => video}},
      state: {playing: true}, fineTimeControls: {started: false}, boundProgressLoop() {}});
    self.scheduleProgressFrame();
    expect(video.requestVideoFrameCallback).not.toHaveBeenCalled();
    expect(raf).toHaveBeenCalledTimes(1);
  });
});

describe('ProgressBar, a live stream with no end', () => {
  it('previews, drags and shows no time on it', () => {
    const seekPreview = vi.fn();
    const showPreview = vi.fn();
    const pause = vi.fn();
    DOMElements.progressContainer.clientWidth = 100;
    vi.spyOn(WebUtils, 'getOffsetLeft').mockReturnValue(0);
    const bar = withMethods(ProgressBar, ['onProgressbarMouseMove', 'onProgressbarMouseDown', 'onProgressbarMouseEnter', 'hasEnd'],
        {client: {duration: Infinity, seekPreview, state: {playing: true}, player: {pause}}, isSeeking: false, showPreview});
    bar.onProgressbarMouseMove({clientX: 50});
    bar.onProgressbarMouseDown({button: 0, clientX: 50});
    bar.onProgressbarMouseEnter();
    expect(seekPreview).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(bar.isSeeking).toBe(false);
    expect(showPreview).not.toHaveBeenCalled();

    bar.client.duration = 100;
    bar.onProgressbarMouseMove({clientX: 50});
    bar.onProgressbarMouseEnter();
    expect(seekPreview).toHaveBeenCalledWith(50);
    expect(showPreview).toHaveBeenCalledTimes(1);
  });
});

describe('PlaybackRateChanger, the silence skipper on the next video', () => {
  it('runs one loop when turned on again before the last round came', () => {
    // reset() let the loop's flag go while its next round waited: a second loop started,
    // and both ran on.
    vi.useFakeTimers();
    try {
      const analyzer = {addVolumeDependent() {}, addBackgroundDependent() {}, removeVolumeDependent() {}, removeBackgroundDependent() {}};
      const self = withMethods(PlaybackRateChanger, ['silenceSkipperLoop', 'reset', 'enableSilenceSkipper', 'disableSilenceSkipper'], {
        client: {player: {}, playbackRate: 1, currentTime: 0, audioAnalyzer: analyzer},
        silenceSkipperActive: false, silenceSkipperLoopRunning: false, playbackRate: 1, regularSpeed: 1, silenceSkipSpeed: 2,
        shouldSkipSilence: () => false, openSilenceSkipperUI() {}, closeSilenceSkipperUI() {},
      });
      let rounds = 0;
      const loop = self.silenceSkipperLoop;
      self.silenceSkipperLoop = () => {
        rounds++;
        loop();
      };
      self.silenceSkipperLoopHandle = () => self.silenceSkipperLoop();
      self.enableSilenceSkipper();
      vi.advanceTimersByTime(50);
      self.reset();
      self.enableSilenceSkipper();
      rounds = 0;
      vi.advanceTimersByTime(1000);
      expect(rounds).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SubtitlesManager.addTrackFromUrl', () => {
  it('gives the track to the video it was asked for, not to the next one', () => {
    let answer;
    vi.spyOn(AlertPolyfill, 'toast').mockImplementation(() => {});
    vi.spyOn(RequestUtils, 'requestSimple').mockImplementation((request, callback) => {
      answer = callback;
    });
    vi.spyOn(SubtitleUtils, 'decodeSubtitleBytes').mockReturnValue('');
    vi.spyOn(SubtitleTrack.prototype, 'loadText').mockImplementation(() => {});
    vi.spyOn(SubtitleTrack.prototype, 'checkHasCues').mockImplementation(() => {});
    const manager = withMethods(SubtitlesManager, ['addTrackFromUrl'],
        {openSubtitlesSearch: {downloadGeneration: 0}, addTrack: vi.fn((track) => track), activateTrack: vi.fn()});
    manager.addTrackFromUrl('https://subs.test/a.srt');
    // The next video came: clearTracks drops what is on its way.
    manager.openSubtitlesSearch.downloadGeneration++;
    answer(undefined, {getResponseHeader: () => null}, new ArrayBuffer(1));
    expect(manager.addTrack).not.toHaveBeenCalled();
    manager.addTrackFromUrl('https://subs.test/b.srt');
    answer(undefined, {getResponseHeader: () => null}, new ArrayBuffer(1));
    expect(manager.addTrack).toHaveBeenCalledTimes(1);
  });
});

describe('SubtitleSyncer, a cue edited by a double click', () => {
  it('is changed in the track it was on, whatever track the tool has when the prompt answers', () => {
    const source = fs.readFileSync(new URL('../../chrome/player/ui/subtitles/SubtitleSyncer.mjs', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf('    // double click to edit'), source.indexOf('    const clearGrabbing'));
    expect(handler).toContain('const track = this.trackToSync;');
    expect(handler.split('this.trackToSync').length - 1).toBe(1);
  });
});
