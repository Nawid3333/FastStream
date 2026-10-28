import {beforeEach, describe, expect, it, vi} from 'vitest';
import {FakeDocument} from './helpers/fakeDom.mjs';

// The player's drags, on stand-in elements: the volume bar, the subtitles' position and the
// silence-skip threshold line.
// - They started on any mouse button. A right-click's context menu takes the mouseup
//   (the cause of the subtitle syncer bug fixed earlier), and the dragged thing then
//   followed the mouse until the next click.
// - They ended only on a mouseup inside the player. Let go outside it, the next mouse
//   move over the player went on dragging with no button held.
// They now start on the left button only, and end on a mouseup anywhere in the document
// or on a move with no button held, as FineTimeControls' timeline grab does (#183) - and,
// since every press goes by PressTracker (2026-10-28), the moment the window loses the focus
// (a window switch takes the mouseup elsewhere).

const doc = new FakeDocument('<html><body></body></html>');
vi.stubGlobal('document', doc);
vi.stubGlobal('window', {AudioContext: class {}, getComputedStyle: () => ({bottom: '0px'})});

const el = () => doc.body.appendChild(doc.createElement('div'));
const dom = {
  playerContainer: el(), volumeContainer: el(), volumeControlBar: el(), currentVolume: el(),
  muteBtn: el(), currentVolumeText: el(), volumeBanner: el(), volumeBlock: el(), volumeUnity: el(),
  subtitlesContainer: el(), playbackRateBanner: el(),
};
globalThis.__playerDragsDom = dom;

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: globalThis.__playerDragsDom}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({AlertPolyfill: {}}));
vi.mock('../../chrome/player/modules/vtt.mjs', () => ({WebVTT: {}}));
vi.mock('../../chrome/player/ui/subtitles/OpenSubtitlesSearch.mjs', () => ({OpenSubtitlesSearch: class {}, OpenSubtitlesSearchEvents: {}}));
vi.mock('../../chrome/player/ui/subtitles/SubtitlesSettingsManager.mjs', () => ({SubtitlesSettingsManager: class {}, SubtitlesSettingsManagerEvents: {}}));
vi.mock('../../chrome/player/ui/subtitles/SubtitleSyncer.mjs', () => ({SubtitleSyncer: class {}}));

const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
vi.spyOn(Utils, 'setConfig').mockResolvedValue();
const {VolumeControls} = await import('../../chrome/player/ui/VolumeControls.mjs');
const {SubtitlesManager} = await import('../../chrome/player/ui/subtitles/SubtitlesManager.mjs');
const {PlaybackRateChanger} = await import('../../chrome/player/ui/menus/PlaybackRateChanger.mjs');

const player = dom.playerContainer;
// A move over the player with the given buttons held.
const move = (props) => player.fire('mousemove', {buttons: 1, timeStamp: 1, ...props});
// A mouseup the player hears, and one only the document hears (outside the player).
const releaseInside = (props) => player.fire('mouseup', {button: 0, buttons: 0, timeStamp: 2, ...props});
const releaseOutside = (props) => doc.fire('mouseup', {button: 0, buttons: 0, timeStamp: 2, ...props});

beforeEach(() => {
  for (const target of [player, doc, doc.defaultView]) {
    for (const type of Object.keys(target.listeners)) target.listeners[type].length = 0;
  }
  for (const type of Object.keys(doc.captureListeners)) doc.captureListeners[type].length = 0;
});
// The window switched mid-drag: its mouseup goes to the other window.
const switchWindow = () => doc.defaultView.fire('blur');

