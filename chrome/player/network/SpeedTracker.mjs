// @ts-check
export class SpeedTracker {
  constructor() {
    /** @type {Array<{dataSize: number, start: number, end: number}>} */
    this.buffer = [];
    /** @type {{dataSize: number, start: number, end: number} | null} */
    this.lastEntry = null;
    this.cutoffSize = 10000;
  }

  /**
  * @param {number} dataSize
  * @param {number} start
  * @param {number} end
  */
  update(dataSize, start, end) {
    if (this.lastEntry?.start === start) {
      this.lastEntry.dataSize = dataSize;
      this.lastEntry.end = end;
      return;
    }

    const entry = {dataSize, start, end};
    this.buffer.push(entry);
    this.lastEntry = entry;
    this.prune();
  }

  prune() {
    const cutoff = performance.now() - this.cutoffSize;
    // Two old entries stay while nothing new came (getSpeed reads them as 0), but not past
    // new data: the first download after a lull was counted over the whole lull, minutes,
    // and read as a few KB/s (glm's second look, 2026-10-13).
    const fresh = this.buffer.length > 0 && this.buffer[this.buffer.length - 1].end >= cutoff;
    const keep = fresh ? 1 : 2;
    while (this.buffer.length > keep && this.buffer[0].end < cutoff) {
      this.buffer.shift();
    }
  }

  getSpeed() {
    this.prune();
    if (this.buffer.length === 0) return 0;
    // Nothing came for the whole window: the two entries prune() keeps were counted over an
    // ever longer time, a speed that never reached 0 once the downloads had stopped.
    if (this.buffer[this.buffer.length - 1].end < performance.now() - this.cutoffSize) return 0;
    let totalData = 0;
    this.buffer.forEach((entry) => {
      totalData += entry.dataSize;
    });

    const now = performance.now();
    const dt = (now - this.buffer[0].start) / 1000;
    // A response that came within the clock's tick (a cache hit) gave Infinity: the shown
    // speed, which smooths over what it is given, said Infinity for the rest of the
    // session, and the speed limit held predownloading back meanwhile.
    if (dt <= 0) return 0;
    return totalData / dt;
  }
}
