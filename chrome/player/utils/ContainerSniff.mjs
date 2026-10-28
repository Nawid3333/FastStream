// @ts-check

// Whether a file's first bytes can be an MP4's (ISO BMFF, QuickTime), the only files
// MP4Player's mp4box reads. A server and a URL can call a file video/mp4 and .mp4 when it
// is not one: a hoster's Matroska file came as both, mp4box stopped at its first bytes
// ("Invalid data found while parsing box of type '£B'"), and the player failed on a file
// the page's own <video> played. Firefox's own player goes by what the bytes are, so
// MP4Player hands it a file that is no MP4 (playDirectly).
//
// An MP4 is a row of boxes. Each starts with its size, 32 bits (0: to the file's end; 1: a
// 64-bit size follows the type; else at least the box head's 8 bytes), then its type: four
// printable characters ("ftyp", "moov", "mdat", "free", "wide", "pnot"...). The start of
// every other format breaks that: Matroska's and WebM's EBML magic 1A 45 DF A3 is followed
// by bytes no type has, and so are Ogg's "OggS", FLAC's "fLaC", MP3's ID3 tag, WAV's RIFF
// size, FLV's flags and MPEG-TS's packet header.

/**
 * @param {Uint8Array} bytes - The file's first bytes.
 * @return {boolean} False when they cannot be the start of an MP4's first box; true when
 *     they can, or when fewer than its 8 bytes tell nothing.
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
