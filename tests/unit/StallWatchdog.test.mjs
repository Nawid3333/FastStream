// Firefox sometimes stops a video that says it is playing: its time stays where it is with
// minutes buffered ahead. MP4Player's StallWatchdog lets such a video sit for 2 s, then seeks
// it 0.1 s forward, then 0.2 s, then 0.3 s, at most three times until it plays on, as hls.js
// does for its streams. The e2e spec mp4-files.e2e.mjs meets the real stall now and then.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {StallWatchdog, bufferedAhead} from '../../chrome/player/players/mp4/StallWatchdog.mjs';

let clock = 0;

/**
 * Builds a TimeRanges-like object over [start, end] pairs, in seconds.
 * @param {number[][]} pairs - One [start, end] pair per buffered range.
 * @return {Object} An object with length, start(i) and end(i).
 */
function makeBuffered(pairs) {
  return {
    length: pairs.length,
    start(i) {
      return pairs[i][0];
    },
    end(i) {
      return pairs[i][1];
    },
  };
}

/**
 * Builds the fake video element the watchdog reads its state from. Assigning to currentTime
 * records the value on seeks, so seeks holds only what the watchdog did, and lands on it in
 * whole microseconds, as Firefox does; setTime() moves the time the way the element playing
 * on would, without recording a seek.
 * @param {Object} [overrides] - Values to set over the defaults.
 * @return {Object} The fake video element, with setTime() and setBuffered() helpers.
 */
function makeVideo(overrides) {
  const video = {
    paused: false,
    seeking: false,
    ended: false,
    playbackRate: 1,
    readyState: 2,
    time: 0,
    seeks: [],
    setTime(value) {
      video.time = value;
    },
    setBuffered(ranges) {
      video.buffered = makeBuffered(ranges);
    },
  };
  Object.defineProperty(video, 'currentTime', {
    get() {
      return video.time;
    },
    set(value) {
      video.time = Math.round(value * 1e6) / 1e6;
      video.seeks.push(value);
    },
  });
  if (overrides) {
    Object.assign(video, overrides);
  }
  video.buffered = makeBuffered([[59.997, 330]]);
  return video;
}

/**
 * A watchdog bound to one fake video, checked the way MP4Player's main loop checks it.
 * @param {Object} video - The fake video.
 * @return {{check: function(): void}}
 */
function makeWatchdog(video) {
  const watchdog = new StallWatchdog();
  return {check: () => watchdog.check(video)};
}

/**
 * Advances the clock by ms and runs one mainLoop-pace check.
 * @param {Object} watchdog - A watchdog from makeWatchdog().
 * @param {number} ms - How far to advance the clock.
 * @return {void}
 */
function tick(watchdog, ms) {
  clock += ms;
  watchdog.check();
}

/**
 * Ticks with mainLoop's pace until totalMs of clock have passed.
 * @param {Object} watchdog - A watchdog from makeWatchdog().
 * @param {number} totalMs - How much clock to run through.
 * @param {number} [stepMs=4] - Clock per tick.
 * @return {void}
 */
function run(watchdog, totalMs, stepMs = 4) {
  for (let passed = 0; passed < totalMs; passed += stepMs) {
    tick(watchdog, stepMs);
  }
}

