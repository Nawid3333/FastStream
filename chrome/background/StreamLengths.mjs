// @ts-check
import {PlayerModes} from '../player/enums/PlayerModes.mjs';
import {RequestUtils} from '../player/utils/RequestUtils.mjs';
import {PIECE_LENGTH, StreamLength} from '../player/utils/StreamLength.mjs';
import {VideoSource, sourceHeadersFor} from '../player/VideoSource.mjs';

// A three-hour film in two-second segments lists some 5,400 of them, well under a megabyte.
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
const MAX_KNOWN = 300;

/**
 * @typedef {{variants: Array<{url: string, bandwidth: number, height: number}>, renditions: boolean,
 *   media: Array<string>}} MasterInfo
 */

/** Each detected stream's length, read from its manifest or its file's start, with the page's request headers. */
export class StreamLengths {
  /**
   * @param {Object} [options]
   * @param {(url: string, init: *) => Promise<Response>} [options.fetch]
   * @param {(url: string, commands: FSHeaderCommand[]) => Promise<unknown>} [options.setHeaders]
   */
  constructor({fetch = (url, init) => globalThis.fetch(url, init), setHeaders = async () => {}} = {}) {
    this.fetch = fetch;
    this.setHeaders = setHeaders;
    /** @type {Map<string, {duration: (number|null|undefined), promise: Promise<number|null>, answered: Promise<void>}>} */
    this.known = new Map();
    /** @type {Set<string>} */
    this.protectedUrls = new Set();
    /** @type {Set<string>} */
    this.webPageUrls = new Set();
    /** @type {Map<string, MasterInfo>} */
    this.masters = new Map();
    /** @type {Map<string, string>} */
    this.masterOf = new Map();
    this.active = 0;
    /** @type {Array<() => void>} */
    this.waiting = [];
  }

  /**
   * list null for fewer than two heights, or for a master with audio or subtitles of its own: a variant alone goes without them.
   * @param {string} url
   * @return {?{master: string, list: ?Array<{url: string, label: string, height: number}>}}
   */
  hlsQualities(url) {
    const master = this.masters.has(url) ? url : this.masterOf.get(url);
    const info = master && this.masters.get(master);
    if (!master || !info) {
      return null;
    }
    /** @type {Map<number, {url: string, bandwidth: number, height: number}>} */
    const byHeight = new Map();
    for (const variant of info.variants) {
      if (variant.height <= 0) continue;
      const kept = byHeight.get(variant.height);
      if (!kept || variant.bandwidth > kept.bandwidth) {
        byHeight.set(variant.height, variant);
      }
    }
    if (info.renditions || byHeight.size < 2) {
      return {master, list: null};
    }
    const list = [...byHeight.values()].sort((a, b) => b.height - a.height)
        .map((variant) => ({url: variant.url, label: variant.height + 'p', height: variant.height}));
    return {master, list};
  }

  /**
   * An audio or subtitles playlist goes as its master: alone, it played sound and no picture in mpv.
   * @param {string} master
   * @param {string} text
   * @param {string} base
   */
  noteMaster(master, text, base) {
    const parsed = StreamLength.hlsVariants(text);
    if (!parsed) {
      return;
    }
    const variants = [];
    for (const variant of parsed.variants) {
      try {
        variants.push({url: new URL(variant.uri, base).href, bandwidth: variant.bandwidth, height: variant.height});
      } catch (e) {
        // No URL: left out.
      }
    }
    const media = [];
    for (const uri of parsed.media) {
      try {
        media.push(new URL(uri, base).href);
      } catch (e) {
        // No URL: left out.
      }
    }
    this.masters.set(master, {variants, renditions: parsed.renditions, media});
    for (const url of [...variants.map((variant) => variant.url), ...media]) {
      this.masterOf.set(url, master);
    }
    if (this.masters.size > MAX_KNOWN) {
      const [oldest, info] = /** @type {[string, MasterInfo]} */ (this.masters.entries().next().value);
      this.masters.delete(oldest);
      for (const url of [...info.variants.map((variant) => variant.url), ...info.media]) {
        if (this.masterOf.get(url) === oldest) this.masterOf.delete(url);
      }
    }
  }

