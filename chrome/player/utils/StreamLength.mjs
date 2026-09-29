// @ts-check

/**
 * How long a stream plays, read from its manifest or from the start of its file, and the
 * rule that picks among a page's streams by it: an ad or an intro runs for seconds, the
 * video the page is about for minutes or hours.
 *
 * Pure: the background reads the bytes (background/StreamLengths.mjs), the player and the
 * background's MPV picks rank by what they tell.
 */

// A stream whose length could not be read ranks as this long: above a known-short one (an
// ad, an intro), below a known film or episode. A length is unknown when the server turned
// the read away, or the file keeps it where a few reads do not reach.
export const UNKNOWN_LENGTH_S = 10 * 60;

// The length of a piece of a stream: an HLS or DASH init or media segment, which plays
// nothing by itself. It ranks below every stream, so a page's manifest is kept over its own
// pieces; read as unknown, they outranked the manifest of any title under 9 minutes.
export const PIECE_LENGTH = -1;

// Streams at least this share of the longest one's length tie with it, and the caller's
// own rule chooses among them: the same video in two formats differs by a second or two,
// two episodes by a few minutes, an ad and the video by far more.
const TIE_SHARE = 0.9;

// The boxes an MP4 file can start with, a media segment's among them (sidx, emsg, prft,
// moof).
const MP4_FIRST_BOXES = ['ftyp', 'styp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pdin', 'uuid',
  'sidx', 'emsg', 'prft', 'moof'];

// The most an mvhd box takes, version 1: enough of a moov to read its length from.
const MVHD_MAX_BYTES = 120;

const EBML_MAGIC = 0x1A45DFA3;
const EBML_SEGMENT = 0x18538067;
const EBML_INFO = 0x1549A966;
const EBML_TIMECODE_SCALE = 0x2AD7B1;
const EBML_DURATION = 0x4489;

export class StreamLength {
  /**
   * Reads an HLS playlist.
   * @param {string} text - The playlist.
   * @return {{duration: number}|{variant: string}|null} A media playlist's length in
   *   seconds (Infinity while it is live: no end tag, and not marked VOD); a master
   *   playlist's first variant, as written in it (relative to the playlist's URL); or null
   *   for text that is no playlist, or one that lists nothing.
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
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        // Every variant runs as long as the others: the first one tells.
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
   * Reads a DASH manifest.
   * @param {string} text - The MPD.
   * @return {number|null} Its length in seconds (Infinity for a live one), or null.
   */
  static fromDash(text) {
    const mpd = /<(?:[\w-]+:)?MPD\b([^>]*)>/.exec(text);
    if (!mpd) {
      return null;
    }

    const attributes = StreamLength.attributes(mpd[1]);
    if ((attributes.type || '').toLowerCase() === 'dynamic') {
      return Infinity;
    }

    const total = StreamLength.parseIsoDuration(attributes.mediaPresentationDuration);
    if (total) {
      return total;
    }

    // No total: the periods', when each one has its own.
    let sum = 0;
    let count = 0;
    for (const match of text.matchAll(/<(?:[\w-]+:)?Period\b([^>]*)>/g)) {
      const period = StreamLength.parseIsoDuration(StreamLength.attributes(match[1]).duration);
      if (!period) {
        return null;
      }
      sum += period;
      count++;
    }
    return count > 0 ? sum : null;
  }

