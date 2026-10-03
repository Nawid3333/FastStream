import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {keyframeOffset, sampledDuration} from '../../chrome/player/players/mp4/SampleIndex.mjs';
import {SegmentAppender} from '../../chrome/player/players/mp4/SegmentAppender.mjs';

// MP4Player's sample arithmetic and its handling of a segment the SourceBuffer refuses.
// MP4Player itself imports the vendored mp4box, which unit tests do not have, so these run
// the parts it hands the work to.

/**
 * A track as mp4box keeps it: samples are filled as moofs holding the track are parsed.
 * @param {number} timescale
 * @param {Array<[number, number]>} samples - [cts, offset] of each keyframe.
 * @param {number} [duration] - samples_duration, in timescale units.
 * @return {Object}
 */
function trak(timescale, samples, duration = 0) {
  return {
    mdia: {mdhd: {timescale}},
    samples_duration: duration,
    samples: samples.map(([cts, offset]) => ({cts, offset, timescale, is_sync: true})),
  };
}

describe('sampledDuration, a fragmented file without a mehd box', () => {
  it('is its longest track, as far as its samples are known', () => {
    expect(sampledDuration([trak(90000, [[0, 100]], 90000 * 12), trak(48000, [[0, 200]], 48000 * 11.5)])).toBe(12);
  });

  it('leaves out a track with no samples yet, rather than throwing', () => {
    // A subtitle track, or a first video moof beyond the first range read: samples[0] was
    // undefined, the metadata never finished, and the player sat there with nothing said.
    expect(sampledDuration([trak(1000, []), trak(48000, [[0, 200]], 48000 * 8)])).toBe(8);
    expect(sampledDuration([trak(1000, [])])).toBe(0);
  });
});

describe('keyframeOffset, where to read from to play a time', () => {
  const video = trak(90000, [[0, 1000], [90000 * 4, 500000], [90000 * 8, 1200000]]).samples;
  const audio = trak(48000, [[0, 900], [48000 * 4, 480000], [48000 * 8, 1100000]]).samples;

  it('is the lowest offset of the tracks\' keyframes at or before it', () => {
    expect(keyframeOffset([video, audio], 5)).toBe(480000);
    expect(keyframeOffset([video, audio], 0)).toBe(900);
    expect(keyframeOffset([video], 9)).toBe(1200000);
  });

  it('leaves out a track with no keyframe yet, rather than throwing', () => {
    // The main loop threw on every turn there, and stopped for good, with nothing said.
    expect(keyframeOffset([[], audio], 5)).toBe(480000);
  });

  it('has none while no track has a keyframe', () => {
    expect(keyframeOffset([[], []], 5)).toBe(null);
    expect(keyframeOffset([], 5)).toBe(null);
  });
});

describe('SegmentAppender, a segment the SourceBuffer refuses', () => {
  // The refusal was an unhandled rejection, and the segment's samples were already released:
  // playback reached the hole and waited there for good, with no error.
  let player;
  let current;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    current = new Set();
    player = {
      reload: vi.fn(),
      readLess: vi.fn(),
      fail: vi.fn(),
      isCurrent: (wrapper) => current.has(wrapper),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A SourceBufferWrapper that accepts or refuses each append, in turn.
   * @param {Array<?Error>} answers - null to accept, or the error to refuse with.
   * @return {Object}
   */
  function wrapper(answers) {
    const made = {
      appendBuffer: vi.fn(() => {
        const answer = answers.shift();
        return answer ? Promise.reject(answer) : Promise.resolve();
      }),
    };
    current.add(made);
    return made;
  }

  /**
   * Lets the appends' promises settle.
   * @return {Promise<void>}
   */
  async function settle() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  const full = () => new DOMException('The SourceBuffer is full', 'QuotaExceededError');

  it('has the player load again from the playhead, reading less ahead when it was full', async () => {
    const appender = new SegmentAppender(player);
    appender.append(wrapper([full()]), new ArrayBuffer(8));
    await settle();
    expect(player.readLess).toHaveBeenCalledTimes(1);
    expect(player.reload).toHaveBeenCalledTimes(1);
    expect(player.fail).not.toHaveBeenCalled();
  });

  it('only loads again for a refusal that is not about room', async () => {
    const appender = new SegmentAppender(player);
    appender.append(wrapper([new DOMException('gone', 'InvalidStateError')]), new ArrayBuffer(8));
    await settle();
    expect(player.readLess).not.toHaveBeenCalled();
    expect(player.reload).toHaveBeenCalledTimes(1);
  });

  it('leaves to the reload the refusals of what was appended before it', async () => {
    // A full SourceBuffer refuses every append queued behind the first: each one loading
    // again would throw away what the last load just buffered.
    const appender = new SegmentAppender(player);
    player.reload.mockImplementation(() => appender.reloaded());
    const sourceBuffer = wrapper([full(), full(), full()]);
    appender.append(sourceBuffer, new ArrayBuffer(8));
    appender.append(sourceBuffer, new ArrayBuffer(8));
    appender.append(sourceBuffer, new ArrayBuffer(8));
    await settle();
    expect(player.reload).toHaveBeenCalledTimes(1);
    expect(player.fail).not.toHaveBeenCalled();
  });

  it('gives up with an error on the third refusal in a row', async () => {
    const appender = new SegmentAppender(player);
    player.reload.mockImplementation(() => appender.reloaded());
    const sourceBuffer = wrapper([full(), full(), full()]);
    for (let i = 0; i < 3; i++) {
      appender.append(sourceBuffer, new ArrayBuffer(8));
      await settle();
    }
    expect(player.reload).toHaveBeenCalledTimes(2);
    expect(player.fail).toHaveBeenCalledTimes(1);
    expect(player.fail.mock.calls[0][0]).toMatch(/QuotaExceededError/);
  });

  it('starts counting again once an append is accepted', async () => {
    const appender = new SegmentAppender(player);
    player.reload.mockImplementation(() => appender.reloaded());
    const sourceBuffer = wrapper([full(), full(), null, full(), full()]);
    for (let i = 0; i < 5; i++) {
      appender.append(sourceBuffer, new ArrayBuffer(8));
      await settle();
    }
    expect(player.fail).not.toHaveBeenCalled();
    expect(player.reload).toHaveBeenCalledTimes(4);
  });

  it('ignores the refusals of a SourceBuffer the player no longer uses', async () => {
    const appender = new SegmentAppender(player);
    const old = wrapper([new DOMException('removed', 'InvalidStateError')]);
    current.delete(old);
    appender.append(old, new ArrayBuffer(8));
    await settle();
    expect(player.reload).not.toHaveBeenCalled();
    expect(player.fail).not.toHaveBeenCalled();
  });
});
