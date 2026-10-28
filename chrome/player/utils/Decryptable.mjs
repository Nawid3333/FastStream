// @ts-check

// The encryption FastStream decrypts itself (decrypter-worker.js: AES-CBC, the key's own
// bytes): whole segments under an AES-128 or AES-256 key the playlist names. hls.js also
// hands out decryptdata for SAMPLE-AES, where only the samples are encrypted, for
// AES-256-CTR, and for the DRM key formats (Widevine, PlayReady, FairPlay); decrypting
// those as whole AES-CBC segments gave garbage or nothing, and a generic load error
// instead of the DRM message.
export const DECRYPTABLE_METHODS = ['AES-128', 'AES-256'];

/**
 * Whether FastStream decrypts segments under an HLS key itself. The player, which takes the
 * decryption over from hls.js (HLSFragmentRequester.takeOverDecryption), and the background,
 * which reads the playlist before a player opens (StreamLength.hlsProtected), ask this one
 * rule: decided apart, a playlist one of them took for DRM and the other did not either
 * kept the page from a player that plays it, or gave it one that plays nothing.
 * @param {string|undefined} method - The key's METHOD.
 * @param {string|undefined} keyFormat - Its KEYFORMAT ('identity' when the playlist names none).
 * @return {boolean}
 */
export function isDecryptable(method, keyFormat) {
  return keyFormat === 'identity' && DECRYPTABLE_METHODS.includes(/** @type {string} */ (method));
}
