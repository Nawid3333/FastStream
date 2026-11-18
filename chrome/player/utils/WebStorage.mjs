// @ts-check
// The page's localStorage and sessionStorage, which Firefox may refuse: null with
// dom.storage.enabled off, a throw on a storage error. A refused read is nothing, a refused
// write is lost; the player goes on either way.

/**
 * @param {'local'|'session'} area
 * @return {?Storage}
 */
function storageOf(area) {
  return area === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
}

export const WebStorage = {
  /**
   * @param {'local'|'session'} area
   * @param {string} key
   * @return {?string}
   */
  get(area, key) {
    try {
      return storageOf(area)?.getItem(key) ?? null;
    } catch (e) {
      return null;
    }
  },

  /**
   * @param {'local'|'session'} area
   * @param {string} key
   * @param {string} value
   */
  set(area, key, value) {
    try {
      storageOf(area)?.setItem(key, value);
    } catch (e) {
      // Refused: not kept.
    }
  },

  /**
   * @param {'local'|'session'} area
   * @param {string} key
   */
  remove(area, key) {
    try {
      storageOf(area)?.removeItem(key);
    } catch (e) {
      // Refused: nothing to remove.
    }
  },
};
