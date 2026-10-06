import {beforeEach, describe, expect, it, vi} from 'vitest';
import {FakeDocument} from './helpers/fakeDom.mjs';

// The player's drags, on stand-in elements: the volume bar, an audio knob, the subtitles'
// position and the silence-skip threshold line.
// - They started on any mouse button. A right-click's context menu takes the mouseup
//   (the cause of the subtitle syncer bug fixed earlier), and the dragged thing then
//   followed the mouse until the next click.
// - They ended only on a mouseup inside the player. Let go outside it, the next mouse
//   move over the player went on dragging with no button held.
// They now start on the left button only, and end on a mouseup anywhere in the document
// or on a move with no button held, as FineTimeControls' timeline grab does (#183).
// Also the knob (#296): wheel up turns the value up wherever the pointer is, and the knob
// is a slider for the keyboard and screen readers.

const doc = new FakeDocument('<html><body></body></html>');
vi.stubGlobal('document', doc);
vi.stubGlobal('window', {AudioContext: class {}, getComputedStyle: () => ({bottom: '0px'})});

const el = () => doc.body.appendChild(doc.createElement('div'));
const dom = {
  playerContainer: el(), volumeContainer: el(), volumeControlBar: el(), currentVolume: el(),
  muteBtn: el(), currentVolumeText: el(), volumeBanner: el(), volumeBlock: el(), volumeUnity: el(),
  subtitlesContainer: el(),
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
const {createKnob} = await import('../../chrome/player/ui/components/Knob.mjs');
const {SubtitlesManager} = await import('../../chrome/player/ui/subtitles/SubtitlesManager.mjs');
const {PlaybackRateChanger} = await import('../../chrome/player/ui/menus/PlaybackRateChanger.mjs');

const player = dom.playerContainer;
// A move over the player with the given buttons held.
const move = (props) => player.fire('mousemove', {buttons: 1, timeStamp: 1, ...props});
// A mouseup the player hears, and one only the document hears (outside the player).
const releaseInside = (props) => player.fire('mouseup', {button: 0, buttons: 0, timeStamp: 2, ...props});
const releaseOutside = (props) => doc.fire('mouseup', {button: 0, buttons: 0, timeStamp: 2, ...props});

beforeEach(() => {
  for (const target of [player, doc]) {
    for (const type of Object.keys(target.listeners)) target.listeners[type].length = 0;
  }
});

describe('the volume bar', () => {
  // 300 px wide from x = 110 (the handler takes 10 off): a pixel is 1% of the 300%.
  dom.volumeContainer.rect = {left: 100, top: 0, width: 310, height: 10};
  dom.volumeControlBar.clientWidth = 300;
  const controls = new VolumeControls({});
  const press = (props) => controls.onVolumeBarMouseDown({button: 0, clientX: 160, stopPropagation() {}, ...props});
  beforeEach(() => controls.setVolume(1));

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
});

describe('an audio knob', () => {
  // A 0-100 knob, laid out at (600, 300) on the page: 40 px from the left of its strip.
  const make = () => {
    const callback = vi.fn();
    const knob = createKnob('Gain', 0, 100, callback, 'dB');
    const turnable = knob.container.querySelector('.knob_knob_container');
    turnable.rect = {left: 600, top: 300, width: 50, height: 50};
    turnable.offsetLeft = 40;
    turnable.offsetTop = 25;
    knob.knob.val(50);
    return {knob, turnable, callback};
  };
  // A drag from the top of the knob round to its right side: a quarter turn.
  const top = {pageX: 625, pageY: 280};
  const right = {pageX: 645, pageY: 325};
  const press = (turnable, props) => turnable.fire('mousedown', {button: 0, timeStamp: 0, ...top, ...props});

  it('turns with the left button, and stops when it is let go outside the player', () => {
    const {knob, turnable} = make();
    press(turnable);
    move(right);
    const turned = knob.knob.val();
    expect(turned).not.toBe(50);
    releaseOutside(right);
    move(top);
    expect(knob.knob.val()).toBe(turned);
  });

  it('does not turn on another button', () => {
    const {knob, turnable} = make();
    press(turnable, {button: 2});
    move({...right, buttons: 2});
    expect(knob.knob.val()).toBe(50);
  });

  it('stops at a move with no button held', () => {
    const {knob, turnable} = make();
    press(turnable);
    move({...right, buttons: 0});
    move(right);
    expect(knob.knob.val()).toBe(50);
  });

  it('turns the value up for wheel up, wherever the pointer is on it', () => {
    for (const pageX of [610, 640]) {
      const {knob, turnable} = make();
      // As Firefox fires them: deltaY negative for wheel up (the knob reads it), and the
      // old wheelDelta the other way round.
      const event = {deltaY: -3, wheelDelta: 120, timeStamp: 0, pageX, pageY: 320, preventDefault() {}};
      turnable.fire('wheel', event);
      expect(knob.knob.val(), `wheel up at x = ${pageX}`).toBeGreaterThan(50);
      turnable.fire('wheel', {...event, deltaY: 3, wheelDelta: -120});
      turnable.fire('wheel', {...event, deltaY: 3, wheelDelta: -120});
      expect(knob.knob.val(), `wheel down at x = ${pageX}`).toBeLessThan(50);
    }
  });

  it('is a slider a screen reader can read', () => {
    const {knob, turnable} = make();
    expect(turnable.tabIndex).toBe(0);
    expect(turnable.role).toBe('slider');
    expect(turnable.ariaLabel).toBe('Gain');
    expect(turnable.getAttribute('aria-valuemin')).toBe('0');
    expect(turnable.getAttribute('aria-valuemax')).toBe('100');
    expect(turnable.getAttribute('aria-valuenow')).toBe('50');
    expect(turnable.getAttribute('aria-valuetext')).toBe('50.0 dB');
    knob.knob.val(12.5);
    expect(turnable.getAttribute('aria-valuenow')).toBe('12.5');
  });

  it('turns with the slider keys, and keeps them from the player', () => {
    const {knob, turnable} = make();
    const key = (name) => turnable.fire('keydown', {key: name});
    let event = key('ArrowUp');
    expect(knob.knob.val()).toBe(52.5);
    expect(event.defaultPrevented && event.propagationStopped).toBe(true);
    key('ArrowLeft');
    key('ArrowDown');
    expect(knob.knob.val()).toBe(47.5);
    key('PageUp');
    expect(knob.knob.val()).toBe(72.5);
    key('End');
    expect(knob.knob.val()).toBe(100);
    key('ArrowUp');
    expect(knob.knob.val()).toBe(100);
    key('Home');
    expect(knob.knob.val()).toBe(0);
    event = key('KeyM');
    expect(event.propagationStopped).toBe(false);
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
});

describe('the silence-skip threshold line', () => {
  const make = () => ({
    silenceThreshold: 0.5,
    updateSilenceSkipper: vi.fn(),
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
});