describe('StallWatchdog', () => {
  beforeEach(() => {
    clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('nudges the Firefox e2e stall once, after 2 s, to 0.1 s in front of the time', () => {
    const video = makeVideo();
    video.setTime(60.159911);
    const watchdog = makeWatchdog(video);
    watchdog.check();
    run(watchdog, 1996);
    expect(video.seeks).toHaveLength(0);
    tick(watchdog, 4);
    expect(video.seeks).toHaveLength(1);
    expect(video.seeks[0]).toBeCloseTo(60.259911, 6);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('nudges 0.1 s further each time while stuck, and stops after three nudges', () => {
    const video = makeVideo();
    video.setTime(60.159911);
    const watchdog = makeWatchdog(video);
    watchdog.check();

    run(watchdog, 1996);
    tick(watchdog, 4);
    expect(video.seeks).toHaveLength(1);
    expect(video.seeks[0]).toBeCloseTo(60.259911, 6);

    tick(watchdog, 4);
    run(watchdog, 1996);
    expect(video.seeks).toHaveLength(1);
    tick(watchdog, 4);
    expect(video.seeks).toHaveLength(2);
    expect(video.seeks[1]).toBeCloseTo(60.459911, 6);

    tick(watchdog, 4);
    run(watchdog, 1996);
    expect(video.seeks).toHaveLength(2);
    tick(watchdog, 4);
    expect(video.seeks).toHaveLength(3);
    expect(video.seeks[2]).toBeCloseTo(60.759911, 6);
    expect(console.warn).toHaveBeenCalledTimes(3);

    tick(watchdog, 4);
    run(watchdog, 10000);
    expect(video.seeks).toHaveLength(3);
  });

  it('does not reset the count over the ticks the element spends seeking a nudge to', () => {
    const video = makeVideo();
    video.setTime(60.159911);
    const watchdog = makeWatchdog(video);
    watchdog.check();

    run(watchdog, 1996);
    tick(watchdog, 4);
    expect(video.seeks).toHaveLength(1);
    expect(video.seeks[0]).toBeCloseTo(60.259911, 6);

    // The element performs the seek the nudge asked for but stays stuck at the target.
    video.seeking = true;
    run(watchdog, 16);
    video.seeking = false;
    run(watchdog, 4000);
    expect(video.seeks).toHaveLength(2);
    expect(video.seeks[1]).toBeCloseTo(60.459911, 6);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('resets the count when the video plays on, so the next nudge is 0.1 s again', () => {
    const video = makeVideo();
    video.setTime(60.159911);
    const watchdog = makeWatchdog(video);
    watchdog.check();

    run(watchdog, 1996);
    tick(watchdog, 4);
    expect(video.seeks).toHaveLength(1);
    expect(video.seeks[0]).toBeCloseTo(60.259911, 6);

    let time = video.currentTime;
    for (let step = 0; step < 20; step++) {
      run(watchdog, 48);
      time += 0.05;
      video.setTime(time);
    }
    expect(video.seeks).toHaveLength(1);

    tick(watchdog, 4);
    run(watchdog, 1996);
    expect(video.seeks).toHaveLength(1);
    tick(watchdog, 4);
    expect(video.seeks).toHaveLength(2);
    expect(video.seeks[1]).toBeCloseTo(time + 0.1, 6);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('keeps counting when a nudge lands a hair off its target', () => {
    // 60.159913 + 0.1 is 60.259913000000005 in floating point, and the element lands on
    // 60.259913.
    const video = makeVideo();
    video.setTime(60.159913);
    const watchdog = makeWatchdog(video);
    watchdog.check();
    run(watchdog, 12000);
    expect(video.seeks).toHaveLength(3);
    expect(video.seeks[0]).toBeCloseTo(60.259913, 6);
    expect(video.seeks[1]).toBeCloseTo(60.459913, 6);
    expect(video.seeks[2]).toBeCloseTo(60.759913, 6);
  });

  it('nudges again after a seek elsewhere, when the count ran out before it', () => {
    const video = makeVideo();
    video.setTime(60.159911);
    const watchdog = makeWatchdog(video);
    watchdog.check();
    run(watchdog, 12000);
    expect(video.seeks).toHaveLength(3);

    // The user seeks to 100 s; the time is there while the element is still seeking.
    video.setBuffered([[99.5, 330]]);
    video.seeking = true;
    video.setTime(100);
    run(watchdog, 100);
    video.seeking = false;
    run(watchdog, 1996);
    expect(video.seeks).toHaveLength(3);
    tick(watchdog, 4);
    expect(video.seeks).toHaveLength(4);
    expect(video.seeks[3]).toBeCloseTo(100.1, 6);
  });

  it('never nudges while normal playback keeps the time advancing', () => {
    const video = makeVideo();
    video.setTime(60.159911);
    const watchdog = makeWatchdog(video);
    watchdog.check();

    let time = video.currentTime;
    for (let step = 0; step < 750; step++) {
      run(watchdog, 40);
      time += 0.04;
      video.setTime(time);
    }
    expect(video.seeks).toHaveLength(0);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['paused', {paused: true}],
    ['seeking', {seeking: true}],
    ['ended', {ended: true}],
    ['playbackRate 0', {playbackRate: 0}],
    ['readyState 1', {readyState: 1}],
  ])('does not nudge a video that is not meant to move: %s', (_state, overrides) => {
    const video = makeVideo(overrides);
    video.setTime(60.159911);
    const watchdog = makeWatchdog(video);
    watchdog.check();
    run(watchdog, 10000);
    expect(video.seeks).toHaveLength(0);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('does not nudge while waiting for media, short of a second ahead or unbuffered', () => {
    const waiting = makeVideo();
    waiting.setBuffered([[59.997, 60.9]]);
    waiting.setTime(60.159911);
    const waitingWatchdog = makeWatchdog(waiting);
    waitingWatchdog.check();
    run(waitingWatchdog, 10000);
    expect(waiting.seeks).toHaveLength(0);
    expect(console.warn).not.toHaveBeenCalled();

    const unbuffered = makeVideo();
    unbuffered.setBuffered([[0, 30]]);
    unbuffered.setTime(60.159911);
    const unbufferedWatchdog = makeWatchdog(unbuffered);
    unbufferedWatchdog.check();
    run(unbufferedWatchdog, 10000);
    expect(unbuffered.seeks).toHaveLength(0);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('starts the timer over once the video becomes able to move again', () => {
    const video = makeVideo();
    video.setTime(60.159911);
    const watchdog = makeWatchdog(video);
    watchdog.check();

    video.paused = true;
    run(watchdog, 5000);
    expect(video.seeks).toHaveLength(0);

    video.paused = false;
    expect(video.seeks).toHaveLength(0);
    run(watchdog, 1996);
    expect(video.seeks).toHaveLength(0);
    tick(watchdog, 4);
    expect(video.seeks).toHaveLength(1);
    expect(video.seeks[0]).toBeCloseTo(60.259911, 6);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('tells how far the buffered range holding a time runs past it', () => {
    const video = makeVideo();
    video.setBuffered([[0, 10], [20, 30]]);

    expect(bufferedAhead(video.buffered, 5)).toBe(5);
    expect(bufferedAhead(video.buffered, 10)).toBe(0);
    expect(bufferedAhead(video.buffered, 20)).toBe(10);
    expect(bufferedAhead(video.buffered, 15)).toBe(0);
    expect(bufferedAhead(video.buffered, 31)).toBe(0);

    video.setBuffered([]);
    expect(bufferedAhead(video.buffered, 5)).toBe(0);
  });
});
