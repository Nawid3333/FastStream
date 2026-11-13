// A media element as far as MP4Player reads and sets it, for unit tests that build a real
// MP4Player (its constructor's listeners) without a page. Seeking is as Firefox does it: setting
// currentTime clamps it to the duration and starts a seek once the element has data; the events
// the element would queue are fired by the test (dispatchEvent), in the order it wants.

export class FakeMediaElement extends EventTarget {
  constructor() {
    super();
    this.time = 0;
    this.seeking = false;
    this.readyState = 2;
    this.duration = 100;
    this.paused = true;
    this.ended = false;
    /** @type {Array<[number, number]>} What is buffered, as [start, end] pairs. */
    this.ranges = [];
    this.style = {};
  }

  get buffered() {
    const ranges = this.ranges;
    return {length: ranges.length, start: (i) => ranges[i][0], end: (i) => ranges[i][1]};
  }

  get currentTime() {
    return this.time;
  }

  set currentTime(value) {
    this.time = Math.min(Math.max(0, value), Number.isFinite(this.duration) ? this.duration : Infinity);
    if (this.readyState > 0) this.seeking = true;
  }
}

/**
 * Builds a real MP4Player on a FakeMediaElement. The loop is left alone: loopTimeout null is
 * "a round is running", so a seek's wakeLoop arms nothing.
 * @param {Function} MP4Player - The class (a dynamic import of MP4Player.mjs).
 * @param {Function} stubGlobal - vitest's vi.stubGlobal: undone by vi.unstubAllGlobals.
 * @param {Object} [config] - MP4Player's (isPreview, isAudioOnly).
 * @return {{player: Object, video: FakeMediaElement}}
 */
export function playerOnFakeElement(MP4Player, stubGlobal, config) {
  const video = new FakeMediaElement();
  stubGlobal('document', {createElement: () => video});
  const player = new MP4Player({}, config);
  player.loopTimeout = null;
  return {player, video};
}
