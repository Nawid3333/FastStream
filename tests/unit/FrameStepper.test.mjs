import {describe, expect, it} from 'vitest';
import {FALLBACK_FRAME_DURATION, FrameStepper, frameStepTarget} from '../../chrome/player/ui/FrameStepper.mjs';

// The frame step is only right if it lands on the neighbouring frame, not the one after it
// or the one it started on; a wrong answer shows as a step that does nothing or skips.
// The usual use: play, pause, then step. Timestamps below are what Firefox 156 reports:
// a playback frame's own start, or while paused the position seeked to.

const D = 1 / 24;
const frameOf = (time, d = D) => Math.floor(time / d + 1e-6);

// A stand-in video: listeners and frame callbacks the test fires by hand.
function fakeVideo() {
  const listeners = {};
  const video = {
    callbacks: [],
    presentedFrames: 0,
    addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
    removeEventListener: (type, fn) => listeners[type] = (listeners[type] || []).filter((f) => f !== fn),
    requestVideoFrameCallback: (fn) => video.callbacks.push(fn),
    emit: (type) => (listeners[type] || []).forEach((fn) => fn()),
    present: (mediaTime, {skipCount = 0} = {}) => {
      video.presentedFrames += 1 + skipCount;
      video.callbacks.shift()(0, {mediaTime, presentedFrames: video.presentedFrames});
    },
    listenerCount: () => Object.values(listeners).reduce((n, fns) => n + fns.length, 0),
  };
  return video;
}

const play = (video, fromFrame, frames, d = D) => {
  video.emit('play');
  video.present(fromFrame * d + 0.3 * d); // the paused frame shown again, stamped off the grid
  for (let i = 1; i <= frames; i++) video.present((fromFrame + i) * d);
};

describe('frameStepTarget', () => {
  it('aims at the middle of the next or previous frame', () => {
    expect(frameStepTarget(10 * D, D, 1)).toBeCloseTo(11.5 * D, 9);
    expect(frameStepTarget(10 * D, D, -1)).toBeCloseTo(9.5 * D, 9);
  });

  it('finds the frame on screen from a position anywhere inside it', () => {
    for (const inside of [0, 0.01, 0.5, 0.99]) {
      expect(frameOf(frameStepTarget((10 + inside) * D, D, 1))).toBe(11);
      expect(frameOf(frameStepTarget((10 + inside) * D, D, -1))).toBe(9);
    }
  });

  it('follows a grid that does not start at 0', () => {
    const anchor = 0.013;
    const target = frameStepTarget(anchor + 5.7 * D, D, 1, anchor);
    expect(target).toBeCloseTo(anchor + 6.5 * D, 9);
  });

  it('stays on the first frame going back from it', () => {
    expect(frameStepTarget(0, D, -1)).toBe(0);
  });

  it('keeps a position exactly on a frame start in that frame', () => {
    expect(frameOf(frameStepTarget(11 * D, D, 1))).toBe(12);
    // 7/24 divided by 1/24 is 6.999999999999999 in floating point, and so is a 23.976 fps
    // frame 3: without the nudge the step would start from the frame before.
    expect(frameOf(frameStepTarget(7 * D, D, 1))).toBe(8);
    const ntsc = 1001 / 24000;
    expect(frameOf(frameStepTarget(3 * ntsc, ntsc, 1, 0), ntsc)).toBe(4);
  });

  it('keeps a position a rounding below the anchor in the anchor frame', () => {
    // Measured on Windows CI, Firefox 156: mediaTime comes in whole microseconds, so the
    // anchor read 0.417667 while currentTime on the same frame was 0.41766666..., a third
    // of a microsecond below it. The step went to the middle of the frame on screen.
    const anchor = 0.417667;
    const d = 0.04166599999999998;
    const current = 0.4176666666666667;
    expect(frameStepTarget(current, d, 1, anchor)).toBeCloseTo(anchor + 1.5 * d, 9);
    expect(frameStepTarget(current, d, -1, anchor)).toBeCloseTo(anchor - 0.5 * d, 9);
  });
});

