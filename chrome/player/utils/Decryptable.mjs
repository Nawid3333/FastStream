// @ts-check

// Whole-segment AES-CBC only (decrypter-worker.js); SAMPLE-AES, AES-256-CTR and DRM key formats are not.
export const DECRYPTABLE_METHODS = ['AES-128', 'AES-256'];

/**
 * Whether FastStream decrypts segments under an HLS key itself. The player and the background
 * (StreamLength.hlsProtected) must share this one rule.
 * @param {string|undefined} method - The key's METHOD.
 * @param {string|undefined} keyFormat - Its KEYFORMAT ('identity' when the playlist names none).
 * @return {boolean}
 */
export function isDecryptable(method, keyFormat) {
  return keyFormat === 'identity' && DECRYPTABLE_METHODS.includes(/** @type {string} */ (method));
}
