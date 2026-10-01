// What the e2e test servers (wdio.conf.mjs, wdio.extension.conf.mjs) share: the request's
// path, its Range header, and sending a file. Neither server may go down on one bad
// request: a throw in a request listener, or a read stream's unhandled 'error', ends the
// whole test run.

import fs from 'node:fs';

/**
 * The request path, %-escapes decoded.
 * @param {string} rawPath - The URL's path, without its query.
 * @return {?string} The path, or null for a malformed escape (decodeURIComponent throws on
 *   '%zz'), which the server answers with 400.
 */
export function decodePath(rawPath) {
  try {
    return decodeURIComponent(rawPath);
  } catch (e) {
    return null;
  }
}

/**
 * The byte range a Range header asks for (RFC 9110, 14.1.2).
 * @param {string|undefined} header - The Range header.
 * @param {number} size - The file's size.
 * @return {?({start: number, end: number}|'unsatisfiable')} Null when the header is missing
 *   or is not one range of bytes: the whole file is sent, as a server ignoring Range does.
 */
export function byteRange(header, size) {
  if (!header) {
    return null;
  }
  const value = header.trim();
  const suffix = /^bytes=-(\d+)$/.exec(value);
  if (suffix) {
    // The last N bytes: all of a shorter file, none for N = 0.
    const length = parseInt(suffix[1], 10);
    if (length === 0 || size === 0) {
      return 'unsatisfiable';
    }
    return {start: Math.max(0, size - length), end: size - 1};
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) {
    return null;
  }
  const start = parseInt(match[1], 10);
  // An end past the last byte is clamped, not rejected. FastStream asks for ranges that
  // overshoot the file's end, and answering those with 416 broke the MP4 path with "First
  // fragment failed to load", which reads like a decoder fault and is not.
  const end = Math.min(match[2] ? parseInt(match[2], 10) : size - 1, size - 1);
  if (start >= size || start > end) {
    return 'unsatisfiable';
  }
  return {start, end};
}

/**
 * Sends a file, or part of it, as the response body. A read that fails ends the response
 * instead of the process: 'error' does not travel along pipe().
 * @param {import('node:http').ServerResponse} res - The response, its head written.
 * @param {string} file - The file.
 * @param {{start: number, end: number}} [range] - Which bytes.
 * @return {void}
 */
export function sendFile(res, file, range) {
  const stream = fs.createReadStream(file, range);
  stream.on('error', (e) => {
    // The path is JSON-quoted so control characters cannot forge extra log lines
    // (CodeQL js/log-injection).
    console.error(`test server: could not read ${JSON.stringify(file)}: ${e.message}`);
    res.destroy();
  });
  stream.pipe(res);
}
