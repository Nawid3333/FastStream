import fs from 'node:fs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {VisChangeActions} from '../../chrome/player/options/defaults/VisChangeActions.mjs';
import {methodsOf, withMethods} from './helpers/classMethods.mjs';

// InterfaceController and ProgressBar query the page as they load: their methods are run from
// their source against stand-ins.
const IC = new URL('../../chrome/player/ui/InterfaceController.mjs', import.meta.url);
const PB = new URL('../../chrome/player/ui/ProgressBar.mjs', import.meta.url);
const Localize = {getMessage: (key) => key};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('InterfaceController.updateDownloadStatus', () => {
  it('says all is buffered again after a pause, not "paused" for good', () => {
    const manager = {paused: false, getSpeed: () => 0, runningCount: () => 0};
    const status = vi.fn();
    const self = withMethods({
      client: {downloadManager: manager},
      progressBar: {getFragmentCounts: () => ({loaded: 10, total: 10, failed: 0})},
      setStatusMessage: status, shownDownloadComplete: false, lastSpeed: 0,
    }, methodsOf(IC, ['updateDownloadStatus'], {Localize, downloadStatusText: () => '', DOMElements: {resetFailed: {style: {}}}}));
    self.updateDownloadStatus();
    manager.paused = true;
    self.updateDownloadStatus();
    manager.paused = false;
    self.updateDownloadStatus();
    expect(status.mock.calls.at(-1)[1]).toBe('player_fragment_allbuffered');
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
  const self = withMethods({client, state: {fullscreen: false}, isInPip: () => false, hidden: false},
      methodsOf(IC, ['handleVisibilityChange', 'toggleHide'], {VisChangeActions, DOMElements: {playerContainer: {classList: {add() {}, remove() {}}}}}));
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

describe('InterfaceController, picture-in-picture and fullscreen refused', () => {
  it('says so on the console: no caller (a click, a key) hears a rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused = new Error('refused');
    const pip = withMethods({isInPip: () => false, enterPip: () => Promise.reject(refused), exitPip: () => Promise.resolve()},
        methodsOf(IC, ['pipToggle']));
    await expect(pip.pipToggle()).resolves.toBeUndefined();
    const thrower = withMethods({isInPip: () => false, enterPip: () => {
      throw refused;
    }}, methodsOf(IC, ['pipToggle']));
    await expect(thrower.pipToggle()).resolves.toBeUndefined();

    vi.stubGlobal('document', {fullscreenEnabled: false});
    vi.stubGlobal('chrome', {runtime: {sendMessage: (message, answer) => answer('error')}});
    const fullscreen = withMethods({state: {carriedFullscreen: false}, setFullscreenStatus() {}},
        methodsOf(IC, ['fullscreenToggle', 'toggleFullscreenNow?'], {EnvUtils: {isExtension: () => true}, MessageTypes: {}}));
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
    const self = withMethods({client: {player: {getVideo: () => video}}, state: {playing: true},
      fineTimeControls: {started: false}, boundProgressLoop() {}}, methodsOf(IC, ['scheduleProgressFrame']));
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
    const element = {style: {}, classList: {add() {}, remove() {}}, clientWidth: 100};
    const DOMElements = {progressContainer: element, seekPreviewVideo: element, seekPreviewText: element,
      seekPreview: element, seekPreviewTip: element};
    const methods = methodsOf(PB, ['onProgressbarMouseMove', 'onProgressbarMouseDown', 'onProgressbarMouseEnter', 'hasEnd'],
        {DOMElements, WebUtils: {getOffsetLeft: () => 0}, StringUtils: {formatTime: String}});
    const bar = withMethods({client: {duration: Infinity, seekPreview, state: {playing: true}, player: {pause}},
      isSeeking: false, showPreview}, methods);
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
      const PRC = new URL('../../chrome/player/ui/menus/PlaybackRateChanger.mjs', import.meta.url);
      const analyzer = {addVolumeDependent() {}, addBackgroundDependent() {}, removeVolumeDependent() {}, removeBackgroundDependent() {}};
      const self = withMethods({
        client: {player: {}, playbackRate: 1, currentTime: 0, audioAnalyzer: analyzer},
        silenceSkipperActive: false, silenceSkipperLoopRunning: false, playbackRate: 1, regularSpeed: 1, silenceSkipSpeed: 2,
        shouldSkipSilence: () => false, openSilenceSkipperUI() {}, closeSilenceSkipperUI() {},
      }, methodsOf(PRC, ['silenceSkipperLoop', 'reset', 'enableSilenceSkipper', 'disableSilenceSkipper']));
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
    const scope = {
      AlertPolyfill: {toast: vi.fn()}, Localize,
      RequestUtils: {requestSimple: (request, callback) => {
        answer = callback;
      }},
      SubtitleTrack: class {
        loadText() {}
        checkHasCues() {}
      },
      SubtitleUtils: {decodeSubtitleBytes: () => ''},
    };
    const SM = new URL('../../chrome/player/ui/subtitles/SubtitlesManager.mjs', import.meta.url);
    const manager = withMethods({openSubtitlesSearch: {downloadGeneration: 0}, addTrack: vi.fn((track) => track),
      activateTrack: vi.fn()}, methodsOf(SM, ['addTrackFromUrl'], scope));
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
