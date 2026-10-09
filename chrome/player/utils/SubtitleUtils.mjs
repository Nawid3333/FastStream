// A SubRip timestamp line: `00:00:01,000 --> 00:00:02,000`, also with '.' before the
// milliseconds, short or missing milliseconds, and one-digit minutes and seconds. It is only
// tried where a run of digits starts: from inside a long line of digits, (\d+): failed again
// for every digit of it (quadratic), and can match nothing the run's start does not.
const SRT_TIMESTAMP = /(?<!\d)(\d+):(\d{1,2}):(\d{1,2})(?:[,.](\d+))?\s*--?>\s*(\d+):(\d{1,2}):(\d{1,2})(?:[,.](\d+))?/;
// The same at the start of a line, which is where a cue's timestamp is.
const SRT_CUE_START = new RegExp('^\\s*' + SRT_TIMESTAMP.source);

/**
 * Utility functions for subtitle parsing and conversion.
 */
export class SubtitleUtils {
  /**
   * Reads a subtitle file's bytes as text, as the browser did (a byte order mark first, then
   * a charset the server declared), except that bytes that are no UTF-8 are read as
   * Windows-1252: most older SubRip files from Western Europe are, and read as UTF-8 every
   * accented letter in them showed as U+FFFD. Every place that reads a subtitle file's bytes
   * uses this; content.js, which cannot import it, carries a copy a test keeps the same.
   * @param {ArrayBuffer|ArrayBufferView} data - The file's bytes.
   * @param {?string} [contentType] - The Content-Type it came with over HTTP, if any.
   * @return {string} The file's text.
   */
  static decodeSubtitleBytes(data, contentType) {
    const bytes = ArrayBuffer.isView(data) ?
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data || 0);
    // A byte order mark says what the file is, before anything a server says.
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes);
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return new TextDecoder('utf-16le').decode(bytes);
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return new TextDecoder('utf-16be').decode(bytes);
    }
    // A charset the server declared, unless it is UTF-8: a file a server calls UTF-8 often
    // is not, and is then read like one that came with no charset.
    const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType || '');
    if (charset) {
      try {
        const decoder = new TextDecoder(charset[1]);
        if (decoder.encoding !== 'utf-8') {
          return decoder.decode(bytes);
        }
      } catch (e) {
        // A charset no browser knows: as if none was given.
      }
    }
    try {
      return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch (e) {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }

  /**
   * Translates XML entities in a string to their corresponding characters.
   * @param {string} str - The input string.
   * @return {string} The translated string.
   */
  static translateXMLEntities(str) {
    const entitiesList = {
      '&amp;': '&',
      '&gt;': '>',
      '&lt;': '<',
      '&quot;': '"',
      '&apos;': '\'',
    };

    const entitySplit = str.split(/(&[#a-zA-Z0-9]+;)/);
    if (entitySplit.length <= 1) { // No entities. Skip the rest of the function.
      return str;
    }

    for (let i = 1; i < entitySplit.length; i += 2) {
      const reference = entitySplit[i];
      if (reference.charAt(1) === '#') {
        let code;
        if (reference.charAt(2) === 'x') { // Hexadecimal
          code = parseInt(reference.substring(3, reference.length - 1), 16);
        } else { // Decimal
          code = parseInt(reference.substring(2, reference.length - 1), 10);
        }

        // Translate into string according to ISO/IEC 10646. A surrogate code point is no
        // character: U+FFFD, as in HTML. Left a lone surrogate, it made the WebVTT parser
        // throw "URI malformed" and the whole track failed.
        if (!isNaN(code) && code >= 0 && code <= 0x10FFFF) {
          entitySplit[i] = code >= 0xD800 && code <= 0xDFFF ? String.fromCharCode(0xFFFD) : String.fromCodePoint(code);
        }
      } else if (entitiesList.hasOwnProperty(reference)) {
        entitySplit[i] = entitiesList[reference];
      }
    }

    return entitySplit.join('');
  }

  /**
   * Converts SRT subtitle format to WebVTT format.
   * @param {string} data - SRT subtitle data.
   * @return {string} WebVTT subtitle data.
   */
  static srt2webvtt(data) {
<<<<<<< HEAD
    // remove dos newlines; in a file with no line feed at all (a classic Mac one) the
    // carriage returns are the line ends, and removing them left no cue
    let srt = data.includes('\n') ? data.replace(/\r+/g, '') : data.replace(/\r/g, '\n');
    // trim white space start and end (/^\s+|\s+$/g, which trims the same, was quadratic in
    // a long run of spaces inside the file)
    srt = srt.trim();
    // get cues: a cue ends at a blank line, however many follow it, and a cue also starts
    // at its own timestamp when no blank line comes before it. So a line of spaces ends
    // the cue before a timestamp, and inside a cue it is text, as ffmpeg and VLC read it:
    // splitting at it too lost the text below it.
=======
    // remove dos newlines
    let srt = data.replace(/\r+/g, '');
    // trim white space start and end
    srt = srt.replace(/^\s+|\s+$/g, '');
    // get cues: split at blank lines, and at a timestamp line with no blank line before it
>>>>>>> upstream/main
    const cuelist = srt.split(/\n\n+/).flatMap((block) => this.splitAtCueStarts(block));
    let result = '';
    if (cuelist.length > 0) {
      result += 'WEBVTT\n\n';
      for (let i = 0; i < cuelist.length; i = i + 1) {
        result += this.convertSrtCue(cuelist[i]);
      }
    }
    return result;
  }

  /**
   * Converts XML subtitle data to WebVTT format.
   * @param {string} data - XML subtitle data.
   * @return {string} WebVTT subtitle data.
   */
  static xml2vtt(data) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(data, 'text/xml');
    const cues = xml.getElementsByTagName('text');
    const result = ['WEBVTT'];
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      const start = parseFloat(cue.getAttribute('start'));
      const dur = parseFloat(cue.getAttribute('dur'));
      const end = start + dur;
      const text = this.translateXMLEntities(cue.textContent);
      result.push((i + 1) + '\n' + this.vttTimeFormat(start) + ' --> ' + this.vttTimeFormat(end) + '\n' + text);
    }
    return result.join('\n\n');
  }

  /**
   * Formats a time in seconds as HH:MM:SS plus milliseconds, rounded to the nearest
   * millisecond. Flooring instead turned float error such as 1.2999999999999998 (a cue
   * shifted by 0.1 s three times) into 1.299.
   * @param {number} sec - Time in seconds; a negative time is written as zero.
   * @param {string} separator - What goes between the seconds and the milliseconds.
   * @return {string} The time string.
   */
  static formatTimestamp(sec, separator) {
    const total = Math.max(0, Math.round(sec * 1000));
    const pad = (n, width) => String(n).padStart(width, '0');
    const seconds = Math.floor(total / 1000);
    return pad(Math.floor(seconds / 3600), 2) + ':' + pad(Math.floor(seconds / 60) % 60, 2) + ':' +
      pad(seconds % 60, 2) + separator + pad(total % 1000, 3);
  }

  /**
   * Formats a time value in seconds to WebVTT time format.
   * @param {number} sec - Time in seconds.
   * @return {string} WebVTT time string (HH:MM:SS.mmm).
   */
  static vttTimeFormat(sec) {
    return this.formatTimestamp(sec, '.');
  }

  /**
   * Formats a time value in seconds to SRT time format.
   * @param {number} sec - Time in seconds.
   * @return {string} SRT time string (HH:MM:SS,mmm).
   */
  static srtTimeFormat(sec) {
    return this.formatTimestamp(sec, ',');
  }

  /**
   * Converts an array of cues to SRT subtitle format.
   * @param {Array} cues - Array of cues.
   * @return {string} SRT subtitle data.
   */
  static cuesToSrt(cues) {
    const result = [];
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      const start = this.srtTimeFormat(cue.startTime);
      const end = this.srtTimeFormat(cue.endTime);
      const text = cue.text;
      result.push((i + 1) + '\n' + start + ' --> ' + end + '\n' + text);
    }
    return result.join('\n\n');
  }

  /**
   * The cues on screen at a time. A track's cues are sorted by start time only, so a long
   * cue (a sign, a song) stays on screen behind later, shorter ones; looking back from the
   * last cue that started only as far as the first one already over lost it. Every cue is
   * checked, which also holds when an edit or shift left the track out of order. It runs
   * on each time update (a few times a second); measured in Node, 1,500 cues (a film) take
   * about 0.002 ms, 10,000 about 0.01 ms.
   * @param {Array<{startTime: number, endTime: number}>} cues - The track's cues.
   * @param {number} time - The time, in seconds.
   * @return {Array} The cues that start at or before the time and end at or after it, in
   *   the track's order.
   */
  static cuesAt(cues, time) {
    const onScreen = [];
    for (let i = 0; i < cues.length; i++) {
      if (cues[i].startTime <= time && cues[i].endTime >= time) {
        onScreen.push(cues[i]);
      }
    }
    return onScreen;
  }

  /**
   * Whether a download link from the OpenSubtitles API may be fetched. The player fetches
   * it with the extension's host permissions, so only an https link on OpenSubtitles' own
   * hosts is (they look like https://www.opensubtitles.com/download/.../subfile/name.srt),
   * not whatever a hostile or intercepted answer names.
   * @param {*} link - The link from the API's answer.
   * @return {boolean}
   */
  static isOpenSubtitlesDownloadLink(link) {
    let url;
    try {
      url = new URL(link);
    } catch (e) {
      return false;
    }
    return url.protocol === 'https:' && /(^|\.)opensubtitles\.(com|org)$/.test(url.hostname);
  }

  /**
   * Converts one SubRip timestamp to WebVTT's HH:MM:SS.mmm, which is all the WebVTT parser
   * accepts. SubRip files write the milliseconds after a comma or a full stop, sometimes
   * with fewer than three digits (read as a number of milliseconds, as ffmpeg and VLC read
   * them) and sometimes not at all.
   * @param {string} hours - The hours, as written.
   * @param {string} minutes - The minutes, as written.
   * @param {string} seconds - The seconds, as written.
   * @param {string} [millis] - The milliseconds, as written, if any.
   * @return {string} The WebVTT timestamp.
   */
  static srtTimestampToVtt(hours, minutes, seconds, millis) {
    let ms = millis || '0';
    ms = ms.length > 3 ? ms.substring(0, 3) : ms.padStart(3, '0');
    return hours + ':' + minutes.padStart(2, '0') + ':' + seconds.padStart(2, '0') + '.' + ms;
  }

  /**
   * Splits a block of SubRip text at every cue that starts inside it. A cue starts at its
   * timestamp line, or at the sequence number just before it, and ffmpeg (so mpv) starts a
   * new cue there even with no blank line before it. Files that leave the blank line out, or
   * write a non-breaking space on it, lost the next cue: its timestamp became a line of the
   * previous cue's text. A line of invisible whitespace left at the end of a cue by such a
   * separator is dropped; inside a cue it is kept, as ffmpeg keeps it.
   * @param {string} block - SubRip text with no blank line in it.
   * @return {string[]} One block per cue, in order.
   */
  static splitAtCueStarts(block) {
    const lines = block.split('\n');
    const cues = [];
    const push = (from, to) => {
      const cue = lines.slice(from, to);
      while (cue.length > 0 && cue[cue.length - 1].trim() === '') {
        cue.pop();
      }
      if (cue.length > 0) {
        cues.push(cue.join('\n'));
      }
    };

    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!SRT_CUE_START.test(lines[i])) {
        continue;
      }
      const cueStart = i > start && /^\d+$/.test(lines[i - 1].trim()) ? i - 1 : i;
      if (cueStart > start) {
        push(start, cueStart);
        start = cueStart;
      }
    }
    push(start, lines.length);
    return cues;
  }

  /**
   * Converts a single SRT caption to a formatted string.
   * @param {Object} caption - SRT caption object.
   * @return {string} Formatted caption string.
   */
  static convertSrtCue(caption) {
    // remove all html tags for security reasons
    // srt = srt.replace(/<[a-zA-Z\/][^>]*>/g, '');
    const lines = caption.split(/\n/);
    if (lines.length < 2) {
      // file format error or comment lines
      return '';
    }
<<<<<<< HEAD

    // The timestamp line comes first, or second after a sequence-number line.
    const timestamp = SRT_TIMESTAMP;
    let line = 0;
    let cue = '';
    if (!timestamp.test(lines[0]) && timestamp.test(lines[1])) {
      // A WebVTT cue identifier is optional, so a sequence line with nothing usable in it
      // is left out rather than written as the word "null".
      const identifier = lines[0].match(/\w+/);
      if (identifier) {
        cue += identifier[0] + '\n';
=======
    let line = 0;
    // detect identifier
    if (!s[0].match(/\d+:\d+:\d+/) && s[1].match(/\d+:\d+:\d+/)) {
      cue += s[0].match(/\w+/) + '\n';
      line += 1;
    }
    // a time string may mark its milliseconds with '.', as WebVTT does: read it as ','
    s[line] = s[line].replace(/(\d+:\d+:\d+)\.(\d+)/g, '$1,$2');
    // get time strings
    if (s[line].match(/\d+:\d+:\d+/)) {
      // convert time string
      const m = s[line].match(/(\d+):(\d+):(\d+)(?:,(\d+))?\s*--?>\s*(\d+):(\d+):(\d+)(?:,(\d+))?/);
      if (m) {
        // vtt.js needs three millisecond digits; short ones are a number (,5 is 5 ms, as
        // ffmpeg and VLC read them) and missing ones are zero
        cue += m[1] + ':' + m[2] + ':' + m[3] + '.' + (m[4] || '').padStart(3, '0') + ' --> ' +
                    m[5] + ':' + m[6] + ':' + m[7] + '.' + (m[8] || '').padStart(3, '0') + '\n';
        line += 1;
      } else {
        // Unrecognized timestring
        return '';
>>>>>>> upstream/main
      }
      line = 1;
    }

    const m = lines[line].match(timestamp);
    if (!m) {
      // file format error or comment lines
      return '';
    }
<<<<<<< HEAD
    cue += this.srtTimestampToVtt(m[1], m[2], m[3], m[4]) + ' --> ' +
      this.srtTimestampToVtt(m[5], m[6], m[7], m[8]) + '\n';

    // Everything after the timestamp is the cue text, however many lines it has.
    const cueText = lines.slice(line + 1).join('\n');
    if (cueText) {
      // A <br> tag ends at a '>', so the text after the last '>' holds none. Searching it
      // too ran [^>]* to the end of the text from every "<br" there: quadratic.
      const end = cueText.lastIndexOf('>') + 1;
      cue += cueText.substring(0, end).replace(/<\s*\/?\s*br\b[^>]*>/gi, '\n') + cueText.substring(end);
    }
    return cue + '\n\n';
=======
    // get cue text: every line after the time string. A cue with no text is left out,
    // since convertCueToDOMTree() returns null for it.
    const cueText = s.slice(line).join('\n');
    if (!cueText) {
      return '';
    }
    return cue + cueText.replace(/<\s*\/?\s*br\b[^>]*>/gi, '\n') + '\n\n';
  }

  /**
   * Splits SRT text at every timestamp line (with the sequence number before it),
   * since a cue can start without a blank line before it.
   * @param {string} block - SRT text with no blank lines.
   * @return {string[]} One block per cue.
   */
  static splitAtCueStarts(block) {
    const lines = block.split('\n');
    const cues = [];
    const push = (from, to) => {
      const cue = lines.slice(from, to);
      // drop trailing whitespace-only lines, e.g. a separator line holding a (non-breaking) space
      while (cue.length > 0 && cue[cue.length - 1].trim() === '') {
        cue.pop();
      }
      if (cue.length > 0) {
        cues.push(cue.join('\n'));
      }
    };

    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*\d+:\d+:\d+(?:[,.]\d+)?\s*--?>\s*\d+:\d+:\d+/.test(lines[i])) {
        continue;
      }
      const cueStart = i > start && /^\d+$/.test(lines[i - 1].trim()) ? i - 1 : i;
      if (cueStart > start) {
        push(start, cueStart);
        start = cueStart;
      }
    }
    push(start, lines.length);
    return cues;
>>>>>>> upstream/main
  }

  /**
   * Converts subtitle formatting tags to a supported format.
   * @param {string} text - Subtitle text.
   * @return {string} Formatted subtitle text.
   */
  static convertSubtitleFormatting(text) {
    const alignmentSettings = {
      1: 'line:95% position:0% align:start',
      2: 'line:95% position:50% align:center',
      3: 'line:95% position:100% align:end',
      4: 'line:50% position:0% align:start',
      5: 'line:50% position:50% align:center',
      6: 'line:50% position:100% align:end',
      7: 'line:5% position:0% align:start',
      8: 'line:5% position:50% align:center',
      9: 'line:5% position:100% align:end',
    };

    // An alignment tag at the start of a cue's first line, right after its timing line,
    // becomes the cue's settings. One on a later line is stripped below: its settings went
    // onto whatever line came before it, and were shown as text.
    const lines = text.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const tag = /^\{\\?an(\d)\}/i.exec(lines[i]);
      if (!tag || !lines[i - 1].includes('-->')) {
        continue;
      }
      const timing = lines[i - 1].replace(/\r$/, '');
      const settings = alignmentSettings[tag[1]];
      lines[i - 1] = settings ? `${timing} ${settings}` : timing;
      lines[i] = lines[i].substring(tag[0].length);
    }
    const withAlignment = lines.join('\n');

    return withAlignment
        .replace(/\{\\([ibu])1\}/gi, '<$1>') // convert {\b1}, {\i1}, {\u1} to <b>, <i>, <u>
        .replace(/\{\\([ibu])\}/gi, '</$1>') // convert {\b}, {\i}, {\u} to </b>, </i>, </u>
        .replace(/\{([ibu])\}/gi, '<$1>') // convert {b}, {i}, {u} to <b>, <i>, <u>
        .replace(/\{\/([ibu])\}/gi, '</$1>') // convert {/b}, {/i}, {/u} to </b>, </i>, </u>
        .replace(/\{\\?an\d\}/gi, '') // strip any remaining alignment tags
        .replace(/\\h/gi, ' '); // convert hard spaces to regular spaces
  }
}
