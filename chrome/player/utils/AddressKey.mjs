// @ts-check
// A secret only FastStream's redirect rule puts into a player's address
// (player/index.html?address=<key>#<stream URL>), kept in the extension's storage, which no
// page can read. The player page is web-accessible, so any page could open it in a tab with
// an address of its own (window.open), and the player took that address's
// faststream-headers and faststream-mode: FastStream then sent the page's made-up Referer or
// Origin, with the user's cookies for that site, to the URL it named. The player takes them
// only from an address that carries the key.

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
    // A storage that failed is asked again next time.
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
