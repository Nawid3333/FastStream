// @ts-check
/** A gone player's buffer, kept BufferKeepMs for the next player of the same video on the same page. */

export const BufferKeepMs = 20000;

/**
 * @typedef {Object} HandedEntry
 * @property {string} url
 * @property {number} rangeStart
 * @property {number} rangeEnd
 * @property {string} responseType
 * @property {number} dataSize
 * @property {Blob} [blob]
 * @property {string} [file]
 */

/**
 * @typedef {Object} BufferHandOff
 * @property {string} url
 * @property {?string} session
 * @property {HandedEntry[]} entries
 */

/**
 * Same video, page, window kind and container: a private window's buffer must not reach the disk.
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
   * @param {(session: string) => (Promise<void>|void)} [options.dropSession]
   */
  constructor({keepMs = BufferKeepMs, dropSession = () => {}} = {}) {
    this.keepMs = keepMs;
    this.dropSession = dropSession;
    /** @type {Map<string, {handOff: BufferHandOff, timer: ReturnType<typeof setTimeout>}>} */
    this.kept = new Map();
  }

  /**
   * @param {string} key
   * @param {BufferHandOff} handOff
   */
  put(key, handOff) {
    this.flush(key, handOff.session);
    const timer = setTimeout(() => this.flush(key), this.keepMs);
    this.kept.set(key, {handOff, timer});
  }

  /**
   * @param {string} key
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
   * @param {string} key
   * @param {?string} [keepSession]
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

  /** @return {number} */
  get size() {
    return this.kept.size;
  }
}
