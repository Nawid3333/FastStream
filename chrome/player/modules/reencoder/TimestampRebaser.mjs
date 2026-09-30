/**
 * Moves every track's timestamps back by one amount, so the file starts at zero and the
 * tracks keep their offset to each other.
 *
 * A save can start mid-stream: its first video frame at 8.333 s, say, and its first audio
 * frame at 5.999 s. Both then move back by 5.999 s, the smaller of the two, so audio starts
 * at 0 and video 2.334 s later, as they played. mp4-muxer did this itself
 * (firstTimestampBehavior: 'cross-track-offset'); Mediabunny keeps a fragmented MP4's
 * timestamps as they come, so the re-encoder does it here.
 *
 * The amount is known only once every track has sent its first packet, so the packets that
 * come before that wait here. A track that never sends one holds nothing back after flush().
 *
 * Imports nothing, so tests/unit/TimestampRebaser.test.mjs can run it without a browser.
 */
export class TimestampRebaser {
  /**
   * @param {string[]} tracks the tracks that will send packets
   * @param {function(string, number, *): void} emit gets each packet's track, its moved
   *     timestamp and the item push() was given, in the order push() was called
   */
  constructor(tracks, emit) {
    // Each track's first timestamp; null until its first packet.
    this.firsts = new Map(tracks.map((track) => [track, null]));
    this.emit = emit;
    this.held = [];
    this.offset = null;
  }

  /**
   * Passes a packet on, moved back, or holds it until the amount is known.
   * @param {string} track one of the tracks given to the constructor
   * @param {number} timestamp the packet's timestamp
   * @param {*} item handed to emit with it
   */
  push(track, timestamp, item) {
    if (!this.firsts.has(track)) {
      throw new Error(`TimestampRebaser: unknown track ${track}`);
    }
    if (this.offset !== null) {
      this.emit(track, timestamp - this.offset, item);
      return;
    }
    if (this.firsts.get(track) === null) {
      this.firsts.set(track, timestamp);
    }
    this.held.push({track, timestamp, item});
    if ([...this.firsts.values()].every((first) => first !== null)) {
      this.release();
    }
  }

  /**
   * Passes on what is held, for when no more packets will come: a track that never sent one
   * no longer counts.
   */
  flush() {
    if (this.offset === null) {
      this.release();
    }
  }

  /**
   * Fixes the amount from the first timestamps seen and passes on what was held.
   */
  release() {
    const firsts = [...this.firsts.values()].filter((first) => first !== null);
    this.offset = firsts.length ? Math.min(...firsts) : 0;
    const held = this.held;
    this.held = [];
    for (const {track, timestamp, item} of held) {
      this.emit(track, timestamp - this.offset, item);
    }
  }
}
