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
      clientHeight: 22,
      // A 2D context whose drawing calls do nothing.
      getContext: () => new Proxy({}, {get: (target, key) => (key in target ? target[key] : () => {})}),
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
vi.mock('../../chrome/player/modules/vtt.mjs', () => ({WebVTT: {convertCueToDOMTree: () => ({})}}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({AlertPolyfill: {prompt: vi.fn()}}));
vi.mock('../../chrome/player/utils/Utils.mjs', () => ({Utils: {clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v))}}));
vi.mock('../../chrome/player/utils/StringUtils.mjs', () => ({StringUtils: {formatTime: String}}));

vi.stubGlobal('document', doc);
const {FineTimeControls} = await import('../../chrome/player/ui/FineTimeControls.mjs');
const {SubtitleSyncer} = await import('../../chrome/player/ui/subtitles/SubtitleSyncer.mjs');
const {AlertPolyfill} = await import('../../chrome/player/utils/AlertPolyfill.mjs');

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
      savePosition: vi.fn(),
      setSeekSave: vi.fn(),
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

  it('ends a grab when the next video comes mid-grab, without seeking or starting it', () => {
    // The held grab went on seeking the next video from the previous one's position, and
    // its release started it.
    const {timeline, client} = playing();
    fire(timeline.ui.timelineTicks, 'mousedown', {clientX: 50});
    fire(playerContainer, 'mousemove', {clientX: 60});
    expect(client.currentTime).toBe(40);

    timeline.reset();
    expect(timeline.isSeeking).toBe(false);
    client.currentTime = 0;
    fire(playerContainer, 'mousemove', {clientX: 70});
    fire(doc, 'mouseup', {clientX: 80});
    expect(client.currentTime).toBe(0);
    expect(client.player.play).not.toHaveBeenCalled();
  });

  /**
   * A client that keeps undo history as FastStreamClient does: each seek made with seek
   * saving on is one undo step.
   * @return {{timeline: FineTimeControls, client: Object}}
   */
  function withUndo() {
    const {timeline, client} = playing();
    let time = 50;
    client.saveSeek = true;
    client.undoSteps = 0;
    client.savePosition = vi.fn(() => client.undoSteps++);
    client.setSeekSave = (value) => {
      client.saveSeek = value;
    };
    Object.defineProperty(client, 'currentTime', {
      get: () => time,
      set: (value) => {
        if (client.saveSeek) client.savePosition();
        time = value;
      },
    });
    return {timeline, client};
  }

  it('makes one grab one undo step, however many moves it had', () => {
    // Each move was a seek saved for undo: one grab filled the 50-step history, and undo
    // (Z) went back through its moves one by one (glm's second look, 2026-10-13).
    const {timeline, client} = withUndo();
    fire(timeline.ui.timelineTicks, 'mousedown', {clientX: 50});
    for (const x of [52, 55, 58, 61, 64]) fire(playerContainer, 'mousemove', {clientX: x});
    fire(doc, 'mouseup', {clientX: 70});
    expect(client.currentTime).toBe(30);
    expect(client.undoSteps).toBe(1);
    expect(client.saveSeek).toBe(true);
  });

  it('stays one undo step when an arrow key seeks in the middle of it', () => {
    // A key's seek turns saving off and on again around itself, and the moves after it were
    // saved again one by one (glm's review, 2026-10-13).
    const {timeline, client} = withUndo();
    fire(timeline.ui.timelineTicks, 'mousedown', {clientX: 50});
    fire(playerContainer, 'mousemove', {clientX: 52});
    client.setSeekSave(false);
    client.currentTime += 5;
    client.setSeekSave(true);
    for (const x of [55, 58, 61]) fire(playerContainer, 'mousemove', {clientX: x});
    fire(doc, 'mouseup', {clientX: 64});
    expect(client.undoSteps).toBe(1);
    expect(client.saveSeek).toBe(true);
  });

  it('saves seeks again after a grab the next video ended', () => {
    const {timeline, client} = withUndo();
    fire(timeline.ui.timelineTicks, 'mousedown', {clientX: 50});
    fire(playerContainer, 'mousemove', {clientX: 60});
    timeline.reset();
    expect(client.saveSeek).toBe(true);
  });
});

describe('FineTimeControls: closing the last state', () => {
  it('closes it at once, not a second later', () => {
    // The review of 2026-10-14 (his "no delays" wish): precise seek, the silence skipper
    // and the subtitle syncer closed a second after they were let go.
    const timeline = new FineTimeControls({audioAnalyzer: {getOutputRate: () => 1, getVolumeData: () => []}});
    timeline.stop = vi.fn();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    timeline.stateStack = [{onOpen, onClose, settings: {}}];
    timeline.removeState(onOpen);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(timeline.stop).toHaveBeenCalled();
    expect(timeline.stateStack).toEqual([]);
  });
});

