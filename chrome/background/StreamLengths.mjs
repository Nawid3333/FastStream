import {PlayerModes} from '../player/enums/PlayerModes.mjs';
import {RequestUtils} from '../player/utils/RequestUtils.mjs';
import {PIECE_LENGTH, StreamLength} from '../player/utils/StreamLength.mjs';
import {VideoSource} from '../player/VideoSource.mjs';

// A manifest longer than this is not read whole: a three-hour film in two-second segments
// lists some 5,400 of them, well under a megabyte.
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
// What one read of a file takes: its first boxes, or the start of its movie header.
const FILE_CHUNK_BYTES = 64 * 1024;
// Reads of one file: its start, the movie header after the media data, and one spare.
const MAX_FILE_READS = 3;
// Reads of one HLS stream: the master playlist, then a variant's.
const MAX_PLAYLIST_READS = 2;
const TIMEOUT_MS = 8000;
// Streams read at once; a page of previews detects dozens.
const MAX_ACTIVE = 4;
// Lengths kept, by URL, the oldest dropped first.
const MAX_KNOWN = 300;

/**
 * How long each detected stream plays, read in the background from its manifest or from
 * the start of its file, with the headers the page's own request had. Each URL is read
 * once.
 */
export class StreamLengths {
  /**
   * @param {Object} [options]
   * @param {function(string, Object): Promise<Response>} [options.fetch] - fetch().
   * @param {function(string, Array<Object>): Promise<*>} [options.setHeaders] - Makes the
   *   background's next requests to a URL carry the page's Referer, Origin and cookies,
   *   which a fetch() cannot set: a declarativeNetRequest rule, as the player's own
   *   requests get.
   */
  constructor({fetch = (url, init) => globalThis.fetch(url, init), setHeaders = async () => {}} = {}) {
    this.fetch = fetch;
    this.setHeaders = setHeaders;
    /** @type {Map<string, {duration: (number|null|undefined), promise: Promise<number|null>}>} */
    this.known = new Map();
    this.active = 0;
    this.waiting = [];
  }

  /**
   * @param {string} url - A stream's URL.
   * @return {number|null|undefined} Its length in seconds (Infinity when live, PIECE_LENGTH
   *   for a piece of a stream), null when it cannot be told, undefined while it is not read
   *   yet.
   */
  lengthOf(url) {
    return this.known.get(url)?.duration;
  }

  /**
   * The lengths of a page's sources, as lengthOf tells them, but a file not read yet, or
   * not readable, counts as a piece of a stream when another of them was read as one and
   * has the same URL but for its numbers (seg-14.mp4, seg-15.mp4). An HLS or DASH player
   * keeps fetching pieces, and the newest, still unread when the player opens, would rank
   * as a stream of unknown length: above a short title's manifest, and as the newest, the
   * one that plays. A manifest never counts as a piece: it may share an address with them
   * (/proxy?id=123).
   * @param {Array<{url: string, mode: string}>} sources - The detected sources.
   * @return {Array<number|null|undefined>} Their lengths, in the same order.
   */
  lengthsOf(sources) {
    const pieces = new Set(sources.filter((source) => this.lengthOf(source.url) === PIECE_LENGTH)
        .map((source) => StreamLengths.shape(source.url)));
    return sources.map((source) => {
      const length = this.lengthOf(source.url);
      const file = source.mode === PlayerModes.ACCELERATED_MP4 || source.mode === PlayerModes.DIRECT;
      if (file && (length === undefined || length === null) && pieces.has(StreamLengths.shape(source.url))) {
        return PIECE_LENGTH;
      }
      return length;
    });
  }

  /**
   * What the pieces of one stream have in common: the URL, each run of digits as one 0, no
   * fragment. The query stays, so letters in it tell files apart, but numbers do not: on a
   * site that fetches everything by number through one address (/get?id=123), a film whose
   * length is still unread counts as a piece once one of the others was read as one.
   * @param {string} url - A URL.
   * @return {string} Its shape.
   */
  static shape(url) {
    return url.split('#')[0].replace(/\d+/g, '0');
  }

  /**
   * Starts reading a stream's length, unless that has started already.
   * @param {{url: string, mode: string, headers: *}} source - The detected source.
   * @return {Promise<number|null>} Its length (as lengthOf tells it), or null.
   */
  probe(source) {
    const known = this.known.get(source.url);
    if (known) {
      return known.promise;
    }

    const entry = {duration: undefined, promise: null};
    entry.promise = this.queue(() => this.read(source)).catch(() => null).then((duration) => {
      entry.duration = duration;
      return duration;
    });
    this.known.set(source.url, entry);
    if (this.known.size > MAX_KNOWN) {
      this.known.delete(this.known.keys().next().value);
    }
    return entry.promise;
  }

