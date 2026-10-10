export class SpeedTracker {
  constructor() {
    this.buffer = [];
    this.lastEntry = null;
    this.cutoffSize = 10000;
  }

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
    while (this.buffer.length > 2 && this.buffer[0].end < cutoff) {
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
