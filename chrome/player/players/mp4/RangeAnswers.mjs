// @ts-check

// What MP4Player learns about the file from the answer to its first range request. It loads an
// MP4 in 1 MB ranges and needs the file's length to make them, read from Content-Range
// ("bytes 0-999999/123456789").
//
// A server that ignores Range answers 200 with the whole file; FetchLoader cuts the range out
// and stops reading there. Every later range then downloaded the file from byte 0 again up to
// its end: a 2 GB file in 1 MB ranges is about 2 TB. Unless the whole file came in that first
// answer, Firefox's own player plays such a source: it reads the file once.
//
// A 206 without Content-Range (a broken server or proxy) tells no length. A regular MP4's
// length comes from its sample table, but a fragmented file's only from the fragments parsed so
// far: the stream was ended after the first range, or failed with "No content range". MP4Player
// reads such a file on, range by range, until a range comes back short. (Firefox's own player
// refuses a 206 without Content-Range: it is no way out there.)

/**
 * The longest file MP4Player loads in ranges, in bytes: 256 GiB, 274,878 of its 1 MB ranges.
 * It makes every range as soon as it knows the file's length, at once: about 150 bytes each, so
 * about 40 MB and 30 ms at this length (measured in Node). A Content-Range that said 2^53 bytes
 * made nine billion of them, and the player's page hung - and every add-on with it: Firefox runs
 * the pages of all add-ons in one process. A real video file is shorter (a UHD Blu-ray copy is
 * about 100 GB, a day of 4K at 20 Mbit/s 216 GB); a longer one goes to Firefox's own player,
 * which reads it itself.
 */
export const MAX_FILE_LENGTH = 2 ** 38;

/**
 * The file's length from the first answer, and whether MP4Player can load it in ranges.
 * @param {{status: number, headers: ?Object<string, string>, received: number}} answer - The
 *     HTTP status, the response headers (lower-case names) and the bytes received for the range.
 * @param {{start: number, end: number}} range - The range asked for (end exclusive).
 * @return {{length: number, playDirectly: boolean, tooLong?: boolean}} length: the file's length,
 *     0 when unknown; playDirectly: hand the source to Firefox's own player; tooLong: because the
 *     file is longer than MAX_FILE_LENGTH.
 */
export function lengthFromAnswer(answer, range) {
  const headers = answer.headers || {};
  const total = parseInt(String(headers['content-range'] || '').split('/')[1], 10);
  if (total > MAX_FILE_LENGTH) {
    return {length: 0, playDirectly: true, tooLong: true};
  }
  if (total > 0) {
    return {length: total, playDirectly: false};
  }
  if (answer.status === 200) {
    // The whole file, cut to the range. It is all here when it ends within the range: by its
    // Content-Length, or (no Content-Length, a chunked answer) by fewer bytes than asked for.
    const contentLength = parseInt(String(headers['content-length'] ?? ''), 10);
    const asked = range.end - range.start;
    const length = contentLength > 0 ? contentLength :
      (answer.received < asked ? range.start + answer.received : 0);
    if (length > 0 && length < range.end) {
      return {length, playDirectly: false};
    }
    // Exactly as long as the range: the whole file, or the range a server answered with 200.
    // MP4Player reads on, range by range: the next one tells.
    if (length === range.end) {
      return {length: 0, playDirectly: false};
    }
    return {length: 0, playDirectly: true};
  }
  return {length: 0, playDirectly: false};
}