describe('the volume bar', () => {
  // 300 px wide from x = 110 (the handler takes 10 off): a pixel is 1% of the 300%.
  dom.volumeContainer.rect = {left: 100, top: 0, width: 310, height: 10};
  dom.volumeControlBar.clientWidth = 300;
  const controls = new VolumeControls({});
  const press = (props) => controls.onVolumeBarMouseDown({button: 0, clientX: 160, stopPropagation() {}, ...props});
  beforeEach(() => controls.setVolume(1));

  it('saves the volume once, after its last change, and shows each change at once', () => {
    // The review of 2026-10-14: a wheel turn or a drag wrote it at every step.
    vi.useFakeTimers();
    try {
      Utils.setConfig.mockClear();
      for (const volume of [0.5, 0.6, 0.7]) controls.setVolume(volume);
      expect(controls.volume).toBe(0.7);
      expect(Utils.setConfig).not.toHaveBeenCalled();
      vi.advanceTimersByTime(600);
      expect(Utils.setConfig).toHaveBeenCalledTimes(1);
      expect(JSON.parse(Utils.setConfig.mock.calls[0][1]).volume).toBe(0.7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drags with the left button', () => {
    press();
    move({clientX: 170});
    expect(controls.volume).toBeCloseTo(0.6);
    releaseInside({clientX: 180});
    expect(controls.volume).toBeCloseTo(0.7);
    move({clientX: 300});
    expect(controls.volume).toBeCloseTo(0.7);
  });

  it('does not drag on another button', () => {
    press({button: 2});
    move({clientX: 170, buttons: 2});
    move({clientX: 200, buttons: 0});
    expect(controls.volume).toBe(1);
  });

  it('stops when the button is let go outside the player', () => {
    press();
    move({clientX: 170});
    releaseOutside({clientX: 1000});
    const after = controls.volume;
    move({clientX: 200});
    expect(controls.volume).toBe(after);
  });

  it('stops at a move with no button held, for a mouseup it never heard', () => {
    press();
    move({clientX: 170});
    move({clientX: 200, buttons: 0});
    expect(controls.volume).toBeCloseTo(0.6);
    move({clientX: 250});
    expect(controls.volume).toBeCloseTo(0.6);
  });

  it('stops where it was when the window is switched mid-drag', () => {
    press();
    move({clientX: 170});
    switchWindow();
    move({clientX: 250});
    expect(controls.volume).toBeCloseTo(0.6);
  });
});

describe('a subtitle track while none of its cues shows', () => {
  it('keeps an empty cue empty, for the next time it comes', () => {
    // The container kept its first child as a filler and wrote '|' into it: an empty cue's
    // own element (a tag-only cue), which showed '|' when the cue came again (glm's
    // review, 2026-10-22).
    const container = el();
    const emptyCue = doc.createElement('span');
    const cue = {startTime: 0, endTime: 1, dom: emptyCue};
    const manager = {
      subtitleTrackDisplayElements: [container], activeTracks: [{cues: [cue]}], isTestSubtitleActive: false,
      client: {state: {currentTime: 0.5}}, checkTrackBounds() {},
      settingsManager: {getSettings: () => ({bottomMargin: '40px'})},
    };
    SubtitlesManager.prototype.renderSubtitles.call(manager);
    expect(container.children[0]).toBe(emptyCue);
    manager.client.state.currentTime = 2;
    SubtitlesManager.prototype.renderSubtitles.call(manager);
    expect(emptyCue.textContent).toBe('');
    expect(container.children[0].textContent).toBe('|');
  });
});

describe('the subtitles\' position', () => {
  const manager = {applyStyles() {}, checkTrackBounds: vi.fn()};
  const make = () => {
    const {wrapper} = SubtitlesManager.prototype.createSubtitleDisplayElements.call(manager, 0);
    dom.subtitlesContainer.appendChild(wrapper);
    return wrapper;
  };
  const press = (wrapper, props) => wrapper.fire('mousedown', {button: 0, clientY: 500, ...props});

  it('drags up with the left button, and stops when it is let go outside the player', () => {
    const wrapper = make();
    press(wrapper);
    move({clientY: 450});
    expect(wrapper.style.marginBottom).toBe('55px');
    releaseOutside({clientY: 450});
    move({clientY: 400});
    expect(wrapper.style.marginBottom).toBe('55px');
  });

  it('does not drag on another button', () => {
    const wrapper = make();
    const event = press(wrapper, {button: 2});
    move({clientY: 450, buttons: 2});
    expect(wrapper.style.marginBottom).toBe('5px');
    // As before, the press goes no further than the subtitles.
    expect(event.propagationStopped).toBe(true);
  });

  it('stops at a move with no button held', () => {
    const wrapper = make();
    press(wrapper);
    move({clientY: 450, buttons: 0});
    move({clientY: 400});
    expect(wrapper.style.marginBottom).toBe('5px');
  });

  it('stops where it was when the window is switched mid-drag', () => {
    const wrapper = make();
    press(wrapper);
    move({clientY: 450});
    switchWindow();
    move({clientY: 400});
    expect(wrapper.style.marginBottom).toBe('55px');
  });
});

describe('the silence-skip threshold line', () => {
  const make = () => ({
    silenceThreshold: 0.5,
    updateSilenceSkipper: vi.fn(),
    saveState: vi.fn(),
    client: {interfaceController: {fineTimeControls: {ui: {timelineAudio: {clientHeight: 100}}}}},
  });
  const press = (skipper, props) => {
    const event = {button: 0, clientY: 500, stopPropagation: vi.fn(), preventDefault: vi.fn(), ...props};
    PlaybackRateChanger.prototype.onAudioMouseDown.call(skipper, event);
    return event;
  };

  it('drags with the left button', () => {
    const skipper = make();
    press(skipper);
    move({clientY: 480});
    expect(skipper.silenceThreshold).toBeCloseTo(0.7);
    releaseInside();
    move({clientY: 460});
    expect(skipper.silenceThreshold).toBeCloseTo(0.7);
    // Saved once it is let go: after a reload it was back at the default.
    expect(skipper.saveState).toHaveBeenCalledTimes(1);
  });

  it('does not drag on another button', () => {
    const skipper = make();
    const event = press(skipper, {button: 2});
    move({clientY: 480, buttons: 2});
    expect(skipper.silenceThreshold).toBe(0.5);
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('stops at a move with no button held', () => {
    const skipper = make();
    press(skipper);
    move({clientY: 480, buttons: 0});
    move({clientY: 460});
    expect(skipper.silenceThreshold).toBe(0.5);
  });

  it('stops where it was when the window is switched mid-drag, and is saved', () => {
    const skipper = make();
    press(skipper);
    move({clientY: 480});
    switchWindow();
    move({clientY: 460});
    expect(skipper.silenceThreshold).toBeCloseTo(0.7);
    expect(skipper.saveState).toHaveBeenCalledTimes(1);
  });
});

describe('the speed menu', () => {
  it('saves the speed once, after its last change, as the volume is saved', () => {
    // The review of 2026-10-21: an arrow key held on the speed button wrote it at every repeat.
    vi.useFakeTimers();
    try {
      const changer = new PlaybackRateChanger({options: {maxPlaybackRate: 8}});
      changer.playbackElements = Array.from({length: 80}, () => el());
      changer.speedList = el();
      Utils.setConfig.mockClear();
      for (let i = 0; i < 5; i++) changer.shiftPlaybackRate(0.1);
      expect(changer.playbackRate).toBeCloseTo(1.5);
      expect(Utils.setConfig).not.toHaveBeenCalled();
      vi.advanceTimersByTime(600);
      expect(Utils.setConfig).toHaveBeenCalledTimes(1);
      expect(JSON.parse(Utils.setConfig.mock.calls[0][1]).playbackRate).toBeCloseTo(1.5);
    } finally {
      vi.useRealTimers();
    }
  });
});
