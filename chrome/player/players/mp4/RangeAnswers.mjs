// @ts-check

// What MP4Player learns about the file from the answer to its first range request.

/** Every range is made at once (about 150 bytes each); a longer file goes to Firefox's own player. */
export const MAX_FILE_LENGTH = 2 ** 38;

/**
 * @param {{status: number, headers: ?Object<string, string>, received: number}} answer
 * @param {{start: number, end: number}} range
 * @return {{length: number, playDirectly: boolean, tooLong?: boolean}} Length 0 when unknown; playDirectly: for Firefox's own player.
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
    // The whole file, cut to the range: all here when it ends within the range.
    const contentLength = parseInt(String(headers['content-length'] ?? ''), 10);
    const asked = range.end - range.start;
    const length = contentLength > 0 ? contentLength :
      (answer.received < asked ? range.start + answer.received : 0);
    if (length > 0 && length < range.end) {
      return {length, playDirectly: false};
    }
    // Exactly the range's length: the whole file, or a range answered 200. The next range tells.
    if (length === range.end) {
      return {length: 0, playDirectly: false};
    }
    return {length: 0, playDirectly: true};
  }
  return {length: 0, playDirectly: false};
}

/**
 * A 206 whose Content-Range starts elsewhere than asked (a cache's own range).
 * @param {{status: number, headers: ?Object<string, string>}} answer - Lower-case header names.
 * @param {number} start
 * @return {boolean}
 */
export function startsElsewhere(answer, start) {
  if (answer.status !== 206) return false;
  const match = /^bytes (\d+)-/.exec(String(answer.headers?.['content-range'] ?? ''));
  return !!match && parseInt(match[1], 10) !== start;
}
