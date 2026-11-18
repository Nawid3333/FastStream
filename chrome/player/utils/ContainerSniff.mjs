// @ts-check

// Servers and URLs can call a Matroska file video/mp4; mp4box then fails where Firefox's own
// player, which goes by the bytes, plays it.

/**
 * An MP4 starts with a box: a 32-bit size (0, 1, or at least 8), then four printable characters.
 * @param {Uint8Array} bytes - The file's first bytes.
 * @return {boolean} False when they cannot be the start of an MP4's first box; true when
 *     they can, or when fewer than 8 bytes tell nothing.
 */
export function startsLikeMp4(bytes) {
  if (bytes.length < 8) return true;
  const size = new DataView(bytes.buffer, bytes.byteOffset, 8).getUint32(0);
  if (size !== 0 && size !== 1 && size < 8) return false;
  for (let i = 4; i < 8; i++) {
    if (bytes[i] < 0x20 || bytes[i] > 0x7E) return false;
  }
  return true;
}