  /**
   * Reads an MP4 or WebM file's length from the bytes at its start.
   * @param {Uint8Array} bytes - Bytes of the file, from offset on.
   * @param {number} [offset=0] - Where in the file the bytes start. A top-level MP4 box
   *   starts there.
   * @param {boolean} [ended=false] - Whether the file ends where the bytes do.
   * @return {{duration: number}|{next: number}|null} The length in seconds (PIECE_LENGTH
   *   for a piece of a stream); or, for an MP4 whose movie header lies further on (after
   *   its media data, most often), the file offset to read from next; or null for bytes
   *   that are neither, or tell no length.
   */
  static fromFile(bytes, offset = 0, ended = false) {
    if (offset === 0 && bytes.length >= 4 &&
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) === EBML_MAGIC) {
      const duration = StreamLength.fromWebm(bytes);
      return duration ? {duration} : null;
    }
    return StreamLength.fromMp4(bytes, offset, ended);
  }

  /**
   * Reads an MP4 file's length from its movie header: moov > mvhd, or for a fragmented
   * file moov > mvex > mehd.
   * @param {Uint8Array} bytes - Bytes of the file, from offset on.
   * @param {number} [offset=0] - Where in the file the bytes start; a top-level box starts
   *   there.
   * @param {boolean} [ended=false] - Whether the file ends where the bytes do.
   * @return {{duration: number}|{next: number}|null} See fromFile.
   */
  static fromMp4(bytes, offset = 0, ended = false) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;
    // Whether the file holds media data before this point: then it plays some itself. A
    // later read comes after boxes it skipped, media data most often.
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
        // The box runs to the end of the file.
        size = Infinity;
      }

      if (size < header || !/^[\x20-\x7e]{4}$/.test(type) ||
          (offset === 0 && pos === 0 && !MP4_FIRST_BOXES.includes(type))) {
        return null;
      }

      // A media segment: fragments, and no movie header before them. That is the stream's
      // init segment, a file of its own.
      if (type === 'moof') {
        return {duration: PIECE_LENGTH};
      }

      if (type === 'moov') {
        const end = Math.min(bytes.length, pos + size);
        const moov = bytes.subarray(pos + header, end);
        // An init segment: the movie header of fragments that come as files of their own,
        // and all the file holds. A whole fragmented file has its fragments after it.
        if (ended && !media && pos + size === bytes.length && StreamLength.isFragmented(moov)) {
          return {duration: PIECE_LENGTH};
        }
        const duration = StreamLength.movieLength(moov);
        if (duration) {
          return {duration};
        }
        // Only the start of the moov came, too little of it to hold the header: read it
        // again from where it starts.
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
   * Whether a moov box's movie comes in fragments: it has an mvex box.
   * @param {Uint8Array} moov - The box's contents, after its header.
   * @return {boolean} Whether it does.
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
   * The length a moov box's children tell.
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
        // After the header: version, flags, then the times, 8 bytes each in version 1.
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
   * Reads a WebM (Matroska) file's length from its Segment > Info.
   * @param {Uint8Array} bytes - The start of the file.
   * @return {number|null} Seconds, or null.
   */
  static fromWebm(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;

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

    while (pos < bytes.length) {
      const id = readVint(true);
      const size = readVint(false);
      if (id === null || size === null) {
        return null;
      }
      if (id !== EBML_INFO) {
        pos += size;
        continue;
      }

      const end = Math.min(bytes.length, pos + size);
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
      const seconds = duration * scale / 1e9;
      return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    }
    return null;
  }

  /**
   * Parses an ISO 8601 duration, as MPDs write theirs (PT1H23M45.6S).
   * @param {string|undefined} value - The duration.
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
   * The streams to choose from: the longest, and those that tie with it. A stream of
   * unknown length ranks as UNKNOWN_LENGTH_S long, a piece of one (PIECE_LENGTH) as 0.
   * @template {{duration?: number|null}} T
   * @param {T[]} sources - Detected sources, each with its length in seconds, when known.
   * @return {T[]} Those of them, in the order they came.
   */
  static longest(sources) {
    const lengths = sources.map((source) => StreamLength.rankLength(source.duration));
    const best = Math.max(...lengths);
    return sources.filter((source, i) => lengths[i] >= best * TIE_SHARE);
  }

  /**
   * The length a stream ranks by.
   * @param {number|null|undefined} duration - Its length in seconds, when known.
   * @return {number} Seconds.
   */
  static rankLength(duration) {
    if (duration === PIECE_LENGTH) {
      return 0;
    }
    return typeof duration === 'number' && duration > 0 ? duration : UNKNOWN_LENGTH_S;
  }

  /**
   * An XML tag's attributes.
   * @param {string} text - What follows the tag's name.
   * @return {Object<string, string>} By name.
   */
  static attributes(text) {
    /** @type {Object<string, string>} */
    const attributes = {};
    for (const match of text.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)) {
      attributes[match[1]] = match[3];
    }
    return attributes;
  }

  /**
   * Calls back for each box in bytes, cut short where the bytes end.
   * @param {Uint8Array} bytes - Boxes, one after another.
   * @param {(type: string, box: Uint8Array) => void} callback - Its type, and its bytes,
   *   header included.
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
   * A length field of 4 or 8 bytes, 0 for the all-ones "unknown".
   * @param {DataView} view - Where it is.
   * @param {number} pos - Where it starts.
   * @param {number} size - 4 or 8.
   * @return {number} Its value.
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
   * @param {Uint8Array} bytes - Bytes.
   * @param {number} pos - Where the four-character code starts.
   * @return {string} It.
   */
  static fourCC(bytes, pos) {
    return String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
  }
}
