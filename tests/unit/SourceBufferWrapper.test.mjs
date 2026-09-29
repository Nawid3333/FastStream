import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {SourceBufferWrapper} from '../../chrome/player/players/mp4/SourceBufferWrapper.mjs';

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