describe('FrameStepper', () => {
  it('learns the frame length from playback, then steps one frame at a time while paused', () => {
    const stepper = new FrameStepper();
    const video = fakeVideo();
    stepper.watch(video);
    expect(stepper.frameDuration).toBe(FALLBACK_FRAME_DURATION);

    play(video, 0, 20);
    video.emit('pause');
    expect(stepper.frameDuration).toBeCloseTo(D, 9);

    // Paused a little after frame 20 started.
    let time = 20.4 * D;
    for (const [direction, frame] of [[1, 21], [1, 22], [-1, 21], [-1, 20]]) {
      time = stepper.step(time, direction);
      expect(frameOf(time)).toBe(frame);
    }
  });

  it('steps on the grid playback showed, when frames do not start at multiples of the length', () => {
    // A stream whose first frame is at 0.52 s: the frames start at 0.52 + n/24, not at n/24.
    const offset = 0.52;
    const stepper = new FrameStepper();
    const video = fakeVideo();
    stepper.watch(video);
    video.emit('play');
    video.present(offset + 0.3 * D);
    for (let i = 1; i <= 20; i++) video.present(offset + i * D);
    video.emit('pause');

    let time = offset + 20.9 * D;
    for (const [direction, frame] of [[1, 21], [1, 22], [-1, 21]]) {
      time = stepper.step(time, direction);
      expect(frameOf(time - offset)).toBe(frame);
    }
  });

  it('ignores the frames a seek or a pause presents, which carry the seek position', () => {
    const stepper = new FrameStepper();
    const video = fakeVideo();
    stepper.watch(video);
    play(video, 0, 5);
    video.emit('pause');
    // Two paused seeks, 0.3 frames apart: not a frame length.
    video.emit('seeking');
    video.present(40.3 * D);
    video.emit('seeking');
    video.present(40.6 * D);
    expect(stepper.frameDuration).toBeCloseTo(D, 9);
    // Nor did they move the grid off frame starts.
    expect(frameOf(stepper.anchor)).toBe(5);
    expect(stepper.anchor).toBeCloseTo(5 * D, 9);
  });

  it('ignores the frame shown again when playback starts', () => {
    const stepper = new FrameStepper();
    const video = fakeVideo();
    stepper.watch(video);
    play(video, 10, 1);
    // Only one playback frame after the off-grid one: no gap measured yet.
    expect(stepper.frameDuration).toBe(FALLBACK_FRAME_DURATION);
    video.present(12 * D);
    expect(stepper.frameDuration).toBeCloseTo(D, 9);
  });

  it('does not count a gap the frame callback missed a frame in', () => {
    const stepper = new FrameStepper();
    const video = fakeVideo();
    stepper.watch(video);
    play(video, 0, 1);
    video.present(3 * D, {skipCount: 1});
    expect(stepper.frameDuration).toBe(FALLBACK_FRAME_DURATION);
  });

  it('keeps the shortest gap, so frames dropped at high speed do not stretch it', () => {
    const stepper = new FrameStepper();
    const video = fakeVideo();
    stepper.watch(video);
    play(video, 0, 3);
    video.emit('play');
    video.present(4.3 * D);
    for (let frame = 6; frame <= 30; frame += 3) video.present(frame * D);
    expect(stepper.frameDuration).toBeCloseTo(D, 9);
  });

  it('forgets the old video and its listeners when it follows another', () => {
    const stepper = new FrameStepper();
    const old = fakeVideo();
    stepper.watch(old);
    play(old, 0, 5, 1 / 60);
    expect(stepper.frameDuration).toBeCloseTo(1 / 60, 9);

    stepper.watch(fakeVideo());
    expect(stepper.frameDuration).toBe(FALLBACK_FRAME_DURATION);
    expect(stepper.anchor).toBeNull();
    expect(old.listenerCount()).toBe(0);
    // A late frame from the old video changes nothing.
    old.present(99);
    expect(stepper.anchor).toBeNull();
  });

  it('steps with the fallback length before any playback, and without requestVideoFrameCallback', () => {
    const stepper = new FrameStepper();
    stepper.watch({});
    expect(stepper.step(2, 1)).toBeCloseTo(frameStepTarget(2, FALLBACK_FRAME_DURATION, 1), 9);
  });
});
