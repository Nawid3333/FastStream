import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {SourceBufferWrapper, removalPending} from '../../chrome/player/players/mp4/SourceBufferWrapper.mjs';

// SourceBufferWrapper queues MP4Player's appends and removals in front of a SourceBuffer,
// running each once the one before it has fired updateend. An operation that throws
// (remove() with an end before its start or a NaN duration, either one on a SourceBuffer
// the MediaSource has let go) starts no update, so no updateend follows. The wrapper used
// to mark itself updating anyway, and every later operation then waited for good; an
// append that threw stayed at the head of the queue and was run again by every later call.

const originalMediaSource = globalThis.MediaSource;

/** A SourceBuffer whose updates end when the test says so. */
class FakeSourceBuffer extends EventTarget {
  constructor() {
    super();
    this.appendBuffer = vi.fn();
    this.remove = vi.fn();
    this.abort = vi.fn();
    this.buffered = {length: 0, start: () => 0, end: () => 0};
  }

  updateEnd() {
    this.dispatchEvent(new Event('updateend'));
  }
}

/**
 * A wrapper over a fake SourceBuffer.
 * @return {{sourceBuffer: FakeSourceBuffer, wrapper: SourceBufferWrapper}}
 */
function makeWrapper() {
  const sourceBuffer = new FakeSourceBuffer();
  const mediaSource = {addSourceBuffer: () => sourceBuffer};
  return {sourceBuffer, wrapper: new SourceBufferWrapper(mediaSource, 'video/mp4; codecs="avc1.42E01E"')};
}

describe('SourceBufferWrapper', () => {
  beforeEach(() => {
    // Node has no MediaSource, and the constructor asks it whether the codec plays.
    globalThis.MediaSource = {isTypeSupported: () => true};
    // The wrapper logs each operation that throws.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.MediaSource = originalMediaSource;
  });

  it('rejects a remove that throws, and runs the next operation', async () => {
    const {sourceBuffer, wrapper} = makeWrapper();
    sourceBuffer.remove.mockImplementation(() => {
      throw new TypeError('The end provided (NaN) is not a number.');
    });

    await expect(wrapper.remove(0, NaN)).rejects.toThrow(TypeError);
    expect(wrapper.updating).toBe(false);

    const chunk = new ArrayBuffer(8);
    const appended = wrapper.appendBuffer(chunk);
    expect(sourceBuffer.appendBuffer).toHaveBeenCalledTimes(1);
    expect(sourceBuffer.appendBuffer.mock.calls[0][0]).toBe(chunk);

    sourceBuffer.updateEnd();
    await appended;
    expect(wrapper.updating).toBe(false);
  });

  it('rejects an append that throws, and runs the next operation instead of that one again', async () => {
    const {sourceBuffer, wrapper} = makeWrapper();
    const poison = new ArrayBuffer(8);
    sourceBuffer.appendBuffer.mockImplementation((buffer) => {
      if (buffer === poison) {
        throw new Error('InvalidStateError: This SourceBuffer has been removed from the parent media source.');
      }
    });

    await expect(wrapper.appendBuffer(poison)).rejects.toThrow('InvalidStateError');

    const chunk = new ArrayBuffer(16);
    const second = wrapper.appendBuffer(chunk);
    // The old code rejects this one with the first one's error.
    second.catch(() => {});
    expect(sourceBuffer.appendBuffer).toHaveBeenCalledTimes(2);
    expect(sourceBuffer.appendBuffer.mock.calls[1][0]).toBe(chunk);

    sourceBuffer.updateEnd();
    await second;
    expect(wrapper.updating).toBe(false);
  });

  it('runs the operations queued behind ones that throw, in order', async () => {
    const {sourceBuffer, wrapper} = makeWrapper();
    const order = [];
    sourceBuffer.appendBuffer.mockImplementation((buffer) => order.push(['append', buffer.byteLength]));
    sourceBuffer.remove.mockImplementation((start, end) => {
      if (end <= start) throw new TypeError('end <= start');
      order.push(['remove', start, end]);
    });

    const first = wrapper.appendBuffer(new ArrayBuffer(1));
    const bad = wrapper.remove(5, 5);
    const worse = wrapper.remove(7, 3);
    const good = wrapper.remove(0, 10);
    const last = wrapper.appendBuffer(new ArrayBuffer(2));
    expect(order).toEqual([['append', 1]]);

    sourceBuffer.updateEnd();
    await expect(bad).rejects.toThrow(TypeError);
    await expect(worse).rejects.toThrow(TypeError);
    expect(order).toEqual([['append', 1], ['remove', 0, 10]]);

    sourceBuffer.updateEnd();
    expect(order).toEqual([['append', 1], ['remove', 0, 10], ['append', 2]]);

    sourceBuffer.updateEnd();
    await Promise.all([first, good, last]);
    expect(wrapper.updating).toBe(false);
    expect(wrapper.toDo).toEqual([]);
  });

  it('runs one operation at a time, each after the previous updateend', async () => {
    const {sourceBuffer, wrapper} = makeWrapper();
    const order = [];
    sourceBuffer.appendBuffer.mockImplementation((buffer) => order.push(['append', buffer.byteLength]));
    sourceBuffer.remove.mockImplementation((start, end) => order.push(['remove', start, end]));

    const p1 = wrapper.appendBuffer(new ArrayBuffer(1));
    const p2 = wrapper.remove(0, 10);
    const p3 = wrapper.appendBuffer(new ArrayBuffer(2));
    expect(order).toEqual([['append', 1]]);
    expect(wrapper.updating).toBe(true);

    sourceBuffer.updateEnd();
    expect(order).toEqual([['append', 1], ['remove', 0, 10]]);

    sourceBuffer.updateEnd();
    expect(order).toEqual([['append', 1], ['remove', 0, 10], ['append', 2]]);

    // Nothing is left to run.
    sourceBuffer.updateEnd();
    expect(order).toEqual([['append', 1], ['remove', 0, 10], ['append', 2]]);
    expect(wrapper.updating).toBe(false);

    await Promise.all([p1, p2, p3]);
  });
});