describe('FineTimeControls: the audio canvases', () => {
  it('draws at the new screen scaling after a move to another screen', () => {
    // The height was set once, at the scaling the canvas was made with (glm's second look,
    // 2026-10-13).
    const client = {audioAnalyzer: {getOutputRate: () => 1, getVolumeData: () => []}};
    const timeline = new FineTimeControls(client);
    timeline.resetAudio();
    vi.stubGlobal('window', {devicePixelRatio: 1});
    timeline.renderAudio(100, 0, 10);
    const canvas = timeline.canvasElements[0].element;
    expect(canvas.height).toBe(22);

    vi.stubGlobal('window', {devicePixelRatio: 2});
    timeline.renderAudio(100, 0, 10);
    expect(canvas.height).toBe(44);
    vi.unstubAllGlobals();
    vi.stubGlobal('document', doc);
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
      renderTimeline: vi.fn(),
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

  it('stops syncing a track that was removed while another fine-time state was on top', () => {
    // The removal took the "bring the timeline back" path of a wand click: the timeline
    // came back with the removed track's cues, and the shift keys went on moving it.
    const {syncer, track} = grabbed(2);
    fire(playerContainer, 'mouseup');
    fineTimeControls.isStateActive = () => false;
    syncer.toggleTrack(track, true);
    expect(syncer.trackToSync).toBeNull();
    expect(syncer.started).toBe(false);
    expect(fineTimeControls.prioritizeState).not.toHaveBeenCalled();
  });

  // The timeline redrew only on a time update: on a paused video what was changed by hand
  // stayed as it was (glm's second look, 2026-10-13).
  it('takes an emptied cue\'s bar off a paused timeline at once', async () => {
    const {syncer, cue} = grabbed(2);
    fire(playerContainer, 'mouseup');
    // The real timeline's render: it draws the syncer's track with what is in view.
    fineTimeControls.renderTimeline = () => syncer.renderTracks(0, 100);
    syncer.visibleCues = [cue];
    const bar = syncer.trackElements[0].element;
    bar.remove = vi.fn();
    fineTimeControls.mousePositionToTime = () => 11;
    AlertPolyfill.prompt.mockResolvedValueOnce('');
    fire(syncer.ui.timelineTrack, 'dblclick');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bar.remove).toHaveBeenCalled();
    expect(syncer.trackElements).toEqual([]);
  });

  it('moves the bars of a paused timeline at once with the shift keys', () => {
    const {syncer} = grabbed(2);
    fire(playerContainer, 'mouseup');
    syncer.shiftSubtitles(1);
    expect(fineTimeControls.renderTimeline).toHaveBeenCalled();
  });

  it('shows the other track\'s cues, not the last one\'s, when switched to it', () => {
    // start() returned at once for a syncer already started.
    const {syncer} = grabbed(2);
    fire(playerContainer, 'mouseup');
    const other = {cues: [{startTime: 40, endTime: 42}], shift: vi.fn()};
    syncer.toggleTrack(other);
    expect(syncer.trackToSync).toBe(other);
    expect(syncer.trackElements).toEqual([]);
    expect(fineTimeControls.pushState).toHaveBeenCalled();
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

  describe('editing a cue by a double click shows the change on the video at once', () => {
    // Only playback redrew the video's subtitles: paused, the old text stayed, an emptied
    // cue stayed, and a new cue that was cancelled went on reading "New subtitle".
    /**
     * A syncer in edit mode, its cue from 10 s to 12 s, double-clicked at a time.
     * @param {number} time - Where the double click lands.
     * @param {string|undefined} answer - What the prompt gives back.
     * @return {Promise<{syncer: SubtitleSyncer, cue: Object, track: Object, render: Function}>}
     */
    async function doubleClicked(time, answer) {
      const {syncer, cue, track} = grabbed(2);
      fire(playerContainer, 'mouseup');
      fineTimeControls.mousePositionToTime = () => time;
      const render = syncer.client.interfaceController.subtitlesManager.renderSubtitles;
      render.mockClear();
      AlertPolyfill.prompt.mockResolvedValueOnce(answer);
      fire(syncer.ui.timelineTrack, 'dblclick');
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {syncer, cue, track, render};
    }

    beforeEach(() => {
      vi.stubGlobal('VTTCue', class {
        constructor(startTime, endTime, text) {
          Object.assign(this, {startTime, endTime, text});
        }
      });
    });

    it('a cue given new text', async () => {
      const {cue, render} = await doubleClicked(11, 'Changed');
      expect(cue.text).toBe('Changed');
      expect(render).toHaveBeenCalled();
    });

    it('a cue emptied, which removes it', async () => {
      const {track, render} = await doubleClicked(11, '');
      expect(track.cues).toEqual([]);
      expect(render).toHaveBeenCalled();
    });

    it('a new cue whose prompt was cancelled', async () => {
      const {track, render} = await doubleClicked(50, undefined);
      expect(track.cues).toHaveLength(1);
      // Once to show the new cue while its text is asked for, once to take it off.
      expect(render).toHaveBeenCalledTimes(2);
    });
  });
});
