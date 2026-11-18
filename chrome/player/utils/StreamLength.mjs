// @ts-check

// How long a stream plays, from its manifest or its file's start, and the pick among a page's
// streams by it: an ad runs for seconds, the video for minutes. Pure: background/StreamLengths.mjs
// reads the bytes.

import {isDecryptable} from './Decryptable.mjs';

// An unread length ranks above a known-short stream (an ad), below a known film or episode.
export const UNKNOWN_LENGTH_S = 10 * 60;

// An init or media segment: ranks below every stream, so a manifest wins over its own pieces.
export const PIECE_LENGTH = -1;

// A thumbnail or keyframe playlist (IMAGES-ONLY, I-FRAMES-ONLY): it ties with the video by
// length and pages often load it first, so it ranks below every stream and never plays.
export const STILLS_LENGTH = -2;

// Two formats of one video differ by seconds, two episodes by minutes, an ad and the video by far more.
const TIE_SHARE = 0.9;

const MP4_FIRST_BOXES = ['ftyp', 'styp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pdin', 'uuid',
  'sidx', 'emsg', 'prft', 'moof'];

// The most an mvhd box takes (version 1).
const MVHD_MAX_BYTES = 120;

const EBML_MAGIC = 0x1A45DFA3;
const EBML_SEGMENT = 0x18538067;
const EBML_INFO = 0x1549A966;
const EBML_TIMECODE_SCALE = 0x2AD7B1;
const EBML_DURATION = 0x4489;
const EBML_TRACKS = 0x1654AE6B;
const EBML_CLUSTER = 0x1F43B675;

export class StreamLength {
  /**
   * @param {string} text - The playlist.
   * @return {{duration: number}|{variant: string}|null} A media playlist's length in seconds
   *   (Infinity while live); a master playlist's first variant, as written in it; or null.
   */
  static fromHls(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim());
    const first = lines.findIndex((line) => line !== '');
    if (first === -1 || !lines[first].startsWith('#EXTM3U')) {
      return null;
    }