  /**
   * Waits until the lengths of the sources are read, those of sources detected meanwhile
   * too, or waitMs passed. An HLS or DASH player keeps fetching segments, each a source of
   * its own, and one not read yet ranks as a stream of unknown length: above a short
   * stream, and as the newest, the one that plays. The caller takes the sources right
   * after, before another can come, and their lengths from lengthsOf, which counts one
   * still unread at the deadline, or not readable, as a piece when its like was read as one.
   * @param {function(): Array<Object>} getSources - The detected sources as they are now,
   *   asked again after each wait.
   * @param {number} waitMs - The longest to wait.
   * @return {Promise<void>}
   */
  async settle(getSources, waitMs) {
    const deadline = Date.now() + waitMs;
    let sources = getSources();
    while (sources.some((source) => this.lengthOf(source.url) === undefined)) {
      const left = deadline - Date.now();
      if (left <= 0) {
        return;
      }
      let timer;
      await Promise.race([
        Promise.all(sources.map((source) => this.probe(source))),
        new Promise((resolve) => {
          timer = setTimeout(resolve, left);
        }),
      ]);
      clearTimeout(timer);
      sources = getSources();
    }
  }

  /**
   * Runs a read when fewer than MAX_ACTIVE are running.
   * @param {function(): Promise<*>} task - The read.
   * @return {Promise<*>} What it gave.
   */
  async queue(task) {
    if (this.active >= MAX_ACTIVE) {
      await new Promise((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  /**
   * Reads a source's length.
   * @param {{url: string, mode: string, headers: *}} source - The detected source.
   * @return {Promise<number|null>} Seconds (PIECE_LENGTH for a piece of a stream), or null.
   */
  async read(source) {
    if (!/^https?:\/\//i.test(source.url)) {
      return null;
    }

    // The headers the player would send, less the conditional ones: a read that copied
    // the page's If-None-Match would get a 304 and no body.
    const headers = new VideoSource(source.url, source.headers, source.mode).headers;
    for (const name of Object.keys(headers)) {
      if (name.startsWith('if-')) {
        delete headers[name];
      }
    }
    const request = RequestUtils.splitSpecialHeaders(headers);

    if (source.mode === PlayerModes.ACCELERATED_HLS) {
      let url = source.url;
      for (let read = 0; read < MAX_PLAYLIST_READS; read++) {
        const response = await this.get(url, request, null);
        const playlist = response && StreamLength.fromHls(response.text());
        if (!playlist) {
          return null;
        }
        if ('duration' in playlist) {
          return playlist.duration;
        }
        url = new URL(playlist.variant, response.url).href;
      }
      return null;
    }

    if (source.mode === PlayerModes.ACCELERATED_DASH) {
      const response = await this.get(source.url, request, null);
      return response && StreamLength.fromDash(response.text());
    }

    if (source.mode === PlayerModes.ACCELERATED_MP4 || source.mode === PlayerModes.DIRECT) {
      let offset = 0;
      for (let read = 0; read < MAX_FILE_READS; read++) {
        const response = await this.get(source.url, request, [offset, offset + FILE_CHUNK_BYTES]);
        // A server that ignores the range sends the file from its start, not the part asked
        // for, and all of it: the start is read, the rest never fetched.
        if (!response || (offset > 0 && !response.partial)) {
          return null;
        }
        // Fewer bytes than asked for: the file ends with them.
        const result = StreamLength.fromFile(response.bytes, offset, response.bytes.length < FILE_CHUNK_BYTES);
        if (!result || 'duration' in result) {
          return result ? result.duration : null;
        }
        if (result.next <= offset) {
          return null;
        }
        offset = result.next;
      }
    }
    return null;
  }

  /**
   * Fetches the start of a URL.
   * @param {string} url - What to fetch.
   * @param {{customHeaderCommands: Array<Object>, regularHeaders: Object}} request - The
   *   page's headers: those the rule sets, and the rest.
   * @param {Array<number>|null} range - The bytes to ask for, [start, end), or null for
   *   up to MAX_TEXT_BYTES from the start.
   * @return {Promise<?{bytes: Uint8Array, text: function(): string, url: string, partial: boolean}>}
   *   What came, or null for an error status.
   */
  async get(url, request, range) {
    if (request.customHeaderCommands.length > 0) {
      await this.setHeaders(url, request.customHeaderCommands);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetch(url, {
        headers: range ? {...request.regularHeaders, 'Range': `bytes=${range[0]}-${range[1] - 1}`} : request.regularHeaders,
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }
      const bytes = await StreamLengths.readAtMost(response, range ? range[1] - range[0] : MAX_TEXT_BYTES);
      return {
        bytes,
        text: () => new TextDecoder().decode(bytes),
        url: response.url || url,
        partial: response.status === 206,
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /**
   * Reads a response's body up to a limit, and no further.
   * @param {Response} response - The response.
   * @param {number} limit - The most bytes to read.
   * @return {Promise<Uint8Array>} The bytes.
   */
  static async readAtMost(response, limit) {
    if (!response.body) {
      return new Uint8Array(await response.arrayBuffer()).subarray(0, limit);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (length < limit) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      length += value.length;
    }
    reader.cancel().catch(() => {});

    const bytes = new Uint8Array(Math.min(length, limit));
    let pos = 0;
    for (const chunk of chunks) {
      const part = chunk.subarray(0, bytes.length - pos);
      bytes.set(part, pos);
      pos += part.length;
    }
    return bytes;
  }
}
