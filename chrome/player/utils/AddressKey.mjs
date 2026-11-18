// @ts-check
// Any page can open the player with an address of its own: only one carrying this
// per-install key, which no page can read, may set faststream-headers and faststream-mode.

const StorageKey = 'playerAddressKey';
/** @type {Promise<string> | null} */
let made = null;

/**
 * The key, made once per install (the background's, for its redirect rule).
 * @return {Promise<string>}
 */
export function getAddressKey() {
  if (!made) {
    made = new Promise((resolve) => chrome.storage.local.get(StorageKey, resolve)).then((stored) => {
      const existing = stored?.[StorageKey];
      if (typeof existing === 'string' && existing) return existing;
      const key = crypto.randomUUID();
      return new Promise((resolve) => chrome.storage.local.set({[StorageKey]: key}, () => resolve(key)));
    });
    made.catch(() => {
      made = null;
    });
  }
  return made;
}

/**
 * Whether a player's address carries the key: FastStream's redirect rule opened it.
 * @param {string} search - The player's location.search.
 * @return {Promise<boolean>}
 */
export async function isAddressFromRedirect(search) {
  const key = new URLSearchParams(search).get('address');
  if (!key) return false;
  const stored = await new Promise((resolve) => chrome.storage.local.get(StorageKey, resolve));
  return stored?.[StorageKey] === key;
}