// MP4Player's seek decides from `buffered` whether to load anew, and a removal still queued
// is about to take away what `buffered` shows. A seek to 0 just after a jump to the end found
// the start buffered (the jump's removal of everything waited behind the end's appends), did
// not reload, and the removal then took the start away: the player sat at 0 with nothing
// loading (#265, mp4-seek.e2e.mjs "loads the start again after jumping back to it from the end,
// every time").
describe('a removal still to run', () => {
  beforeEach(() => {
    globalThis.MediaSource = {isTypeSupported: () => true};
  });

  afterEach(() => {
    globalThis.MediaSource = originalMediaSource;
  });

  it('is pending while it waits behind an append, and while it runs', () => {
    const {sourceBuffer, wrapper} = makeWrapper();
    expect(wrapper.hasPendingRemove(0)).toBe(false);
    wrapper.appendBuffer(new ArrayBuffer(8));
    wrapper.remove(0, 160);
    // Queued behind the append that is running.
    expect(sourceBuffer.remove).not.toHaveBeenCalled();
    expect(wrapper.hasPendingRemove(0)).toBe(true);
    // The append ends; the removal runs now.
    sourceBuffer.updateEnd();
    expect(sourceBuffer.remove).toHaveBeenCalledWith(0, 160);
    expect(wrapper.hasPendingRemove(0)).toBe(true);
    // Done: `buffered` is true again.
    sourceBuffer.updateEnd();
    expect(wrapper.hasPendingRemove(0)).toBe(false);
  });

  it('is not pending for appends alone', () => {
    const {sourceBuffer, wrapper} = makeWrapper();
    wrapper.appendBuffer(new ArrayBuffer(8));
    wrapper.appendBuffer(new ArrayBuffer(8));
    expect(wrapper.hasPendingRemove(0)).toBe(false);
    sourceBuffer.updateEnd();
    expect(wrapper.hasPendingRemove(0)).toBe(false);
  });

  it('is pending for a player when either of its SourceBuffers has one', () => {
    const video = makeWrapper();
    const audio = makeWrapper();
    expect(removalPending([video.wrapper, audio.wrapper], 0)).toBe(false);
    audio.wrapper.appendBuffer(new ArrayBuffer(8));
    audio.wrapper.remove(0, 160);
    expect(removalPending([video.wrapper, audio.wrapper], 0)).toBe(true);
    // A player without an audio track.
    expect(removalPending([video.wrapper, null], 0)).toBe(false);
  });

  it('counts only a removal over the target: the back buffer trimmed while playing does not', () => {
    // A reload for every seek while a trim was queued rebuffered each arrow press.
    const {sourceBuffer, wrapper} = makeWrapper();
    wrapper.appendBuffer(new ArrayBuffer(8));
    // Behind the playhead at 100 s, as MP4Player trims it.
    wrapper.remove(0, 70);
    expect(wrapper.hasPendingRemove(95)).toBe(false);
    expect(wrapper.hasPendingRemove(30)).toBe(true);
    sourceBuffer.updateEnd();
    // Running now.
    expect(wrapper.hasPendingRemove(95)).toBe(false);
    expect(wrapper.hasPendingRemove(70)).toBe(true);
  });

  it('aborts without a throw while a removal runs (the player is being destroyed)', () => {
    // SourceBuffer.abort() throws InvalidStateError while a removal runs: MP4Player's
    // destroy() stopped half way, and DESTROYED was never emitted.
    const {sourceBuffer, wrapper} = makeWrapper();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sourceBuffer.abort = vi.fn(() => {
      throw new DOMException('a removal is running', 'InvalidStateError');
    });
    wrapper.remove(0, 10);
    expect(() => wrapper.abort()).not.toThrow();
    expect(sourceBuffer.abort).toHaveBeenCalledTimes(1);
  });

  // An MP4's other audio track (MP4Player.switchAudioTrack) can have another codec: the type
  // changes in the queue, behind the removal that empties the SourceBuffer and before the new
  // track's initialization segment, as SourceBuffer.changeType() is refused while an update runs.
  it('changes the type in its place in the queue, and runs the next operation at once', async () => {
    const {sourceBuffer, wrapper} = makeWrapper();
    const calls = [];
    sourceBuffer.remove.mockImplementation(() => calls.push('remove'));
    sourceBuffer.changeType = vi.fn((type) => calls.push('changeType ' + type));
    sourceBuffer.appendBuffer.mockImplementation(() => calls.push('append'));

    wrapper.remove(0, 10);
    const changed = wrapper.changeType('audio/mp4; codecs="opus"');
    wrapper.appendBuffer(new ArrayBuffer(8));
    expect(calls).toEqual(['remove']);

    // changeType starts no update and fires no updateend: the append must not wait for one.
    sourceBuffer.updateEnd();
    await expect(changed).resolves.toBeUndefined();
    expect(calls).toEqual(['remove', 'changeType audio/mp4; codecs="opus"', 'append']);
    expect(wrapper.updating).toBe(true);
  });

  it('rejects a type the SourceBuffer refuses, and runs the next operation', async () => {
    const {sourceBuffer, wrapper} = makeWrapper();
    sourceBuffer.changeType = vi.fn(() => {
      throw new DOMException('unsupported', 'NotSupportedError');
    });
    const changed = wrapper.changeType('audio/mp4; codecs="ac-3"');
    const appended = wrapper.appendBuffer(new ArrayBuffer(8));
    await expect(changed).rejects.toThrow('unsupported');
    await expect(appended).resolves.toBeUndefined();
    expect(sourceBuffer.appendBuffer).toHaveBeenCalledTimes(1);
  });
});