  /**
   * Infinity when live, PIECE_LENGTH for a piece of a stream, null when unknown, undefined while unread.
   * @param {string} url
   * @return {number|null|undefined}
   */
  lengthOf(url) {
    return this.known.get(url)?.duration;
  }

  /**
   * Neither FastStream nor mpv plays a DRM stream; the page's own player does.
   * @param {string} url
   * @return {boolean}
   */
  isProtected(url) {
    return this.protectedUrls.has(url);
  }

  /**
   * Not for a URL forgotten while it was read (MAX_KNOWN): nothing would forget its mark.
   * @param {string} url
   * @param {boolean} copyProtected
   */
  noteProtection(url, copyProtected) {
    if (copyProtected && this.known.has(url)) {
      this.protectedUrls.add(url);
    } else {
      this.protectedUrls.delete(url);
    }
  }

  /**
   * A 2xx text/html for a file (abyss.to: only the page's service worker gives the video). Never for a manifest.
   * @param {string} url
   * @param {number} waitMs
   * @return {Promise<boolean>}
   */
  async servesWebPage(url, waitMs) {
    const known = this.known.get(url);
    if (!known) {
      return false;
    }
    let timer;
    await Promise.race([
      known.answered,
      new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
    return this.webPageUrls.has(url);
  }

  /**
   * @param {string} url
   * @param {boolean} webPage
   */
  noteWebPage(url, webPage) {
    if (webPage && this.known.has(url)) {
      this.webPageUrls.add(url);
    } else {
      this.webPageUrls.delete(url);
    }
  }

  /**
   * An unread or unreadable file counts as a piece when one of its shape was read as one; a manifest never does.
   * @param {Array<{url: string, mode: string}>} sources
   * @return {Array<number|null|undefined>}
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
   * The URL with each run of digits as one 0, without its fragment.
   * @param {string} url
   * @return {string}
   */
  static shape(url) {
    return url.split('#')[0].replace(/\d+/g, '0');
  }

  /**
   * @param {{url: string, mode: string, headers: *}} source
   * @return {Promise<number|null>}
   */
  probe(source) {
    const known = this.known.get(source.url);
    if (known) {
      return known.promise;
    }

    // Settles at the read's first answer, or at its end: servesWebPage waits for it.
    /** @type {() => void} */
    let answered = () => {};
    /** @type {{duration: number|null|undefined, promise: *, answered: Promise<void>}} */
    const entry = {duration: undefined, promise: null, answered: new Promise((resolve) => {
      answered = () => resolve(undefined);
    })};
    entry.promise = this.queue(() => this.read(source, answered)).catch(() => null).then((duration) => {
      entry.duration = duration;
      answered();
      return duration;
    });
    this.known.set(source.url, entry);
    if (this.known.size > MAX_KNOWN) {
      const oldest = /** @type {string} */ (this.known.keys().next().value);
      this.known.delete(oldest);
      this.protectedUrls.delete(oldest);
      this.webPageUrls.delete(oldest);
    }
    return entry.promise;
  }

  /**
   * An unread segment would rank as a stream of unknown length, above a short stream; of each piece shape only the newest is waited for.
   * @param {() => Array<{url: string, mode: string, headers: *}>} getSources
   * @param {number} waitMs
   * @return {Promise<void>}
   */
  async settle(getSources, waitMs) {
    const deadline = Date.now() + waitMs;
    let unread = this.unreadOf(getSources());
    while (unread.length > 0) {
      const left = deadline - Date.now();
      if (left <= 0) {
        return;
      }
      let timer;
      await Promise.race([
        Promise.all(unread.map((source) => this.probe(source))),
        new Promise((resolve) => {
          timer = setTimeout(resolve, left);
        }),
      ]);
      clearTimeout(timer);
      unread = this.unreadOf(getSources());
    }
  }

  /**
   * @template {{url: string, mode: string}} T
   * @param {Array<T>} sources
   * @return {Array<T>}
   */
  unreadOf(sources) {
    const pieces = new Set(sources.filter((source) => this.lengthOf(source.url) === PIECE_LENGTH)
        .map((source) => StreamLengths.shape(source.url)));
    /** @type {(source: T) => boolean} */
    const like = (source) => pieces.has(StreamLengths.shape(source.url)) &&
      (source.mode === PlayerModes.ACCELERATED_MP4 || source.mode === PlayerModes.DIRECT);
    /** @type {Map<string, T>} */
    const newest = new Map();
    for (const source of sources) {
      if (like(source)) newest.set(StreamLengths.shape(source.url), source);
    }
    return sources.filter((source) => this.lengthOf(source.url) === undefined &&
      (!like(source) || newest.get(StreamLengths.shape(source.url)) === source));
  }

  /**
   * @param {() => Promise<*>} task
   * @return {Promise<*>}
   */
  async queue(task) {
    if (this.active >= MAX_ACTIVE) {
      // A finishing read hands its slot over: woken, this one already counts.
      await new Promise((resolve) => this.waiting.push(/** @type {() => void} */ (resolve)));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.active--;
      }
    }
  }

  /**
   * @param {{url: string, mode: string, headers: *}} source
   * @param {() => void} [answered]
   * @return {Promise<number|null>}
   */
  async read(source, answered = () => {}) {
    if (!/^https?:\/\//i.test(source.url)) {
      return null;
    }

    // Less the conditional headers: a copied If-None-Match would get a 304 and no body.
    const headers = /** @type {Record<string, string>} */ (new VideoSource(source.url, source.headers, source.mode).headers);
    for (const name of Object.keys(headers)) {
      if (name.startsWith('if-')) {
        delete headers[name];
      }
    }
    const request = RequestUtils.splitSpecialHeaders(headers);

    if (source.mode === PlayerModes.ACCELERATED_HLS) {
      let url = source.url;
      for (let read = 0; read < MAX_PLAYLIST_READS; read++) {
        const response = await this.get(url, RequestUtils.splitSpecialHeaders(sourceHeadersFor({url: source.url, headers}, url)), null);
        if (!response) {
          return null;
        }
        const text = response.text();
        const playlist = StreamLength.fromHls(text);
        if (!playlist) {
          return null;
        }
        if ('duration' in playlist) {
          // Its keys tell whether its segments are copy-protected; the master names none.
          this.noteProtection(source.url, StreamLength.hlsProtected(text));
          return playlist.duration;
        }
        if (read === 0) {
          this.noteMaster(source.url, text, response.url);
        }
        url = new URL(playlist.variant, response.url).href;
      }
      return null;
    }

    if (source.mode === PlayerModes.ACCELERATED_DASH) {
      const response = await this.get(source.url, request, null);
      if (!response) {
        return null;
      }
      const text = response.text();
      this.noteProtection(source.url, StreamLength.dashProtected(text));
      return StreamLength.fromDash(text);
    }

    if (source.mode === PlayerModes.ACCELERATED_MP4 || source.mode === PlayerModes.DIRECT) {
      let offset = 0;
      for (let read = 0; read < MAX_FILE_READS; read++) {
        const response = await this.get(source.url, request, [offset, offset + FILE_CHUNK_BYTES]);
        if (read === 0) {
          const webPage = !!response && /^text\/html\b/i.test(response.contentType);
          this.noteWebPage(source.url, webPage);
          answered();
          if (webPage) {
            return null;
          }
        }
        // A server that ignores the range sends the whole file: the start is read, the rest never fetched.
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
   * @param {string} url
   * @param {ReturnType<typeof RequestUtils.splitSpecialHeaders>} request
   * @param {Array<number>|null} range
   * @return {Promise<{bytes: Uint8Array, text: () => string, url: string, partial: boolean, contentType: string}|null>}
   */
  async get(url, request, range) {
    if (request.customHeaderCommands.length > 0) {
      try {
        await this.setHeaders(url, request.customHeaderCommands);
      } catch (e) {
        console.warn('Header rule refused', e);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetch(url, {
        headers: range ? {...request.regularHeaders, 'Range': `bytes=${range[0]}-${range[1] - 1}`} : request.regularHeaders,
        credentials: 'omit',
        // Not kept in the cache: the page may be in a private window, and this request is not.
        cache: 'no-store',
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
        contentType: response.headers.get('content-type') || '',
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /**
   * @param {Response} response
   * @param {number} limit
   * @return {Promise<Uint8Array>}
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
