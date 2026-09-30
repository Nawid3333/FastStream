// The re-encoder's MP4 starts at zero with its tracks as far apart as they played: a save from
// the middle of a stream moves every track back by the smallest first timestamp.
// Mediabunny keeps a fragmented MP4's timestamps as they come, so TimestampRebaser does this;
// tests/e2e/specs/modules.e2e.mjs reads the file it ends up in back with mp4box and ffmpeg.

import {describe, expect, it} from 'vitest';
import {TimestampRebaser} from '../../chrome/player/modules/reencoder/TimestampRebaser.mjs';

/**
 * Builds a rebaser that records what it passes on.
 * @param {string[]} tracks - The tracks it expects.
 * @return {{rebaser: TimestampRebaser, out: Array<Array<*>>}} The rebaser and its output,
 *     one [track, timestamp, item] per packet.
 */
function record(tracks) {
  const out = [];
  const rebaser = new TimestampRebaser(tracks, (track, timestamp, item) => {
    out.push([track, timestamp, item]);
  });
  return {rebaser, out};
}

describe('TimestampRebaser', () => {
  it('holds packets until every track has sent one, then moves all back by the smallest first', () => {
    // Microseconds, as WebCodecs gives them: video from its keyframe at 8.333 s, audio from
    // 5.999 s. The encoders' outputs can come in any order across the two.
    const {rebaser, out} = record(['video', 'audio']);
    rebaser.push('video', 8333333, 'v0');
    rebaser.push('video', 8566667, 'v1');
    expect(out).toEqual([]);

    rebaser.push('audio', 5999000, 'a0');
    expect(out).toEqual([
      ['video', 2334333, 'v0'],
      ['video', 2567667, 'v1'],
      ['audio', 0, 'a0'],
    ]);

    // From here on every packet goes straight through, moved by the same amount.
    rebaser.push('audio', 6022220, 'a1');
    rebaser.push('video', 8433333, 'v2');
    expect(out.slice(3)).toEqual([
      ['audio', 23220, 'a1'],
      ['video', 2434333, 'v2'],
    ]);
  });

  it('takes the amount from each track\'s first packet, whichever track that is', () => {
    const {rebaser, out} = record(['video', 'audio']);
    rebaser.push('video', 1000, 'v0');
    rebaser.push('video', 1100, 'v1');
    rebaser.push('audio', 1050, 'a0');
    expect(out).toEqual([
      ['video', 0, 'v0'],
      ['video', 100, 'v1'],
      ['audio', 50, 'a0'],
    ]);
  });

  it('starts a single track at zero from its first packet on', () => {
    const {rebaser, out} = record(['video']);
    rebaser.push('video', 600000000, 'v0');
    rebaser.push('video', 600033333, 'v1');
    expect(out).toEqual([
      ['video', 0, 'v0'],
      ['video', 33333, 'v1'],
    ]);
  });

  it('lets flush() pass on what a track that never sent anything held back', () => {
    // A video encoder that output nothing: the audio must still reach the file, from zero.
    const {rebaser, out} = record(['video', 'audio']);
    rebaser.push('audio', 2000000, 'a0');
    rebaser.push('audio', 2023220, 'a1');
    expect(out).toEqual([]);

    rebaser.flush();
    expect(out).toEqual([
      ['audio', 0, 'a0'],
      ['audio', 23220, 'a1'],
    ]);

    // A second flush passes nothing on again.
    rebaser.flush();
    expect(out).toHaveLength(2);
  });

  it('flushes nothing when nothing came, and does not move what comes after', () => {
    const {rebaser, out} = record(['video', 'audio']);
    rebaser.flush();
    expect(out).toEqual([]);
    rebaser.push('video', 5, 'v0');
    expect(out).toEqual([['video', 5, 'v0']]);
  });

  it('rejects a track it was not told about', () => {
    const {rebaser} = record(['video']);
    expect(() => rebaser.push('audio', 0, 'a0')).toThrow('unknown track audio');
  });
});