    let duration = 0;
    let segments = 0;
    let ended = false;
    let vod = false;
    for (let i = first + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === '#EXT-X-IMAGES-ONLY' || line === '#EXT-X-I-FRAMES-ONLY') {
        return {duration: STILLS_LENGTH};
      }
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const uri = lines.slice(i + 1).find((next) => next !== '' && !next.startsWith('#'));
        return uri ? {variant: uri} : null;
      }
      if (line.startsWith('#EXTINF:')) {
        const value = parseFloat(line.slice('#EXTINF:'.length));
        if (Number.isFinite(value) && value > 0) {
          duration += value;
          segments++;
        }
      } else if (line === '#EXT-X-ENDLIST') {
        ended = true;
      } else if (/^#EXT-X-PLAYLIST-TYPE:\s*VOD$/i.test(line)) {
        vod = true;
      }
    }

    if (segments === 0) {
      return null;
    }
    return {duration: ended || vod ? duration : Infinity};
  }

  /**
   * @param {string} text - The playlist.
   * @return {?{variants: Array<{uri: string, bandwidth: number, height: number}>,
   *   renditions: boolean, media: Array<string>}} height 0 when it names none; renditions:
   *   EXT-X-MEDIA with a URI, which a variant played alone goes without. Null for no master playlist.
   */
  static hlsVariants(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim());
    const first = lines.findIndex((line) => line !== '');
    if (first === -1 || !lines[first].startsWith('#EXTM3U')) {
      return null;
    }

    const variants = [];
    /** @type {Array<string>} */
    const media = [];
    let renditions = false;
    // Tags before the same URI share one search for it: a crafted playlist must not be quadratic.
    let uriLine = -1;
    for (let i = first + 1; i < lines.length; i++) {
      const line = lines[i];
      const mediaAttributes = line.startsWith('#EXT-X-MEDIA:') ? line.slice('#EXT-X-MEDIA:'.length) : null;
      if (mediaAttributes !== null && /(^|,)\s*URI\s*=/i.test(mediaAttributes)) {
        renditions = true;
        const uri = /(?:^|,)\s*URI\s*=\s*"([^"]+)"/i.exec(mediaAttributes)?.[1];
        if (uri) media.push(uri);
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        if (uriLine <= i) {
          uriLine = i + 1;
          while (uriLine < lines.length && (lines[uriLine] === '' || lines[uriLine].startsWith('#'))) {
            uriLine++;
          }
        }
        const uri = lines[uriLine];
        if (!uri) continue;
        const attributes = line.slice('#EXT-X-STREAM-INF:'.length);
        const bandwidth = Number(/(?:^|,)\s*BANDWIDTH\s*=\s*(\d+)/i.exec(attributes)?.[1]) || 0;
        const height = Number(/(?:^|,)\s*RESOLUTION\s*=\s*\d+x(\d+)/i.exec(attributes)?.[1]) || 0;
        variants.push({uri, bandwidth, height});
      }
    }
    return variants.length > 0 ? {variants, renditions, media} : null;
  }

  /**
   * Whether an HLS media playlist has segments FastStream cannot decrypt (DRM, SAMPLE-AES).
   * Keys in force are kept as hls.js keeps them, one per KEYFORMAT until METHOD=NONE.
   * @param {string} text - The playlist.
   * @return {boolean}
   */
  static hlsProtected(text) {
    /** @type {Map<string, string>} */
    const keys = new Map();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('#EXT-X-KEY:')) {
        const attributes = StreamLength.hlsAttributes(line.slice('#EXT-X-KEY:'.length));
        if (attributes.METHOD === 'NONE') {
          keys.clear();
        } else if (attributes.METHOD) {
          keys.set(attributes.KEYFORMAT || 'identity', attributes.METHOD);
        }
      } else if (keys.size > 0 && line !== '' && (!line.startsWith('#') || line.startsWith('#EXT-X-MAP:')) &&
          !isDecryptable(keys.get('identity'), 'identity')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether every video adaptation set (else every set) has ContentProtection: FastStream has
   * no key system, and a clear set beside them plays.
   * @param {string} text - The MPD.
   * @return {boolean}
   */
  static dashProtected(text) {
    // Tags are found one after the other, from where the last ended: no pattern may scan to
    // the end of the text from every tag.
    const open = /<(?:[\w-]+:)?AdaptationSet\b/g;
    const close = /<\/(?:[\w-]+:)?AdaptationSet\s*>/g;
    /** @type {Array<{video: boolean, protected: boolean}>} */
    const sets = [];
    while (open.exec(text)) {
      const end = text.indexOf('>', open.lastIndex);
      if (end === -1) {
        break;
      }
      close.lastIndex = end + 1;
      const closing = close.exec(text);
      if (!closing) {
        break;
      }
      const attributes = text.slice(open.lastIndex, end);
      const inner = text.slice(end + 1, closing.index);
      sets.push({
        video: /\bcontentType\s*=\s*["']video["']|\bmimeType\s*=\s*["']video\/|\bwidth\s*=/i.test(attributes + inner),
        protected: /<(?:[\w-]+:)?ContentProtection\b/.test(inner),
      });
      open.lastIndex = close.lastIndex;
    }
    const videos = sets.filter((set) => set.video);
    const judged = videos.length > 0 ? videos : sets;
    return judged.length > 0 && judged.every((set) => set.protected);
  }

  /**
   * RFC 8216 4.2; a quoted value may hold commas (a key's data: URI).
   * @param {string} text - What follows the tag's colon.
   * @return {Object<string, string>} The values by name, quotes taken off.
   */
  static hlsAttributes(text) {
    /** @type {Object<string, string>} */
    const attributes = {};
    // The lookbehind reads a name from its first character only: no backtracking on long runs.
    for (const match of text.matchAll(/(?<![A-Za-z0-9-])([A-Za-z0-9-]+)\s*=\s*("[^"]*"|[^,]*)/g)) {
      attributes[match[1].toUpperCase()] = match[2].trim().replace(/^"(.*)"$/, '$1');
    }
    return attributes;
  }

  /**
   * @param {string} text - The MPD.
   * @return {number|null} Its length in seconds (Infinity for a live one), or null.
   */
  static fromDash(text) {
    // Each tag's end is looked for once (indexOf), as in dashProtected.
    const mpd = /<(?:[\w-]+:)?MPD\b/.exec(text);
    const mpdEnd = mpd ? text.indexOf('>', mpd.index + mpd[0].length) : -1;
    if (!mpd || mpdEnd === -1) {
      return null;
    }

    const attributes = StreamLength.attributes(text.slice(mpd.index + mpd[0].length, mpdEnd));
    if ((attributes.type || '').toLowerCase() === 'dynamic') {
      return Infinity;
    }

    const total = StreamLength.parseIsoDuration(attributes.mediaPresentationDuration);
    if (total) {
      return total;
    }

    let sum = 0;
    let count = 0;
    const periodTag = /<(?:[\w-]+:)?Period\b/g;
    while (periodTag.exec(text)) {
      const end = text.indexOf('>', periodTag.lastIndex);
      if (end === -1) {
        break;
      }
      const period = StreamLength.parseIsoDuration(StreamLength.attributes(text.slice(periodTag.lastIndex, end)).duration);
      if (!period) {
        return null;
      }
      sum += period;
      count++;
      periodTag.lastIndex = end + 1;
    }
    return count > 0 ? sum : null;
  }

  /**
   * @param {Uint8Array} bytes - Bytes of the file, from offset on.
   * @param {number} [offset=0] - Where in the file the bytes start; a top-level MP4 box
   *   starts there.
   * @param {boolean} [ended=false] - Whether the file ends where the bytes do.
   * @return {{duration: number}|{next: number}|null} The length in seconds; or, for an MP4
   *   whose movie header lies further on, the file offset to read next; or null.
   */
  static fromFile(bytes, offset = 0, ended = false) {
    const first = offset === 0 && bytes.length >= 4 ?
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) : null;
    if (first === EBML_MAGIC) {
      const duration = StreamLength.fromWebm(bytes, ended);
      return duration ? {duration} : null;
    }
    // A WebM media segment: a Cluster with no EBML header.
    if (first === EBML_CLUSTER) {
      return {duration: PIECE_LENGTH};
    }
    return StreamLength.fromMp4(bytes, offset, ended);
  }

  /**
   * moov > mvhd, or for a fragmented file moov > mvex > mehd.
   * @param {Uint8Array} bytes
   * @param {number} [offset=0]
   * @param {boolean} [ended=false]
   * @return {{duration: number}|{next: number}|null} See fromFile.
   */
  static fromMp4(bytes, offset = 0, ended = false) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;
    // Media data before this point; a later read comes after skipped boxes, mdat most often.
    let media = offset > 0;
    while (pos + 8 <= bytes.length) {
      let size = view.getUint32(pos);
      const type = StreamLength.fourCC(bytes, pos + 4);
      let header = 8;
      if (size === 1) {
        if (pos + 16 > bytes.length) {
          break;
        }
        size = Number(view.getBigUint64(pos + 8));
        header = 16;
      } else if (size === 0) {
        size = Infinity;
      }

      if (size < header || !/^[\x20-\x7e]{4}$/.test(type) ||
          (offset === 0 && pos === 0 && !MP4_FIRST_BOXES.includes(type))) {
        return null;
      }

      // Fragments with no movie header before them: a media segment.
      if (type === 'moof') {
        return {duration: PIECE_LENGTH};
      }

      if (type === 'moov') {
        const end = Math.min(bytes.length, pos + size);
        const moov = bytes.subarray(pos + header, end);
        // An init segment is all its file holds; a whole fragmented file has fragments after it.
        if (ended && !media && pos + size === bytes.length && StreamLength.isFragmented(moov)) {
          return {duration: PIECE_LENGTH};
        }
        const duration = StreamLength.movieLength(moov);
        if (duration) {
          return {duration};
        }
        // Too little of the moov came to hold the header: read again from its start.
        if (pos > 0 && end - pos < header + MVHD_MAX_BYTES && end < pos + size) {
          return {next: offset + pos};
        }
        return null;
      }

      if (size === Infinity) {
        return null;
      }
      if (type === 'mdat') {
        media = true;
      }
      pos += size;
    }
    return {next: offset + pos};
  }

  /**
   * @param {Uint8Array} moov - The box's contents, after its header.
   * @return {boolean}
   */
  static isFragmented(moov) {
    let fragmented = false;
    StreamLength.forEachBox(moov, (type) => {
      if (type === 'mvex') {
        fragmented = true;
      }
    });
    return fragmented;
  }

  /**
   * @param {Uint8Array} moov - The box's contents, after its header.
   * @return {number|null} Seconds, or null.
   */
  static movieLength(moov) {
    let timescale = 0;
    let duration = 0;
    let fragmented = 0;
    StreamLength.forEachBox(moov, (type, box) => {
      const view = new DataView(box.buffer, box.byteOffset, box.byteLength);
      if (type === 'mvhd') {
        if (box[8] === 1 && box.length >= 40) {
          timescale = view.getUint32(28);
          duration = StreamLength.readLength(view, 32, 8);
        } else if (box[8] === 0 && box.length >= 28) {
          timescale = view.getUint32(20);
          duration = StreamLength.readLength(view, 24, 4);
        }
      } else if (type === 'mvex') {
        StreamLength.forEachBox(box.subarray(8), (childType, child) => {
          if (childType !== 'mehd') {
            return;
          }
          const childView = new DataView(child.buffer, child.byteOffset, child.byteLength);
          if (child[8] === 1 && child.length >= 20) {
            fragmented = StreamLength.readLength(childView, 12, 8);
          } else if (child[8] === 0 && child.length >= 16) {
            fragmented = StreamLength.readLength(childView, 12, 4);
          }
        });
      }
    });

    // A fragmented file's mvhd says 0 and leaves the length to mehd.
    const units = duration || fragmented;
    return timescale > 0 && units > 0 ? units / timescale : null;
  }

  /**
   * From Segment > Info.
   * @param {Uint8Array} bytes - The start of the file.
   * @param {boolean} [ended=false] - Whether the file ends where the bytes do.
   * @return {number|null} Seconds (PIECE_LENGTH for an init segment), or null.
   */
  static fromWebm(bytes, ended = false) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;

    /**
     * @param {boolean} keepMarker
     */
    const readVint = (keepMarker) => {
      if (pos >= bytes.length) {
        return null;
      }
      const first = bytes[pos];
      let length = 1;
      while (length <= 8 && !(first & (0x80 >> (length - 1)))) {
        length++;
      }
      if (length > 8 || pos + length > bytes.length) {
        return null;
      }
      let value = keepMarker ? first : first & (0xFF >> length);
      for (let i = 1; i < length; i++) {
        value = value * 256 + bytes[pos + i];
      }
      pos += length;
      // An unknown size, all ones, reads as one past the end of anything read here.
      return value;
    };

    if (readVint(true) !== EBML_MAGIC) {
      return null;
    }
    const headerSize = readVint(false);
    if (headerSize === null) {
      return null;
    }
    pos += headerSize;
    if (readVint(true) !== EBML_SEGMENT || readVint(false) === null) {
      return null;
    }

    /** @type {number|null} */
    let seconds = null;
    let tracks = false;
    let media = false;
    while (pos < bytes.length) {
      const id = readVint(true);
      const size = readVint(false);
      if (id === null || size === null) {
        break;
      }
      const next = pos + size;
      if (id === EBML_INFO && seconds === null) {
        const end = Math.min(bytes.length, next);
        let scale = 1000000;
        let duration = 0;
        while (pos < end) {
          const childId = readVint(true);
          const childSize = readVint(false);
          if (childId === null || childSize === null || pos + childSize > end) {
            break;
          }
          if (childId === EBML_TIMECODE_SCALE && childSize >= 1 && childSize <= 8) {
            scale = 0;
            for (let i = 0; i < childSize; i++) {
              scale = scale * 256 + bytes[pos + i];
            }
          } else if (childId === EBML_DURATION && (childSize === 4 || childSize === 8)) {
            duration = childSize === 4 ? view.getFloat32(pos) : view.getFloat64(pos);
          }
          pos += childSize;
        }
        seconds = duration * scale / 1e9;
      } else if (id === EBML_TRACKS) {
        tracks = true;
      } else if (id === EBML_CLUSTER) {
        media = true;
      }
      pos = next;
    }

    // An init segment: Tracks and no Cluster, whatever its Info says.
    if (ended && tracks && !media) {
      return PIECE_LENGTH;
    }
    return seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  /**
   * ISO 8601, as MPDs write it (PT1H23M45.6S).
   * @param {string|undefined} value
   * @return {number|null} Seconds, or null for none or a malformed one.
   */
  static parseIsoDuration(value) {
    const match = /^\s*P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?\s*$/i.exec(value || '');
    if (!match) {
      return null;
    }
    const [years, months, weeks, days, hours, minutes, seconds] = match.slice(1).map((part) => parseFloat(part) || 0);
    const total = ((((years * 365 + months * 30 + weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60) + seconds;
    return total > 0 ? total : null;
  }

  /**
   * The longest, and those that tie with it; stills only when they are all there is.
   * @template {{duration?: number|null}} T
   * @param {T[]} sources - Each with its length in seconds, when known.
   * @return {T[]} In the order they came.
   */
  static longest(sources) {
    const videos = StreamLength.withoutStills(sources);
    const from = videos.length > 0 ? videos : sources;
    const lengths = from.map((source) => StreamLength.rankLength(source.duration));
    const best = Math.max(...lengths);
    return from.filter((source, i) => lengths[i] >= best * TIE_SHARE);
  }

  /**
   * @template {{duration?: number|null}} T
   * @param {T[]} sources
   * @return {T[]}
   */
  static withoutStills(sources) {
    return sources.filter((source) => source.duration !== STILLS_LENGTH);
  }

  /**
   * @param {number|null|undefined} duration - Seconds, when known.
   * @return {number} Seconds.
   */
  static rankLength(duration) {
    if (duration === PIECE_LENGTH || duration === STILLS_LENGTH) {
      return 0;
    }
    return typeof duration === 'number' && duration > 0 ? duration : UNKNOWN_LENGTH_S;
  }

  /**
   * @param {string} text - What follows an XML tag's name.
   * @return {Object<string, string>}
   */
  static attributes(text) {
    /** @type {Object<string, string>} */
    const attributes = {};
    // The lookbehind avoids backtracking, as in hlsAttributes.
    for (const match of text.matchAll(/(?<![\w:.-])([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)) {
      attributes[match[1]] = match[3];
    }
    return attributes;
  }

  /**
   * The last box is cut short where the bytes end.
   * @param {Uint8Array} bytes
   * @param {(type: string, box: Uint8Array) => void} callback - The box's bytes include its header.
   */
  static forEachBox(bytes, callback) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;
    while (pos + 8 <= bytes.length) {
      const size = view.getUint32(pos);
      if (size < 8) {
        return;
      }
      callback(StreamLength.fourCC(bytes, pos + 4), bytes.subarray(pos, Math.min(bytes.length, pos + size)));
      pos += size;
    }
  }

  /**
   * 0 for the all-ones "unknown".
   * @param {DataView} view
   * @param {number} pos
   * @param {number} size - 4 or 8.
   * @return {number}
   */
  static readLength(view, pos, size) {
    if (size === 4) {
      const value = view.getUint32(pos);
      return value === 0xFFFFFFFF ? 0 : value;
    }
    const value = view.getBigUint64(pos);
    return value === 0xFFFFFFFFFFFFFFFFn ? 0 : Number(value);
  }

  /**
   * @param {Uint8Array} bytes
   * @param {number} pos
   * @return {string}
   */
  static fourCC(bytes, pos) {
    return String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
  }
}
