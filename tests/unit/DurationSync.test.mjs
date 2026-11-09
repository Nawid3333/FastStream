import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DurationSync} from '../../chrome/player/players/mp4/DurationSync.mjs';
import {SourceBufferWrapper} from '../../chrome/player/players/mp4/SourceBufferWrapper.mjs';

// The MediaSource refuses a new duration while one of its SourceBuffers is updating, and
// MP4Player set it right after each append: it threw nearly every time, the element kept a
// duration far shorter than the player's, and a seek past it landed short (mp4-files.e2e,
// a seek to 250 s that played on from ~211 s).

const originalMediaSource = globalThis.MediaSource;

/** A SourceBuffer that is updating from appendBuffer/remove until updateEnd(). */
class FakeSourceBuffer extends EventTarget {
  constructor() {
    super();
    this.updating = false;
    this.appendBuffer = vi.fn(() => {
      this.updating = true;
    });
    this.remove = vi.fn(() => {
      this.updating = true;
    });
    this.abort = vi.fn();
    this.buffered = {length: 0, start: () => 0, end: () => 0};
  }

  updateEnd() {
    this.updating = false;
    this.dispatchEvent(new Event('updateend'));
  }
}

/** A MediaSource whose duration setter throws as the spec says. */
class FakeMediaSource {
  constructor() {
    this.readyState = 'open';
    /** @type {FakeSourceBuffer[]} */
    this.sourceBuffers = [];
    this._duration = NaN;
    this.durationSets = [];
  }

  addSourceBuffer() {
    const sourceBuffer = new FakeSourceBuffer();
    this.sourceBuffers.push(sourceBuffer);
    return sourceBuffer;
  }

  get duration() {
    return this._duration;
  }

  set duration(value) {
    if (this.readyState !== 'open' || this.sourceBuffers.some((sb) => sb.updating)) {
      throw new DOMException('A SourceBuffer is updating', 'InvalidStateError');
    }
    this.durationSets.push(value);
    this._duration = value;
  }
}

/** A MediaSource with a video and an audio wrapper, each applying a waiting duration on updateend. */
function setup() {
  const mediaSource = new FakeMediaSource();
  const video = new SourceBufferWrapper(mediaSource, 'video/mp4');
  const audio = new SourceBufferWrapper(mediaSource, 'audio/mp4');
  const sync = new DurationSync(() => mediaSource, () => [video, audio]);
  video.on('updateend', () => sync.apply());
  audio.on('updateend', () => sync.apply());
  return {mediaSource, video, audio, sync};
}

describe('DurationSync', () => {
  beforeEach(() => {
    globalThis.MediaSource = {isTypeSupported: () => true};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.MediaSource = originalMediaSource;
  });

  it('sets the duration at once while no SourceBuffer is updating', () => {
    const {mediaSource, sync} = setup();
    sync.set(160);
    expect(mediaSource.duration).toBe(160);
    expect(sync.pending).toBe(false);
  });

  it('sets it once the append running ends, not throwing meanwhile', () => {
    const {mediaSource, video, sync} = setup();
    video.appendBuffer(new ArrayBuffer(8), {media: true});
    expect(mediaSource.sourceBuffers[0].updating).toBe(true);

    expect(() => sync.set(268)).not.toThrow();
    expect(sync.pending).toBe(true);
    expect(mediaSource.durationSets).toEqual([]);

    mediaSource.sourceBuffers[0].updateEnd();
    expect(mediaSource.duration).toBe(268);
    expect(sync.pending).toBe(false);
  });

  it('holds both queues until it is set, so a stream of appends cannot keep it waiting', () => {
    const {mediaSource, video, audio, sync} = setup();
    const [videoSb, audioSb] = mediaSource.sourceBuffers;
    video.appendBuffer(new ArrayBuffer(1), {media: true});
    audio.appendBuffer(new ArrayBuffer(1), {media: true});
    video.appendBuffer(new ArrayBuffer(2), {media: true});
    audio.appendBuffer(new ArrayBuffer(2), {media: true});

    sync.set(300);
    // The video append ends; the audio one still runs: the video queue starts nothing more.
    videoSb.updateEnd();
    expect(videoSb.appendBuffer).toHaveBeenCalledTimes(1);
    expect(sync.pending).toBe(true);

    // Now both are idle: the duration is set, then both queues go on.
    audioSb.updateEnd();
    expect(mediaSource.durationSets).toEqual([300]);
    expect(videoSb.appendBuffer).toHaveBeenCalledTimes(2);
    expect(audioSb.appendBuffer).toHaveBeenCalledTimes(2);
    expect(video.held).toBe(false);
    expect(audio.held).toBe(false);
  });

  it('runs a callback waiting for it once it is set, and at once when none waits', () => {
    const {mediaSource, video, sync} = setup();
    const now = vi.fn();
    sync.whenApplied(now);
    expect(now).toHaveBeenCalledOnce();

    video.appendBuffer(new ArrayBuffer(8), {media: true});
    sync.set(480);
    const later = vi.fn(() => expect(mediaSource.duration).toBe(480));
    sync.whenApplied(later);
    expect(later).not.toHaveBeenCalled();
    mediaSource.sourceBuffers[0].updateEnd();
    expect(later).toHaveBeenCalledOnce();
  });

  it('lets a waiting callback go ahead when the MediaSource is no longer open', () => {
    const {mediaSource, video, sync} = setup();
    video.appendBuffer(new ArrayBuffer(8), {media: true});
    sync.set(480);
    const callback = vi.fn();
    sync.whenApplied(callback);
    mediaSource.readyState = 'closed';
    sync.apply();
    expect(callback).toHaveBeenCalledOnce();
    expect(sync.pending).toBe(false);
    expect(video.held).toBe(false);
  });

  it('warns and goes on when the MediaSource refuses the duration', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mediaSource = {
      readyState: 'open',
      set duration(value) {
        throw new DOMException('Shorter than what is buffered', 'InvalidStateError');
      },
    };
    const sync = new DurationSync(() => /** @type {any} */ (mediaSource), () => []);
    const callback = vi.fn();
    sync.set(10);
    sync.whenApplied(callback);
    expect(warn).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce();
    expect(sync.pending).toBe(false);
  });

  it('forgets a waiting duration and its callbacks on clear, releasing the queues', () => {
    const {mediaSource, video, audio, sync} = setup();
    video.appendBuffer(new ArrayBuffer(1), {media: true});
    sync.set(200);
    const callback = vi.fn();
    sync.whenApplied(callback);
    expect(audio.held).toBe(true);
    sync.clear();
    expect(audio.held).toBe(false);
    mediaSource.sourceBuffers[0].updateEnd();
    expect(callback).not.toHaveBeenCalled();
    expect(mediaSource.durationSets).toEqual([]);
  });
});
