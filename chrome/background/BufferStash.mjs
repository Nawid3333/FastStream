// @ts-check
/**
 * The buffer of a player that went away - its page reloaded, or left and came back - kept for
 * the next player of the same video on the same page, for BufferKeepMs. His wish (2026-10-28):
 * a reload must not throw away what was buffered, and what nobody takes back is let go 20 s
 * later, in RAM and on the disk alike.
 *
 * A hand-off holds the finished downloads as the player had them: the ones in RAM as their
 * Blobs (shared, not copied: 256 MB handed over in 1 ms, measured), the ones on the disk as
 * their file names in the player's OPFS session directory, which outlives its player (its
 * heartbeat stops, and other players prune it only after 60 s). The taker moves those files
 * into its own session; what is not taken is flushed: the Blobs let go of, the directory
 * deleted. Should the event page itself go first (idle), its RAM goes with it, and the
 * directory waits for that prune.
 */

/** How long a hand-off is kept for the next player. */
export const BufferKeepMs = 20000;

/**
 * One finished download, as a player hands it over: a plain record, its data a Blob in RAM or
 * the name of its file in the session directory.
 * @typedef {Object} HandedEntry
 * @property {string} url
 * @property {number} rangeStart
 * @property {number} rangeEnd
 * @property {string} responseType
 * @property {number} dataSize
 * @property {Blob} [blob] - In RAM.
 * @property {string} [file] - On the disk: its name in the session directory.
 */

/**
 * @typedef {Object} BufferHandOff
 * @property {string} url - The source's URL as the player had it.
 * @property {?string} session - The player's OPFS session directory, which the files are in.
 * @property {HandedEntry[]} entries
 */

/**
 * Where a hand-off may be taken back: the same video on the same page, in the same kind of
 * window and container. A private window's buffer is RAM only, and a player of an ordinary
 * window would write it to the disk; a container's stays with it.
 * @param {{pageUrl: string, identifier: string, incognito: boolean, cookieStoreId?: ?string}} where
 * @return {string}
 */
export function bufferKey({pageUrl, identifier, incognito, cookieStoreId}) {
  return JSON.stringify([incognito ? 1 : 0, cookieStoreId || '', pageUrl, identifier]);
}

export class BufferStash {
  /**
   * @param {Object} [options]
   * @param {number} [options.keepMs]
   * @param {(session: string) => (Promise<void>|void)} [options.dropSession] - Deletes a
   *   session directory nobody took.
   */
  constructor({keepMs = BufferKeepMs, dropSession = () => {}} = {}) {
    this.keepMs = keepMs;
    this.dropSession = dropSession;
    /** @type {Map<string, {handOff: BufferHandOff, timer: ReturnType<typeof setTimeout>}>} */
    this.kept = new Map();
  }

  /**
   * Keeps a hand-off under its key until it is taken or BufferKeepMs is over. An older one under
   * the same key is flushed: the page reloaded again before a player took it.
   * @param {string} key - bufferKey.
   * @param {BufferHandOff} handOff
   */
  put(key, handOff) {
    this.flush(key, handOff.session);
    const timer = setTimeout(() => this.flush(key), this.keepMs);
    this.kept.set(key, {handOff, timer});
  }

  /**
   * The hand-off kept under a key, kept no longer: its taker has its data now.
   * @param {string} key - bufferKey.
   * @return {?BufferHandOff}
   */
  take(key) {
    const kept = this.kept.get(key);
    if (!kept) return null;
    clearTimeout(kept.timer);
    this.kept.delete(key);
    return kept.handOff;
  }

  /**
   * Lets a hand-off go: its Blobs to the garbage collector, its directory deleted.
   * @param {string} key - bufferKey.
   * @param {?string} [keepSession] - A directory a newer hand-off of the same key still names.
   */
  flush(key, keepSession = null) {
    const kept = this.kept.get(key);
    if (!kept) return;
    clearTimeout(kept.timer);
    this.kept.delete(key);
    const session = kept.handOff.session;
    if (session && session !== keepSession) {
      Promise.resolve()
          .then(() => this.dropSession(session))
          .catch((e) => console.warn('Could not delete a handed-over buffer\'s files', e));
    }
  }

  /** @return {number} The hand-offs kept now. */
  get size() {
    return this.kept.size;
  }
}
