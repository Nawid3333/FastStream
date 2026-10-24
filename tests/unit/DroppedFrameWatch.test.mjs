import {describe, expect, it} from 'vitest';

import {DroppedFrameWatch, lowerLevel, qualityLabel} from '../../chrome/player/players/DroppedFrameWatch.mjs';

// A version this computer cannot decode in time drops a share of its frames for as long as it
// plays; the player steps down then, and says so (his wish, 2026-10-24). The watch decides
// when: a fifth of the frames over 10 s of steady playback, after a version's warm-up.

/**
 * Feeds a watch one sample a second from `from` to `to` (ms), at fps frames a second of which
 * `dropRatio` are dropped, and gives back the first step-down due, with when.
 * @return {?{at: number, due: {ratio: number, frames: number}}}
 */
function play(watch, {from = 0, to, fps = 30, dropRatio, levelId = 'hd', steady = () => true, counts = {total: 0, dropped: 0}}) {
  for (let now = from; now <= to; now += 1000) {
    if (now > from) {
      counts.total += fps;
      counts.dropped += Math.round(fps * dropRatio);
    }
    const due = watch.sample({now, total: counts.total, dropped: counts.dropped, steady: steady(now), levelId});
    if (due) return {at: now, due};
  }
  return null;
}

describe('DroppedFrameWatch', () => {
  it('steps down after 10 s of steady playback that dropped a fifth of the frames, past the warm-up', () => {
    const result = play(new DroppedFrameWatch(), {to: 30000, dropRatio: 0.3});
    // Warm-up to 4 s, then a full 10 s stretch.
    expect(result?.at).toBe(14000);
    expect(result?.due.ratio).toBeCloseTo(0.3, 2);
    expect(result?.due.frames).toBe(300);
  });

  it('keeps a version that drops less than a fifth', () => {
    expect(play(new DroppedFrameWatch(), {to: 60000, dropRatio: 0.15})).toBe(null);
  });

  it('judges no stretch with too few frames to tell (a slide show, a still)', () => {
    expect(play(new DroppedFrameWatch(), {to: 60000, fps: 5, dropRatio: 0.5})).toBe(null);
  });

  it('counts only steady playback: a pause, a fast speed or a hidden tab starts the stretch again', () => {
    // Unsteady from 8 s to 12 s: the stretch starts again at 13 s, and is due 10 s on.
    const result = play(new DroppedFrameWatch(), {to: 40000, dropRatio: 0.3, steady: (now) => now < 8000 || now > 12000});
    expect(result?.at).toBe(23000);
  });

  it('gives a new version its warm-up and its own count', () => {
    const watch = new DroppedFrameWatch();
    const counts = {total: 0, dropped: 0};
    expect(play(watch, {to: 9000, dropRatio: 0.3, counts})).toBe(null);
    // Switched at 10 s: judged from 14 s on, due at 24 s.
    expect(play(watch, {from: 10000, to: 40000, dropRatio: 0.3, levelId: 'sd', counts})?.at).toBe(24000);
  });

  it('never steps down from a version the user chose by hand, and judges another again', () => {
    const watch = new DroppedFrameWatch();
    watch.userChose('hd');
    const counts = {total: 0, dropped: 0};
    expect(play(watch, {to: 60000, dropRatio: 0.5, counts})).toBe(null);
    expect(play(watch, {from: 61000, to: 90000, dropRatio: 0.5, levelId: 'fhd', counts})).not.toBe(null);
  });

  it('does not count a seek, a speed or a stall that came and went between two samples', () => {
    // Firefox's counts are the video's since it started: a moment at 4x between two steady
    // samples dropped 60 frames by design, which counted as this version's.
    const watch = new DroppedFrameWatch();
    const counts = {total: 0, dropped: 0};
    expect(play(watch, {to: 8000, dropRatio: 0.05, counts})).toBe(null);
    counts.dropped += 60;
    watch.interrupt();
    expect(play(watch, {from: 9000, to: 40000, dropRatio: 0.05, counts})).toBe(null);
  });

  it('starts over when the counts go back: a new video element', () => {
    const watch = new DroppedFrameWatch();
    expect(play(watch, {to: 12000, dropRatio: 0.3, counts: {total: 5000, dropped: 2000}})).toBe(null);
    // The counts restart from 0 at 13 s: the stretch is due 10 s after it.
    expect(play(watch, {from: 13000, to: 40000, dropRatio: 0.3})?.at).toBe(23000);
  });

  it('keeps the user\'s choice through the reset of a player built anew for the same video, once', () => {
    const watch = new DroppedFrameWatch();
    watch.userChose('hd');
    watch.keepChoiceOnce();
    watch.reset();
    expect(watch.chosen).toBe('hd');
    watch.reset();
    expect(watch.chosen).toBe(null);
  });

  it('forgets the user\'s choice with a new video', () => {
    const watch = new DroppedFrameWatch();
    watch.userChose('hd');
    watch.reset();
    expect(play(watch, {to: 30000, dropRatio: 0.3})).not.toBe(null);
  });
});

describe('qualityLabel', () => {
  it('names the height, and the frame rate when the video has the height at another rate too', () => {
    const levels = [
      {id: 'a', height: 1080, frameRate: 30},
      {id: 'b', height: 720, frameRate: 60},
      {id: 'c', height: 720, frameRate: 29.97},
      {id: 'd', height: 480},
    ];
    expect(qualityLabel(levels, levels[0])).toBe('1080p');
    expect(qualityLabel(levels, levels[1])).toBe('720p60');
    expect(qualityLabel(levels, levels[2])).toBe('720p30');
    expect(qualityLabel(levels, levels[3])).toBe('480p');
  });
});

describe('lowerLevel', () => {
  const levels = [
    {id: '2160', height: 2160, bitrate: 16e6, frameRate: 30},
    {id: '1080a', height: 1080, bitrate: 5e6, frameRate: 60},
    {id: '1080b', height: 1080, bitrate: 3e6, frameRate: 30},
    {id: '720a', height: 720, bitrate: 2.5e6, frameRate: 30},
    {id: '720b', height: 720, bitrate: 1.5e6, frameRate: 30},
    {id: 'audio', height: 0, bitrate: 1e5},
  ];

  it('takes the best version of the next smaller height', () => {
    expect(lowerLevel(levels, levels[0])?.id).toBe('1080a');
    expect(lowerLevel(levels, levels[2])?.id).toBe('720a');
  });

  it('takes the same height at a lower frame rate when nothing is smaller', () => {
    const only1080 = levels.filter((level) => level.height === 1080);
    expect(lowerLevel(only1080, only1080[0])?.id).toBe('1080b');
  });

  it('has nothing lighter for the smallest version, nor for one without a frame rate to compare', () => {
    expect(lowerLevel(levels, levels[4])).toBe(null);
    expect(lowerLevel([{id: 'a', height: 720}, {id: 'b', height: 720}], {id: 'a', height: 720})).toBe(null);
  });
});
