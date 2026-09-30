import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Dragging on the fine-time timeline (precise mode, the subtitle syncer), on stand-in
// elements:
// - A timeline grab ended only on a mouseup inside the player: released outside it, the
//   next mouse move went on seeking with no button held.
// - Switching the synced track off during a cue drag made the drag's end throw before
//   it reset its flags, and every later mouse move threw too.
// - A cue's right edge dragged left past its start made it end before it began.

const {el, fire, playerContainer, doc} = vi.hoisted(() => {
  const el = () => {
    const listeners = {};
    return {
      listeners,
      style: {},
      classList: {add() {}, remove() {}},
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      removeEventListener() {},
      appendChild() {},
      replaceChildren() {},
      remove() {},
      getBoundingClientRect: () => ({left: 0, right: 10, top: 0, bottom: 8, width: 10, height: 8}),
      clientWidth: 100,
      getContext: () => ({}),
    };
  };
  const fire = (target, type, event = {}) => {
    for (const fn of (target.listeners[type] || []).slice()) {
      fn({button: 0, buttons: 1, clientX: 0, ...event});
    }
  };
  const doc = el();
  doc.createElement = () => el();
  return {el, fire, playerContainer: el(), doc};
});

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {playerContainer, timelineSyncer: el()}}));
vi.mock('../../chrome/player/utils/WebUtils.mjs', () => ({WebUtils: {create: () => el()}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/modules/vtt.mjs', () => ({WebVTT: {}}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({AlertPolyfill: {}}));
vi.mock('../../chrome/player/utils/Utils.mjs', () => ({Utils: {clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v))}}));
vi.mock('../../chrome/player/utils/StringUtils.mjs', () => ({StringUtils: {formatTime: String}}));

vi.stubGlobal('document', doc);
const {FineTimeControls} = await import('../../chrome/player/ui/FineTimeControls.mjs');
const {SubtitleSyncer} = await import('../../chrome/player/ui/subtitles/SubtitleSyncer.mjs');

afterEach(() => {
  for (const target of [playerContainer, doc]) {
    for (const type of Object.keys(target.listeners)) delete target.listeners[type];
  }
});

describe('FineTimeControls: grabbing the timeline', () => {
  /**
   * A timeline on a 100 s video that is playing, 100 px wide: a pixel is a second.
   * @return {{timeline: FineTimeControls, client: Object}}
   */
  function playing() {
    const video = {currentTime: 50, duration: 100};
    const client = {
      player: {getVideo: () => video, pause: vi.fn(), play: vi.fn()},
      state: {playing: true},
      updateTime: vi.fn(),
    };
    return {timeline: new FineTimeControls(client), client};
  }

  it('ends a grab released outside the player, and plays on', () => {
    const {timeline, client} = playing();
    fire(timeline.ui.timelineTicks, 'mousedown', {clientX: 50});
    expect(timeline.isSeeking).toBe(true);
    fire(playerContainer, 'mousemove', {clientX: 60});
    expect(client.currentTime).toBe(40);

    // Released outside the player: only the document hears it.
    fire(doc, 'mouseup', {clientX: 70});
    expect(timeline.isSeeking).toBe(false);
    expect(client.currentTime).toBe(30);
    expect(client.player.play).toHaveBeenCalledTimes(1);

    fire(playerContainer, 'mousemove', {clientX: 90});
    expect(client.currentTime).toBe(30);
  });

  it('ends a grab when a move comes with no button held (a mouseup that never came)', () => {
    const {timeline, client} = playing();
    fire(timeline.ui.timelineTicks, 'mousedown', {clientX: 50});
    fire(playerContainer, 'mousemove', {clientX: 60});
    fire(playerContainer, 'mousemove', {clientX: 80, buttons: 0});
    expect(timeline.isSeeking).toBe(false);
    expect(client.currentTime).toBe(40);
    expect(client.player.play).toHaveBeenCalledTimes(1);
  });

  it('ends a grab whose player went away meanwhile', () => {
    const {timeline, client} = playing();
    fire(timeline.ui.timelineTicks, 'mousedown', {clientX: 50});
    client.player = null;
    fire(doc, 'mouseup', {clientX: 70});
    expect(timeline.isSeeking).toBe(false);
  });
});

describe('SubtitleSyncer: dragging a cue', () => {
  let fineTimeControls;

  beforeEach(() => {
    vi.stubGlobal('window', {subEditMode: true});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('document', doc);
  });

  /**
   * A syncer with one cue from 10 s to 12 s on a 100 s video, 100 px wide, grabbed at x.
   * The cue's element spans 0-10 px, so x 8 is its right edge, x 2 its body.
   * @param {number} x
   * @return {{syncer: SubtitleSyncer, cue: Object, track: Object}}
   */
  function grabbed(x) {
    const video = {duration: 100};
    fineTimeControls = {
      isStateActive: () => true, prioritizeState: vi.fn(), pushState: vi.fn(), removeState: vi.fn(),
    };
    const client = {
      player: {getVideo: () => video},
      currentVideo: video,
      interfaceController: {fineTimeControls, subtitlesManager: {renderSubtitles: vi.fn()}, setStatusMessage: vi.fn()},
    };
    const syncer = new SubtitleSyncer(client);
    const cue = {startTime: 10, endTime: 12};
    const track = {
      cues: [cue],
      shift: vi.fn(),
      shiftAfter: (c, amount) => {
        c.startTime += amount;
        c.endTime += amount;
      },
    };
    syncer.started = true;
    syncer.trackToSync = track;
    syncer.trackElements = [{cue, element: el()}];
    fire(syncer.ui.timelineTrack, 'mousedown', {clientX: x});
    return {syncer, cue, track};
  }

  it('ends the drag of a track switched off meanwhile, and later moves do not throw', () => {
    const {syncer, track} = grabbed(2);
    syncer.toggleTrack(track);
    expect(syncer.trackToSync).toBeNull();
    // Still held, then released.
    expect(() => fire(playerContainer, 'mousemove', {clientX: 20})).not.toThrow();
    expect(() => fire(playerContainer, 'mouseup')).not.toThrow();
    expect(() => fire(playerContainer, 'mousemove', {clientX: 30})).not.toThrow();
  });

  it('never lets a cue end before it starts', () => {
    const {cue} = grabbed(8);
    fire(playerContainer, 'mousemove', {clientX: -100});
    expect(cue.startTime).toBe(10);
    expect(cue.endTime).toBeCloseTo(10.1);
  });

  it('still moves a cue by its body, start and end together', () => {
    const {cue} = grabbed(2);
    fire(playerContainer, 'mousemove', {clientX: 7});
    expect(cue.startTime).toBe(15);
    expect(cue.endTime).toBe(17);
  });
});