// A seek that loads afresh (MP4Player.resetHLS) queued its removal of everything behind the
// media segments still waiting: Firefox parsed each of them, hundreds behind a fast download,
// for the removal to take it away again before the new place's first segment (Codex's
// review, 2026-11-07). They are dropped now; what runs, initialization segments and removals
// stay.
describe('a reset with media segments still queued', () => {
  beforeEach(() => {
    globalThis.MediaSource = {isTypeSupported: () => true};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.MediaSource = originalMediaSource;
  });

  it('drops the queued media segments only, and their promises reject', async () => {
    const {sourceBuffer, wrapper} = makeWrapper();
    const order = [];
    sourceBuffer.appendBuffer.mockImplementation((buffer) => order.push(['append', buffer.byteLength]));
    sourceBuffer.remove.mockImplementation((start, end) => order.push(['remove', start, end]));

    const running = wrapper.appendBuffer(new ArrayBuffer(1), {media: true});
    const queued = [wrapper.appendBuffer(new ArrayBuffer(2), {media: true}), wrapper.appendBuffer(new ArrayBuffer(3), {media: true})];
    const init = wrapper.appendBuffer(new ArrayBuffer(4));
    const removal = wrapper.remove(5, 6);
    wrapper.dropQueuedMedia();

    for (const p of queued) await expect(p).rejects.toMatchObject({name: 'AbortError'});
    sourceBuffer.updateEnd();
    sourceBuffer.updateEnd();
    sourceBuffer.updateEnd();
    expect(order).toEqual([['append', 1], ['append', 4], ['remove', 5, 6]]);
    await Promise.all([running, init, removal]);
  });

  it('puts the removal of the reset right behind the segment that runs', async () => {
    const {default: MP4Player} = await import('../../chrome/player/players/mp4/MP4Player.mjs');
    const {SegmentAppender} = await import('../../chrome/player/players/mp4/SegmentAppender.mjs');
    const video = makeWrapper();
    const audio = makeWrapper();
    const reload = vi.fn();
    const player = {
      metaData: {tracks: []},
      segmentAppender: new SegmentAppender({reload, readLess: vi.fn(), fail: vi.fn(), isCurrent: () => true}),
      videoSourceBuffer: video.wrapper,
      audioSourceBuffer: audio.wrapper,
      mediaSource: {duration: 100},
      mp4box: {flush: vi.fn(), seek: vi.fn(), stream: {buffers: []}},
      seekMp4box: vi.fn(),
      freeSamples: vi.fn(),
      loader: null,
      video: {duration: 100},
      currentTime: 50,
      currentFragments: [],
      rangeRetries: new Map(),
      fedRanges: new Map(),
      runLoad: vi.fn(),
    };
    player.removeFromBuffers = MP4Player.prototype.removeFromBuffers.bind(player);
    for (let i = 0; i < 300; i++) {
      player.segmentAppender.append(video.wrapper, new ArrayBuffer(1));
      player.segmentAppender.append(audio.wrapper, new ArrayBuffer(1));
    }

    MP4Player.prototype.resetHLS.call(player, true);

    for (const {wrapper} of [video, audio]) {
      expect(wrapper.toDo.map((op) => op.type)).toEqual(['remove']);
    }
    // The dropped segments are the reset's business: no reload, no error for them.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps what mp4box\'s flush gives during the reset, behind the removal, and counts no refusal', async () => {
    // glm's review of the change: dropped after the flush, a segment the flush gave was
    // queued under the reset's own count, and its AbortError counted as a refusal - a reload
    // more, and three quick seeks failed the video with "could not be buffered".
    const {default: MP4Player} = await import('../../chrome/player/players/mp4/MP4Player.mjs');
    const {SegmentAppender} = await import('../../chrome/player/players/mp4/SegmentAppender.mjs');
    const video = makeWrapper();
    const reload = vi.fn();
    const fail = vi.fn();
    const player = {
      metaData: {tracks: []},
      segmentAppender: new SegmentAppender({reload, readLess: vi.fn(), fail, isCurrent: () => true}),
      videoSourceBuffer: video.wrapper,
      audioSourceBuffer: null,
      mediaSource: {duration: 100},
      mp4box: {
        flush: () => player.segmentAppender.append(video.wrapper, new ArrayBuffer(7)),
        seek: vi.fn(),
        stream: {buffers: []},
      },
      seekMp4box: vi.fn(),
      freeSamples: vi.fn(),
      loader: null,
      video: {duration: 100},
      currentTime: 50,
      currentFragments: [],
      rangeRetries: new Map(),
      fedRanges: new Map(),
      runLoad: vi.fn(),
    };
    player.removeFromBuffers = MP4Player.prototype.removeFromBuffers.bind(player);
    player.segmentAppender.append(video.wrapper, new ArrayBuffer(1)); // running
    player.segmentAppender.append(video.wrapper, new ArrayBuffer(2)); // queued

    for (let i = 0; i < 3; i++) MP4Player.prototype.resetHLS.call(player, true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([reload.mock.calls.length, fail.mock.calls.length]).toEqual([0, 0]);
  });
});

// A player destroyed with appends still queued (peaks of 2,000-3,000 one-frame segments are
// measured): the duration's release started the next one on the dying player, and the abort's
// updateend ran every queued operation against a SourceBuffer its MediaSource had let go - each
// threw, was logged and rejected, one exception and one console line per queued frame.
describe('a player destroyed with appends queued', () => {
  beforeEach(() => {
    globalThis.MediaSource = {isTypeSupported: () => true};
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.MediaSource = originalMediaSource;
  });

  /**
   * A SourceBuffer the MediaSource has let go: every operation throws.
   * @param {FakeSourceBuffer} sourceBuffer
   */
  const removed = (sourceBuffer) => {
    sourceBuffer.appendBuffer.mockImplementation(() => {
      throw new DOMException('This SourceBuffer has been removed from the parent media source.', 'InvalidStateError');
    });
  };

  it('runs nothing it had queued once disposed, the update running or not', async () => {
    const {sourceBuffer, wrapper} = makeWrapper();
    const outcomes = [];
    for (let i = 0; i < 100; i++) {
      wrapper.appendBuffer(new ArrayBuffer(1), {media: true}).then(() => outcomes.push('taken'), () => outcomes.push('refused'));
    }
    expect(sourceBuffer.appendBuffer).toHaveBeenCalledTimes(1);

    wrapper.dispose();
    removed(sourceBuffer);
    // The running append's end, as its abort fires it; then a release, as DurationSync makes.
    sourceBuffer.updateEnd();
    wrapper.release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sourceBuffer.appendBuffer).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
    // Only the one that ran was taken; nothing waits on the others.
    expect(outcomes).toEqual(['taken']);
    expect(wrapper.toDo).toEqual([]);
  });

  it('starts no append when MP4Player.destroy lets go of the duration', async () => {
    const {default: MP4Player} = await import('../../chrome/player/players/mp4/MP4Player.mjs');
    const {DurationSync} = await import('../../chrome/player/players/mp4/DurationSync.mjs');
    const video = makeWrapper();
    const audio = makeWrapper();
    const mediaSource = {readyState: 'open', duration: 10};
    const player = {
      running: true, mediaSource, videoSourceBuffer: video.wrapper, audioSourceBuffer: audio.wrapper,
      mediaSourceURL: null, loader: null, currentFragments: [], loopTimeout: null,
      video: {pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn()}, emit: vi.fn(),
    };
    player.durationSync = new DurationSync(() => mediaSource, () => [video.wrapper, audio.wrapper]);
    // The audio's SourceBuffer updating: a new duration holds both until it ends.
    audio.wrapper.appendBuffer(new ArrayBuffer(1));
    audio.sourceBuffer.updating = true;
    player.durationSync.set(20);
    expect(video.wrapper.held).toBe(true);
    for (let i = 0; i < 100; i++) {
      video.wrapper.appendBuffer(new ArrayBuffer(1), {media: true}).catch(() => {});
    }
    expect(video.sourceBuffer.appendBuffer).not.toHaveBeenCalled();

    removed(video.sourceBuffer);
    removed(audio.sourceBuffer);
    MP4Player.prototype.destroy.call(player);
    audio.sourceBuffer.updating = false;
    audio.sourceBuffer.updateEnd();
    video.sourceBuffer.updateEnd();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(video.sourceBuffer.appendBuffer).not.toHaveBeenCalled();
    expect(audio.sourceBuffer.appendBuffer).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(player.emit).toHaveBeenCalledTimes(1);
  });
});
